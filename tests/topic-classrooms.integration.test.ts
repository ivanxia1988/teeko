import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {ClassroomService,DEFAULT_CLASSROOM_PREFERENCES} from '../lib/server/classroom-service';
import {publishTrialCourses} from '../lib/server/course-catalog';
import {loadTopicContent} from '../lib/server/topic-content';
import {TOPIC_CATALOG,topicHistoryResponseSchema} from '../lib/topic-learning';

const database=process.env.TEST_DATABASE_URL;
if(database){const url=new URL(database);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/test/.test(url.pathname))throw new Error('A loopback disposable test database is required.');}
async function fixture(t:TestContext){
 const admin=new Pool({connectionString:database}),schema=`topic_classroom_test_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:database,options:`-c search_path=${schema},public`});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 for(const file of ['0001_accounts.sql','0002_classrooms.sql','0003_teacher_agents.sql','0006_classroom_journal.sql','0007_classroom_notes.sql'])await pool.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
 await publishTrialCourses(pool);
 const owner=randomUUID(),other=randomUUID();
 for(const id of [owner,other]){
  await pool.query("INSERT INTO teeko_accounts(id,email,password_hash,consent_version,consented_at,created_at) VALUES($1,$2,'synthetic','v1',now(),now())",[id,`${id}@example.test`]);
  await pool.query("INSERT INTO teeko_profiles(account_id,name,age_range,level,updated_at) VALUES($1,'Test learner','10–11','unsure',now())",[id]);
 }
 let clock=new Date('2026-11-21T00:00:00Z');
 const service=new ClassroomService(pool,{now:()=>new Date(clock)});
 return{pool,owner,other,service,advance:()=>{clock=new Date(clock.getTime()+1000);}};
}

test('published topic courses are isolated and each new session starts from its first activity',{skip:!database},async t=>{
 const {service,pool,owner,other}=await fixture(t);
 assert.deepEqual((await service.topics()).map(topic=>topic.id),['topic-robot','topic-picnic']);
 assert.deepEqual((await service.courses(owner)).courses.map(course=>course.id),['picnic','robot-reading']);
 const first=await service.create(owner,'topic-robot'),lease=await service.claim(owner,first.id);
 const advanced=await service.action(owner,first.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'next'});assert.equal(advanced.stepIndex,1);
 await assert.rejects(service.action(owner,first.id,{eventId:randomUUID(),expectedRevision:advanced.revision,type:'select',objectIds:['wings']}),{code:'ACTION_UNAVAILABLE'});
 await service.action(owner,first.id,{eventId:randomUUID(),expectedRevision:advanced.revision,type:'end'});
 const next=await service.create(owner,'topic-robot');assert.notEqual(next.id,first.id);assert.equal(next.stepIndex,0);assert.deepEqual(next.outcomes,[]);
 await assert.rejects(service.get(other,first.id),{code:'NOT_FOUND'});
 await service.action(owner,next.id,{eventId:randomUUID(),expectedRevision:next.revision,type:'end'});
 const legacy=await service.create(owner,'picnic'),legacyLease=await service.claim(owner,legacy.id);
 const moved=await service.action(owner,legacy.id,{eventId:randomUUID(),expectedRevision:legacyLease.snapshot.revision,type:'skip'});
 await service.action(owner,legacy.id,{eventId:randomUUID(),expectedRevision:moved.revision,type:'end'});
 assert.equal((await service.create(owner,'picnic')).stepIndex,1);
 await pool.query("DELETE FROM teeko_courses WHERE id='topic-picnic'");assert.deepEqual((await service.topics()).map(topic=>topic.id),['topic-robot']);
});

test('a packaged topic is discoverable, opens its bundled version, and saves topic history',{skip:!database},async t=>{
 const {pool,owner}=await fixture(t);
 const content=await loadTopicContent(fileURLToPath(new URL('../courses/topics',import.meta.url)));
 const course=content.courses.findLast(item=>item.id==='whale-snot-drones');
 assert(course);
 await publishTrialCourses(pool,content.courses);
 const version='database-only-test';
 await pool.query("INSERT INTO teeko_courses(id,version,manifest,checksum,published_at) VALUES($1,$2,$3,$4,now()+interval '1 day')",[
  course.id,version,JSON.stringify({...course,version}),'synthetic-unbundled-version',
 ]);
 const service=new ClassroomService(pool,{
  topicCards:[...TOPIC_CATALOG,...content.cards],
  bundledVersions:new Map(content.courses.map(item=>[item.id,item.version])),
 });
 assert.equal((await service.topics()).find(card=>card.id===course.id)?.coverImage,course.pages[0].image);
 assert.deepEqual((await service.courses(owner)).courses.map(card=>card.id),['picnic','robot-reading']);

 const first=await service.create(owner,course.id);
 assert.equal(first.course.version,course.version);
 assert.equal(first.course.steps[first.stepIndex].pageId,course.pages[0].id);
 const {snapshot}=await service.claim(owner,first.id);
 await assert.rejects(service.action(owner,first.id,{
  eventId:randomUUID(),expectedRevision:snapshot.revision,type:'select',objectIds:['blow'],
 }),{code:'ACTION_UNAVAILABLE'});
 const advanced=await service.action(owner,first.id,{eventId:randomUUID(),expectedRevision:snapshot.revision,type:'next'});
 assert.equal(advanced.course.steps[advanced.stepIndex].pageId,course.pages[1].id);
 await service.action(owner,first.id,{eventId:randomUUID(),expectedRevision:advanced.revision,type:'end'});

 const history=topicHistoryResponseSchema.parse({ok:true,...await service.topicHistory(owner)});
 assert.deepEqual(history.records.map(record=>[record.id,record.courseId,record.courseTitle]),[[first.id,course.id,course.title]]);
 assert.equal((await service.courses(owner)).recentClassrooms.length,0);
 const reopened=await service.create(owner,course.id);
 assert.equal(reopened.stepIndex,0);
 assert.notEqual(reopened.id,first.id);
});

test('topic history paginates persisted own records with stable ties and separate advice status',{skip:!database},async t=>{
 const {service,pool,owner,other,advance}=await fixture(t);const ids:string[]=[];
 for(let index=0;index<8;index++){
  const state=await service.create(owner,index%2?'topic-picnic':'topic-robot');ids.push(state.id);
  await service.action(owner,state.id,{eventId:randomUUID(),expectedRevision:state.revision,type:'end'});
  if(index%2)advance();
 }
 const old=await service.create(owner,'picnic');await service.action(owner,old.id,{eventId:randomUUID(),expectedRevision:old.revision,type:'end'});
 const foreign=await service.create(other,'topic-robot');await service.action(other,foreign.id,{eventId:randomUUID(),expectedRevision:foreign.revision,type:'end'});
 const active=await service.create(owner,'topic-picnic');
 await pool.query("UPDATE teeko_classroom_note_jobs SET status='succeeded',result='{}'::jsonb WHERE classroom_id=$1",[ids[0]]);
 await pool.query("UPDATE teeko_classroom_note_jobs SET status='failed',error_code='PROCESSING_FAILED' WHERE classroom_id=$1",[ids[1]]);
 const all=[];let cursor:string|undefined;
 do{
  const page=await service.topicHistory(owner,{pageSize:3,...(cursor?{cursor}:{})});assert(topicHistoryResponseSchema.safeParse({ok:true,...page}).success);
  assert.equal(page.activeClassroom?.id,active.id);all.push(...page.records);cursor=page.nextCursor??undefined;
 }while(cursor);
 assert.equal(all.length,8);assert.equal(new Set(all.map(record=>record.id)).size,8);assert.deepEqual(new Set(all.map(record=>record.id)),new Set(ids));
 assert.equal(all.find(record=>record.id===ids[0])?.adviceStatus,'ready');assert.equal(all.find(record=>record.id===ids[1])?.adviceStatus,'unavailable');
 assert(all.every(record=>record.noteCount===0&&record.elapsedSeconds===0));
 assert.equal((await service.topicHistory(other)).records.length,1);
 await pool.query('DELETE FROM teeko_profiles WHERE account_id=$1',[owner]);assert.equal((await service.topicHistory(owner)).records.length,6);
 assert.equal((await service.courses(owner)).recentClassrooms.length,1);
});

test('GPT robot wings demonstration is scoped, visible in the snapshot, and never grades or advances',{skip:!database},async t=>{
 const {service,pool,owner,other,advance}=await fixture(t);
 const classroom=await service.create(owner,'topic-robot',{...DEFAULT_CLASSROOM_PREFERENCES,provider:'openai'});
 const lease=await service.claim(owner,classroom.id),scope=lease.snapshot;
 const mark=(snapshot=scope,callId='call_robot_wings',objectId='wings',authorize?:()=>Promise<boolean>,isCurrent?:()=>boolean)=>
   service.applyGptRobotHighlight(owner,classroom.id,lease.epoch,lease.ownerToken,snapshot,callId,objectId,authorize,isCurrent);
 assert.equal(await mark(scope,'call_wrong_target','tail'),false);
 assert.equal(await mark(scope,'invalid call id'),false);
 assert.equal(await mark(scope,'call_denied','wings',async()=>false),false);
 assert.equal(await mark(scope,'call_interrupted','wings',async()=>true,()=>false),false);
 assert.equal(await service.applyGptRobotHighlight(other,classroom.id,lease.epoch,lease.ownerToken,scope,'call_foreign','wings'),false);
 assert.equal(await service.applyGptRobotHighlight(owner,classroom.id,lease.epoch,randomUUID(),scope,'call_stale_owner','wings'),false);
 assert.equal(await mark({...scope,revision:scope.revision+1}),false);
 assert.equal(await mark(),true);
 const shown=await service.get(owner,classroom.id);
 assert.equal(shown.revision,scope.revision+1);assert.equal(shown.stepIndex,scope.stepIndex);
 assert.deepEqual(shown.teacherObjectIds,['wings']);assert.deepEqual(shown.outcomes,[]);assert.equal(shown.feedback,null);
 assert.equal(await mark(shown,'call_repeated'),true);
 assert.equal((await service.get(owner,classroom.id)).revision,shown.revision);
 const stored=(await pool.query('SELECT helped_steps, teaching_state FROM teeko_classrooms WHERE id=$1',[classroom.id])).rows[0];
 assert.deepEqual(stored.helped_steps,[]);assert.equal(stored.teaching_state.hints,undefined);
 const events=(await pool.query("SELECT actor,status,details FROM teeko_classroom_journal WHERE classroom_id=$1 AND name='highlight_objects' ORDER BY id",[classroom.id])).rows;
 assert.deepEqual(events.map(e=>[e.actor,e.status,e.details.source]),[['teacher','requested','model'],['teacher','confirmed','model']]);
 assert.deepEqual(events[1].details.highlighted,['wings']);
 const second=await service.action(owner,classroom.id,{eventId:randomUUID(),expectedRevision:shown.revision,type:'next'});
 assert.equal(await mark(shown,'call_previous_step'),false);
 assert.equal(await mark(second,'call_robot_wings'),false);
 assert.deepEqual(second.teacherObjectIds,[]);
 for(let i=0;i<16;i++)advance();
 assert.equal(await mark(second,'call_expired'),false);
 const paused=await service.get(owner,classroom.id);
 assert.equal(paused.status,'paused');
 await service.action(owner,classroom.id,{eventId:randomUUID(),expectedRevision:paused.revision,type:'resume'});
 const replacement=await service.claim(owner,classroom.id);
 assert.equal(await service.applyGptRobotHighlight(owner,classroom.id,replacement.epoch,replacement.ownerToken,second,'call_old_epoch','wings'),false);
 const reading=await service.action(owner,classroom.id,{eventId:randomUUID(),expectedRevision:replacement.snapshot.revision,type:'next'});
 assert.equal(await service.applyGptRobotHighlight(owner,classroom.id,replacement.epoch,replacement.ownerToken,reading,'call_other_page','wings'),false);
});
