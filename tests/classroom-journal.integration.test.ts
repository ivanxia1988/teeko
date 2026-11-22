import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {appendClassroomJournal,ClassroomJournalService} from '../lib/server/classroom-journal';
import {publishTrialCourses} from '../lib/server/course-catalog';
import {AdminError} from '../lib/server/admin-service';

const database=process.env.TEST_DATABASE_URL;
if(database){const url=new URL(database);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/test/.test(url.pathname))throw Error('A loopback disposable test database is required.');}
async function fixture(t:TestContext){
 const maintenance=new Pool({connectionString:database}),schema=`journal_test_${randomUUID().replaceAll('-','')}`;
 await maintenance.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:database,options:`-c search_path=${schema},public`,max:4});
 t.after(async()=>{await pool.end();await maintenance.query(`DROP SCHEMA ${schema} CASCADE`);await maintenance.end();});
 for(const file of ['0001_accounts.sql','0002_classrooms.sql','0003_teacher_agents.sql','0006_classroom_journal.sql','0007_classroom_notes.sql'])await pool.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
 await publishTrialCourses(pool);const admin=randomUUID(),student=randomUUID();
 await pool.query("INSERT INTO teeko_accounts(id,email,password_hash,consent_version,consented_at,created_at)VALUES($1,'operator@internal.invalid','synthetic','internal-admin',now(),now()),($2,'parent@example.test','synthetic','v1',now(),now())",[admin,student]);
 await pool.query('INSERT INTO teeko_admin_accounts(account_id)VALUES($1)',[admin]);
 const version=(await pool.query("SELECT version FROM teeko_courses WHERE id='picnic' ORDER BY published_at DESC LIMIT 1")).rows[0].version;
 const create=async(start='2026-11-01T01:00:00Z',account=student)=>{
  const id=randomUUID();await pool.query(`INSERT INTO teeko_classrooms(id,account_id,course_id,course_version,profile,preferences,status,max_ms,started_at,day_key,ended_at,elapsed_ms,teacher_config)VALUES($1,$2,'picnic',$3,'{"name":"Leo"}','{"provider":"qwen"}','ended',900000,$4,'2026-11-01',$4,12000,$5)`,[id,account,version,new Date(start),JSON.stringify({agentName:'Synthetic teacher',version:1,systemPrompt:'PRIVATE_PROMPT_MARKER',routes:{qwen:{realtime:{model:'qwen3.8-omni-flash-realtime',apiKey:'PRIVATE_KEY_MARKER'}}}})]);return id;
 };
 return{pool,admin,student,create,service:new ClassroomJournalService(pool)};
}
test('classroom journal persists complete bounded events, redacts inputs and paginates without repeats',{skip:!database},async t=>{
 const f=await fixture(t),id=await f.create(),scope={classroomId:id,epoch:1,revision:2,stepIndex:0};
 for(let i=0;i<70;i++)await appendClassroomJournal(f.pool,scope,{eventKey:`utterance:${i}`,kind:'utterance',actor:i%2?'teacher':'child',status:'recorded',name:'speech',text:`Synthetic turn ${i}`,details:{source:'speech'}},new Date(1761958800000+i));
 await appendClassroomJournal(f.pool,scope,{eventKey:'tool:request',kind:'tool',actor:'teacher',status:'requested',name:'highlight_objects',correlationId:'tool-one',details:{objectIds:['apple'],contextKey:`${id}:1:0`,image:'data:image/jpeg;base64,PRIVATE_IMAGE'}} as never);
 await appendClassroomJournal(f.pool,scope,{eventKey:'tool:request',kind:'tool',actor:'teacher',status:'requested',name:'highlight_objects',text:'Duplicate must not overwrite'});
 const list=await f.service.list(f.admin);assert.equal(list.total,1);assert.equal(list.classrooms[0].eventCount,71);assert.equal(list.classrooms[0].model,'qwen3.8-omni-flash-realtime');assert(!JSON.stringify(list).includes('PRIVATE_'));
 const first=await f.service.events(f.admin,id,{limit:40});assert.equal(first.coverage,'journal');assert.equal(first.events.length,40);assert(first.nextCursor);
 const next=await f.service.events(f.admin,id,{after:first.nextCursor,limit:40});assert.equal(next.events.length,31);assert.equal(next.nextCursor,null);assert(!next.events.some(event=>first.events.some(old=>old.id===event.id)));
 const tool=next.events.at(-1)!;assert.deepEqual(tool.details.objectIds,['apple']);assert.equal(tool.correlationId,'tool-one');assert.equal(tool.text,null);assert(!JSON.stringify(tool).includes('PRIVATE_IMAGE'));
});
test('journal filters literal user search and inclusive Shanghai dates and excludes internal accounts',{skip:!database},async t=>{
 const f=await fixture(t);await f.create('2026-10-31T15:59:59Z');await f.create('2026-10-31T16:00:00Z');await f.create('2026-11-01T15:59:59Z');await f.create('2026-11-01T16:00:00Z');await f.create('2026-11-01T01:00:00Z',f.admin);
 const day=await f.service.list(f.admin,{from:'2026-11-01',to:'2026-11-01',query:'Leo'});assert.equal(day.total,2);assert.equal(day.classrooms.length,2);
 assert.equal((await f.service.list(f.admin,{query:'parent@example.test'})).total,4);
 assert.equal((await f.service.list(f.admin,{query:"' OR 1=1 --"})).total,0);assert.equal((await f.service.list(f.admin,{query:'%'})).total,0);
 const page=await f.service.list(f.admin,{page:1,pageSize:3});assert.equal(page.total,4);assert.equal(page.classrooms.length,1);
 await assert.rejects(f.service.list(f.admin,{from:'2026-02-30'}));
});
test('journal access rechecks database roles, preserves large cursors and marks limited legacy history',{skip:!database},async t=>{
 const f=await fixture(t),id=await f.create();
 await f.pool.query("INSERT INTO teeko_classroom_transcripts(classroom_id,connection_epoch,item_id,role,text,step_index,created_at,source)VALUES($1,1,'old-child','child','A synthetic old answer',0,now(),'speech'),($1,1,'old-teacher','teacher','A synthetic old reply',0,now(),'speech')",[id]);
 const legacy=await f.service.events(f.admin,id,{limit:1});assert.equal(legacy.coverage,'legacy_transcripts');assert.equal(legacy.events.length,1);assert(legacy.nextCursor);assert.equal((await f.service.events(f.admin,id,{after:legacy.nextCursor})).events.length,1);
 const empty=await f.create();assert.equal((await f.service.events(f.admin,empty)).coverage,'none');
 await assert.rejects(f.service.events(f.student,id),error=>error instanceof AdminError&&error.status===403);
 await assert.rejects(f.service.events(f.admin,randomUUID()),error=>error instanceof AdminError&&error.status===404);
 await appendClassroomJournal(f.pool,{classroomId:empty,epoch:1,revision:1,stepIndex:0},{eventKey:'one',kind:'connection',actor:'application',status:'confirmed',name:'connected'});
 await f.pool.query('UPDATE teeko_classroom_journal SET id=9007199254740993 WHERE classroom_id=$1',[empty]);
 assert.equal((await f.service.events(f.admin,empty,{after:'9007199254740992'})).events[0].id,'9007199254740993');
 await f.pool.query('DELETE FROM teeko_admin_accounts WHERE account_id=$1',[f.admin]);await assert.rejects(f.service.list(f.admin),error=>error instanceof AdminError&&error.status===403);await assert.rejects(f.service.events(f.admin,id),error=>error instanceof AdminError&&error.status===403);
});
