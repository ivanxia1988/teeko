import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {ClassroomService} from '../lib/server/classroom-service';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import type {ClassroomPointRequest} from '../lib/classroom-point';
import type {ClassroomSnapshot,PublishedCourse} from '../lib/classroom-contract';
import type {TeacherAssessment} from '../lib/server/teacher-assessment';
import {PICNIC_COURSE,publishTrialCourses} from '../lib/server/course-catalog';
import {teacherConfig} from './teacher-runtime-fixture';
import type {ClassroomPointDiagnosticEvent} from '../lib/classroom-point-diagnostics';

const database=process.env.TEST_DATABASE_URL;
if(database){const url=new URL(database);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/test/.test(url.pathname))throw new Error('Loopback disposable test database required.');}
const course:PublishedCourse={...PICNIC_COURSE,id:'point-fixture',version:'1',steps:[
 {id:'reading-point',kind:'speak',pageId:'picnic-table',targetId:null,expected:null,english:'Which part do you notice?',chinese:'指出你注意到的东西',hint:'You can point to it.',reading:{phase:'read',passage:'This machine can fly over a lake.',goal:'Discuss one idea.',teacherNotes:'Pointing is interaction, never comprehension or pronunciation evidence.',followUp:'What do you notice?'}},
 {id:'open-chat',kind:'listen',pageId:'picnic-table',targetId:null,expected:null,english:'What interests you?',chinese:'聊聊你的兴趣',hint:'Choose your own topic.'},
 {id:'select-apple',kind:'select',pageId:'picnic-table',targetId:'apple',expected:null,english:'Find an apple.',chinese:'找苹果',hint:'Look at the fruit.'},
]};
async function fixture(t:TestContext,assess?:TeacherAssessment){
 const admin=new Pool({connectionString:database}),schema=`classroom_point_test_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:database,options:`-c search_path=${schema},public`,max:8});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 for(const name of ['0001_accounts.sql','0002_classrooms.sql','0003_teacher_agents.sql','0006_classroom_journal.sql','0007_classroom_notes.sql'])await pool.query(await readFile(new URL(`../db/migrations/${name}`,import.meta.url),'utf8'));
 await publishTrialCourses(pool);await pool.query('INSERT INTO teeko_courses(id,version,manifest,checksum) VALUES($1,$2,$3,$4)',[course.id,course.version,JSON.stringify(course),'synthetic-point-fixture']);
 const owner=randomUUID();await pool.query("INSERT INTO teeko_accounts(id,email,password_hash,consent_version,consented_at,created_at) VALUES($1,$2,'synthetic','v1',now(),now())",[owner,`${owner}@example.test`]);
 await pool.query("INSERT INTO teeko_profiles(account_id,name,age_range,level,updated_at) VALUES($1,'Synthetic','12–13','sentences',now())",[owner]);
 let clock=new Date('2026-11-16T02:00:00Z');const service=new ClassroomService(pool,{now:()=>clock,assess});
 return {pool,owner,service,advance(ms:number){clock=new Date(clock.getTime()+ms);}};
}
async function active(f:Awaited<ReturnType<typeof fixture>>,stepIndex=0){
 const created=await f.service.create(f.owner,course.id);
 await f.pool.query('UPDATE teeko_classrooms SET teacher_config=$2,step_index=$3 WHERE id=$1',[created.id,JSON.stringify(teacherConfig),stepIndex]);
 const lease=await f.service.claim(f.owner,created.id);return {...lease,id:created.id};
}
function point(snapshot:ClassroomSnapshot,eventId:string=randomUUID()):ClassroomPointRequest{
 const captured=captureClassroomToolState(snapshot);assert(captured.ok);
 return {type:'interaction.point',eventId,context:captured.snapshot.context,objectId:'apple'};
}

test('point persists one child interaction, revokes old speech evidence and leaves all learning outcomes unchanged',{skip:!database},async t=>{
 const f=await fixture(t),c=await active(f);
 const feedback={id:randomUUID(),kind:'hint',message:'A current hint.'};
 await f.pool.query('UPDATE teeko_classrooms SET feedback=$2,helped_steps=$3,teacher_object_ids=$4 WHERE id=$1',[c.id,JSON.stringify(feedback),JSON.stringify(['reading-point']),JSON.stringify(['apple'])]);
 await f.service.transcript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'An earlier idea.',itemId:'earlier-input',contextKey:`${c.id}:${c.epoch}:0`});
 const before=await f.service.get(f.owner,c.id),request=point(before),result=await f.service.point(f.owner,c.id,c.epoch,c.ownerToken,request);
 assert.equal(result.accepted,true);assert.equal(result.snapshot.revision,before.revision+1);assert.equal(result.snapshot.stepIndex,before.stepIndex);
 assert.deepEqual(result.snapshot.outcomes,before.outcomes);assert.deepEqual(result.snapshot.feedback,before.feedback);assert.deepEqual(result.snapshot.teacherObjectIds,before.teacherObjectIds);
 const row=(await f.pool.query('SELECT teaching_state,helped_steps FROM teeko_classrooms WHERE id=$1',[c.id])).rows[0];
 assert.equal(row.teaching_state.latestInput,undefined);assert.deepEqual(row.helped_steps,['reading-point']);
 const transcripts=await f.pool.query('SELECT item_id,text FROM teeko_classroom_transcripts WHERE classroom_id=$1',[c.id]);assert.deepEqual(transcripts.rows,[{item_id:'earlier-input',text:'An earlier idea.'}]);
 const events=(await f.pool.query("SELECT name,actor,status,details FROM teeko_classroom_journal WHERE classroom_id=$1 AND name='point'",[c.id])).rows;
 assert.equal(events.length,1);assert.equal(events[0].actor,'child');assert.equal(events[0].status,'recorded');assert.equal(events[0].details.action,'point');assert.equal(events[0].details.source,'client');assert.deepEqual(events[0].details.objectIds,['apple']);
});

test('point is idempotent under concurrent delivery and event reuse cannot create another cue',{skip:!database},async t=>{
 const f=await fixture(t),c=await active(f),request=point(c.snapshot);
 const results=await Promise.all([f.service.point(f.owner,c.id,c.epoch,c.ownerToken,request),f.service.point(f.owner,c.id,c.epoch,c.ownerToken,request)]);
 assert.deepEqual(results.map(result=>result.accepted).sort(),[false,true]);
 const current=await f.service.get(f.owner,c.id);assert.equal(current.revision,c.snapshot.revision+1);
 const reused=await f.service.point(f.owner,c.id,c.epoch,c.ownerToken,point(current,request.eventId));assert.equal(reused.accepted,false);assert.equal(reused.snapshot.revision,current.revision);
 assert.equal((await f.pool.query('SELECT 1 FROM teeko_classroom_actions WHERE classroom_id=$1',[c.id])).rowCount,1);
 assert.equal((await f.pool.query("SELECT 1 FROM teeko_classroom_journal WHERE classroom_id=$1 AND name='point'",[c.id])).rowCount,1);
});

test('point rejects stale scope, wrong owner lease, denied authorization, unknown objects and select activities',{skip:!database},async t=>{
 const f=await fixture(t),c=await active(f),request=point(c.snapshot);
 for(const input of [{...request,context:{...request.context,stateRevision:request.context.stateRevision-1}}, {...request,context:{...request.context,stateRevision:request.context.stateRevision+1}}, {...request,context:{...request.context,logicalSessionId:randomUUID()}}, {...request,objectId:'unknown'}])assert.equal((await f.service.point(f.owner,c.id,c.epoch,c.ownerToken,input)).accepted,false);
 assert.equal((await f.service.point(f.owner,c.id,c.epoch,randomUUID(),request)).accepted,false);
 assert.equal((await f.service.point(f.owner,c.id,c.epoch+1,c.ownerToken,request)).accepted,false);
 assert.equal((await f.service.point(f.owner,c.id,c.epoch,c.ownerToken,request,async()=>false)).accepted,false);
 assert.equal((await f.service.get(f.owner,c.id)).revision,c.snapshot.revision);
 await f.pool.query('UPDATE teeko_classrooms SET step_index=2 WHERE id=$1',[c.id]);
 const select=await f.service.get(f.owner,c.id);assert.equal((await f.service.point(f.owner,c.id,c.epoch,c.ownerToken,point(select))).accepted,false);
 assert.equal((await f.pool.query('SELECT 1 FROM teeko_classroom_actions WHERE classroom_id=$1',[c.id])).rowCount,0);
});

test('point rechecks an expired lease and the daily allowance inside its transaction',{skip:!database},async t=>{
 const expired=await fixture(t),a=await active(expired);expired.advance(15_001);
 const denied=await expired.service.point(expired.owner,a.id,a.epoch,a.ownerToken,point(a.snapshot));assert.equal(denied.accepted,false);assert.equal(denied.snapshot.status,'paused');
 const limited=await fixture(t),b=await active(limited);
 await limited.pool.query('INSERT INTO teeko_classroom_usage(account_id,day_key,milliseconds) VALUES($1,$2,$3)',[limited.owner,'2026-11-16',3_600_000]);
 assert.equal((await limited.service.point(limited.owner,b.id,b.epoch,b.ownerToken,point(b.snapshot))).accepted,false);
 assert.equal((await limited.pool.query('SELECT 1 FROM teeko_classroom_actions WHERE classroom_id=$1',[b.id])).rowCount,0);
});

test('an accepted point cancels old semantic work and a late correct result cannot advance the lesson',{skip:!database},async t=>{
 let started:()=>void=()=>{},finish:(value:{decision:'correct';confidence:'high';reason:string;suggestedResponse:string;nextAction:'acknowledge'})=>void=()=>{},signal:AbortSignal|undefined;
 const pending=new Promise<void>(resolve=>{started=resolve;});
 const f=await fixture(t,async(_input,cancel)=>{signal=cancel;started();return new Promise(resolve=>{finish=resolve;});}),c=await active(f);
 const work=f.service.receiveTranscript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'It can fly across the lake.',itemId:'old-assessment',contextKey:`${c.id}:${c.epoch}:0`});await pending;
 const current=await f.service.get(f.owner,c.id),result=await f.service.point(f.owner,c.id,c.epoch,c.ownerToken,point(current));assert.equal(result.accepted,true);assert.equal(signal?.aborted,true);
 finish({decision:'correct',confidence:'high',reason:'Synthetic delayed judgment.',suggestedResponse:'A useful idea.',nextAction:'acknowledge'});await work;
 const after=await f.service.get(f.owner,c.id);assert.equal(after.stepIndex,0);assert.deepEqual(after.outcomes,[]);assert.deepEqual(after.feedback,result.snapshot.feedback);
});

test('new speech received while point authorization waits withdraws the old point without clearing the new input',{skip:!database},async t=>{
 const f=await fixture(t),c=await active(f),contextKey=`${c.id}:${c.epoch}:0`;
 await f.service.transcript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'My first idea.',itemId:'before-point',contextKey});
 let calls=0,current=true,entered:()=>void=()=>{},release:()=>void=()=>{};
 const waiting=new Promise<void>(resolve=>{entered=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
 t.after(()=>release());
 const work=f.service.point(f.owner,c.id,c.epoch,c.ownerToken,point(c.snapshot),async()=>{if(++calls===2){entered();await released;}return current;});
 await waiting;current=false;
 const speech=f.service.transcript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'A newer idea.',itemId:'after-point',contextKey});
 release();const result=await work;await speech;
 assert.equal(result.accepted,false);assert.equal(result.snapshot.revision,c.snapshot.revision);
 const row=(await f.pool.query('SELECT teaching_state FROM teeko_classrooms WHERE id=$1',[c.id])).rows[0];assert.equal(row.teaching_state.latestInput.itemId,'after-point');
 assert.equal((await f.pool.query("SELECT 1 FROM teeko_classroom_journal WHERE classroom_id=$1 AND name='point'",[c.id])).rowCount,0);
 assert.equal((await f.pool.query('SELECT 1 FROM teeko_classroom_actions WHERE classroom_id=$1',[c.id])).rowCount,0);
});

const observation=(snapshot:ClassroomSnapshot,stage:ClassroomPointDiagnosticEvent['stage']='send_failed'):ClassroomPointDiagnosticEvent=>({id:randomUUID(),pointId:randomUUID(),context:point(snapshot).context,stage,reason:'not_ready',objectId:'unknown-but-observed'});
test('point diagnostics persist one bounded client observation per ID without changing classroom facts',{skip:!database},async t=>{
 const f=await fixture(t),c=await active(f),event=observation(c.snapshot),before=await f.service.get(f.owner,c.id);
 await Promise.all([f.service.pointDiagnostics(f.owner,c.id,[event]),f.service.pointDiagnostics(f.owner,c.id,[event])]);
 const records=(await f.pool.query("SELECT actor,status,correlation_id,details FROM teeko_classroom_journal WHERE classroom_id=$1 AND name='point_trace'",[c.id])).rows;
 assert.equal(records.length,1);assert.equal(records[0].actor,'child');assert.equal(records[0].status,'failed');assert.equal(records[0].correlation_id,event.pointId);assert.equal(records[0].details.source,'client');assert.equal(records[0].details.pointStage,'send_failed');assert.equal(records[0].details.pointReason,'not_ready');assert.deepEqual(records[0].details.objectIds,['unknown-but-observed']);
 const after=await f.service.get(f.owner,c.id);assert.equal(after.revision,before.revision);assert.deepEqual(after.outcomes,before.outcomes);assert.deepEqual(after.feedback,before.feedback);assert.equal(after.stepIndex,before.stepIndex);assert.equal((await f.pool.query('SELECT 1 FROM teeko_classroom_actions WHERE classroom_id=$1',[c.id])).rowCount,0);
});
test('point diagnostics reject foreign or future context, unauthorized owners and server stages',{skip:!database},async t=>{
 const f=await fixture(t),c=await active(f),event=observation(c.snapshot);
 const bad=[{logicalSessionId:randomUUID()},{courseVersion:'foreign:99'},{connectionEpoch:c.epoch+1},{stateRevision:c.snapshot.revision+1},{pageId:'foreign-page'},{activityId:'foreign-activity'}];
 await f.service.pointDiagnostics(f.owner,c.id,bad.map(context=>({...event,id:randomUUID(),context:{...event.context,...context}})));
 assert.equal((await f.pool.query("SELECT 1 FROM teeko_classroom_journal WHERE classroom_id=$1 AND name='point_trace'",[c.id])).rowCount,0);
 await assert.rejects(f.service.pointDiagnostics(f.owner,c.id,[{...event,stage:'accepted'}as unknown as ClassroomPointDiagnosticEvent]));await assert.rejects(f.service.pointDiagnostics(f.owner,c.id,Array(11).fill(event)));
 await assert.rejects(f.service.pointDiagnostics(randomUUID(),c.id,[event]),(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='UNAUTHORIZED');
 const other=randomUUID();await f.pool.query("INSERT INTO teeko_accounts(id,email,password_hash,consent_version,consented_at,created_at) VALUES($1,$2,'synthetic','v1',now(),now())",[other,`${other}@example.test`]);await assert.rejects(f.service.pointDiagnostics(other,c.id,[event]),(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='NOT_FOUND');
});
test('same-epoch paused and ended failure observations survive, while an old epoch cannot pollute a resumed classroom',{skip:!database},async t=>{
 const f=await fixture(t),c=await active(f);await f.service.release(f.owner,c.id,c.epoch,c.ownerToken);
 const paused=observation(c.snapshot,'timeout');await f.service.pointDiagnostics(f.owner,c.id,[paused]);
 const resumed=await f.service.claim(f.owner,c.id);await f.service.pointDiagnostics(f.owner,c.id,[observation(c.snapshot,'unavailable')]);
 const ended=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:resumed.snapshot.revision,type:'end'});const final=observation(resumed.snapshot,'send_failed');await f.service.pointDiagnostics(f.owner,c.id,[final]);
 const records=(await f.pool.query("SELECT connection_epoch,correlation_id FROM teeko_classroom_journal WHERE classroom_id=$1 AND name='point_trace' ORDER BY id",[c.id])).rows;assert.deepEqual(records,[{connection_epoch:c.epoch,correlation_id:paused.pointId},{connection_epoch:resumed.epoch,correlation_id:final.pointId}]);assert.equal((await f.service.get(f.owner,c.id)).revision,ended.revision);
});
