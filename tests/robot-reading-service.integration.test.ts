import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {ClassroomService} from '../lib/server/classroom-service';
import {PICNIC_COURSE,publishTrialCourses} from '../lib/server/course-catalog';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import {validateClassroomToolRequest,validateClassroomToolResult} from '../lib/domain/classroom-tool';
import type {PublishedCourse,ClassroomSnapshot} from '../lib/classroom-contract';
import type {TeacherAssessment} from '../lib/server/teacher-assessment';
import {teacherConfig} from './teacher-runtime-fixture';

const database=process.env.TEST_DATABASE_URL;
if(database){const url=new URL(database);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/test/.test(url.pathname))throw new Error('Loopback disposable test database required.');}
const course:PublishedCourse={
 ...PICNIC_COURSE,id:'reading-fixture',version:'1',title:'Reading fixture',durationMinutes:20,sessionLimitSeconds:1200,
 steps:[{id:'reading-first',kind:'speak',pageId:'picnic-table',targetId:null,english:'Explain one thing the robot could do.',chinese:'说出一个想法',hint:'Use your own words.',expected:'apple',reading:{phase:'read',passage:'This sample machine can travel through the air and through water.',goal:'Explain one idea in your own words.',teacherNotes:'Reading aloud is optional and not a comprehension answer.',followUp:'What clue helped you?'}},
 {id:'reading-design',kind:'speak',pageId:'picnic-table',targetId:null,english:'Suggest your own mission.',chinese:'提出自己的任务',hint:'Tell me one mission.',expected:null,reading:{phase:'design',passage:'Choose a task to explore.',goal:'Express one personal mission.',teacherNotes:'Accept creative ideas.',followUp:'What would you add?'}},
 {id:'reading-chat',kind:'listen',pageId:'picnic-table',targetId:null,english:'What else would you like to discuss?',chinese:'继续交流',hint:'Choose your own topic.',expected:null,reading:{phase:'chat',passage:'',goal:'Continue the learner topic.',teacherNotes:'Never end automatically.',followUp:'What interests you?'}}],
};
const correct={decision:'correct' as const,confidence:'high' as const,reason:'The learner expressed a relevant idea.',suggestedResponse:'Let us explore your idea.',nextAction:'acknowledge' as const};
async function fixture(t:TestContext,assess?:TeacherAssessment,limits:{maxSeconds?:number;dailySeconds?:number}={}){
 const admin=new Pool({connectionString:database}),schema=`robot_reading_test_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA ${schema}`);const pool=new Pool({connectionString:database,options:`-c search_path=${schema},public`,max:8});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 for(const name of ['0001_accounts.sql','0002_classrooms.sql','0003_teacher_agents.sql','0006_classroom_journal.sql','0007_classroom_notes.sql'])await pool.query(await readFile(new URL(`../db/migrations/${name}`,import.meta.url),'utf8'));
 await publishTrialCourses(pool);await pool.query('INSERT INTO teeko_courses(id,version,manifest,checksum) VALUES($1,$2,$3,$4)',[course.id,course.version,JSON.stringify(course),'synthetic-reading-fixture']);
 const owner=randomUUID();await pool.query("INSERT INTO teeko_accounts(id,email,password_hash,consent_version,consented_at,created_at)VALUES($1,$2,'synthetic','v1',now(),now())",[owner,`${owner}@example.test`]);
 await pool.query("INSERT INTO teeko_profiles(account_id,name,age_range,level,updated_at)VALUES($1,'Synthetic','12–13','sentences',now())",[owner]);
 const now=()=>new Date('2026-11-15T02:00:00Z'),service=new ClassroomService(pool,{now,assess,...limits});
 return{pool,owner,service,now};
}
async function active(f:Awaited<ReturnType<typeof fixture>>,index=0){
 const created=await f.service.create(f.owner,course.id);await f.pool.query('UPDATE teeko_classrooms SET teacher_config=$2,step_index=$3 WHERE id=$1',[created.id,JSON.stringify(teacherConfig),index]);
 const lease=await f.service.claim(f.owner,created.id);return{...lease,id:created.id,key:`${created.id}:${lease.epoch}:${index}`};
}
function delegate(snapshot:ClassroomSnapshot,itemId:string){
 const captured=captureClassroomToolState(snapshot);assert(captured.ok);
 const parsed=validateClassroomToolRequest(captured.snapshot,{type:'tool.requested',id:randomUUID(),receivedAtMs:Date.now(),source:'application',callId:`delegate-${itemId}`,context:captured.snapshot.context,command:{name:'delegate',arguments:{contextKey:`${snapshot.id}:${snapshot.connectionEpoch}:${snapshot.stepIndex}`,evidenceItemId:itemId}}});assert(parsed.accepted);return parsed.request;
}

test('reading gets its twenty-minute limit while existing courses keep fifteen minutes',{skip:!database},async t=>{
 const f=await fixture(t),reading=await f.service.create(f.owner,course.id);assert.equal(reading.maxSeconds,1200);
 await f.service.action(f.owner,reading.id,{eventId:randomUUID(),expectedRevision:reading.revision,type:'end'});
 const picnic=await f.service.create(f.owner,'picnic');assert.equal(picnic.maxSeconds,900);
});
test('explicit classroom caps and remaining daily allowance still constrain reading',{skip:!database},async t=>{
 const f=await fixture(t,undefined,{maxSeconds:60,dailySeconds:120}),limited=await f.service.create(f.owner,course.id);assert.equal(limited.maxSeconds,60);
 await f.service.action(f.owner,limited.id,{eventId:randomUUID(),expectedRevision:limited.revision,type:'end'});
 await f.pool.query('INSERT INTO teeko_classroom_usage(account_id,day_key,milliseconds) VALUES($1,$2,$3)',[f.owner,'2026-11-15',90000]);
 const remaining=await f.service.create(f.owner,course.id);assert.equal(remaining.maxSeconds,30);
 const row=(await f.pool.query('SELECT limit_reason FROM teeko_classrooms WHERE id=$1',[remaining.id])).rows[0];assert.equal(row.limit_reason,'daily_limit');
});
test('an explicit legacy course limit remains unchanged when no course override exists',{skip:!database},async t=>{
 const f=await fixture(t,undefined,{maxSeconds:1800,dailySeconds:3600});const picnic=await f.service.create(f.owner,'picnic');assert.equal(picnic.maxSeconds,1800);
});
test('checked reading discussion advances once as unassessed with a valid receipt and no ability credit',{skip:!database},async t=>{
 let count=0;const f=await fixture(t,async()=>{count++;return correct;}),c=await active(f);
 const teaching={level:'sentences',evidence:['independent'],hints:{},digressionTurns:0};await f.pool.query('UPDATE teeko_classrooms SET teaching_state=$2 WHERE id=$1',[c.id,JSON.stringify(teaching)]);
 await f.service.transcript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'It could explore a lake.',itemId:'own-idea',contextKey:c.key});
 const request=delegate(c.snapshot,'own-idea');const result=await f.service.tool(f.owner,c.id,c.epoch,c.ownerToken,'delegate',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});
 assert.equal(count,1);assert.equal(result.output.status,'confirmed');assert.equal(result.snapshot.stepIndex,1);assert.deepEqual(result.snapshot.outcomes,[{stepId:'reading-first',status:'unassessed'}]);assert.notEqual(result.snapshot.feedback?.kind,'correct');assert(result.execution);
 const after=captureClassroomToolState(result.snapshot);assert(after.ok);assert(validateClassroomToolResult(after.snapshot,{type:'tool.result',requestId:request.id,callId:request.callId,context:after.snapshot.context,phase:'application',output:result.output},request,result.execution).accepted);
 const runtime=await f.service.teacherRuntime(f.owner,c.id);assert.equal(runtime.state.level,'sentences');assert.deepEqual(runtime.state.evidence,['independent']);assert.equal(runtime.state.last?.result.decision,'correct');
 const repeated=await f.service.tool(f.owner,c.id,c.epoch,c.ownerToken,'delegate',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});assert.equal(repeated.output.status,'retry');assert.equal(repeated.snapshot.outcomes.length,1);assert(!repeated.execution);
});

test('formal application-origin reading check records its actor and returns a checked advance',{skip:!database},async t=>{
 let count=0;const f=await fixture(t,async()=>{count++;return correct;}),c=await active(f),itemId='formal-native-reading';
 await f.service.transcript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'It could explore a lake.',itemId,contextKey:c.key});
 const request=delegate(c.snapshot,itemId),result=await f.service.tool(f.owner,c.id,c.epoch,c.ownerToken,'delegate',request.command.arguments,undefined,{actor:'application',callId:request.callId,request});
 assert.equal(count,1);assert.equal(result.snapshot.stepIndex,1);assert.equal(result.output.status,'confirmed');assert.equal(result.execution?.requestId,request.id);assert.deepEqual(result.snapshot.outcomes,[{stepId:'reading-first',status:'unassessed'}]);
 const rows=(await f.pool.query("SELECT actor,details->>'source' AS source FROM teeko_classroom_journal WHERE classroom_id=$1 AND name='delegate' AND correlation_id=$2",[c.id,request.callId])).rows;
 assert.equal(rows.length,2);assert(rows.every(row=>row.actor==='application'&&row.source==='application'));
 const repeated=await f.service.tool(f.owner,c.id,c.epoch,c.ownerToken,'delegate',request.command.arguments,undefined,{actor:'application',callId:request.callId,request});assert(!repeated.execution);assert.equal(repeated.snapshot.outcomes.length,1);
});

test('application actor cannot use a teacher-scoped grading request',{skip:!database},async t=>{
 let count=0;const f=await fixture(t,async()=>{count++;return correct;}),c=await active(f),itemId='forged-application-grading';
 await f.service.transcript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'It could explore a lake.',itemId,contextKey:c.key});
 const scope=captureClassroomToolState(c.snapshot);assert(scope.ok);
 const checked=validateClassroomToolRequest(scope.snapshot,{type:'tool.requested',id:randomUUID(),receivedAtMs:Date.now(),source:'teacher',callId:'forged-source',context:scope.snapshot.context,command:{name:'submit_spoken_answer',arguments:{contextKey:c.key,answer:'It could explore a lake.'}}});assert(checked.accepted);
 const result=await f.service.tool(f.owner,c.id,c.epoch,c.ownerToken,'submit_spoken_answer',checked.request.command.arguments,undefined,{actor:'application',callId:checked.request.callId,request:checked.request});
 assert.equal(count,0);assert.equal(result.output.status,'unavailable');assert.equal(result.snapshot.stepIndex,0);assert.deepEqual(result.snapshot.outcomes,[]);assert(!result.execution);
});
test('reading manual next is browsing, explicit skip remains skipped, and terminal chat does not hang up',{skip:!database},async t=>{
 const f=await fixture(t),c=await active(f);let state=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:c.snapshot.revision,type:'next'});
 assert.deepEqual(state.outcomes,[{stepId:'reading-first',status:'unassessed'}]);assert.notEqual(state.feedback?.kind,'correct');
 state=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:state.revision,type:'skip'});assert.equal(state.outcomes[1].status,'skipped');
 await f.service.receiveTranscript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'Next.',itemId:'chat-next',contextKey:`${c.id}:${c.epoch}:2`});
 const chat=await f.service.get(f.owner,c.id);assert.equal(chat.stepIndex,2);assert.equal(chat.status,'active');assert.equal(chat.outcomes.length,2);
});
test('explicit spoken reading navigation uses unassessed browsing and leaves the final conversation open',{skip:!database},async t=>{
 const f=await fixture(t),c=await active(f);
 assert.equal(await f.service.receiveTranscript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'Next.',itemId:'spoken-next',contextKey:c.key}),'navigation');
 let state=await f.service.get(f.owner,c.id);assert.equal(state.stepIndex,1);assert.deepEqual(state.outcomes,[{stepId:'reading-first',status:'unassessed'}]);
 await f.service.transcript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'下一段',itemId:'delegate-next',contextKey:`${c.id}:${c.epoch}:1`});
 const request=delegate(state,'delegate-next');const result=await f.service.tool(f.owner,c.id,c.epoch,c.ownerToken,'delegate',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});assert.equal(result.output.status,'confirmed');assert(result.execution);assert.equal(result.snapshot.outcomes[1].status,'unassessed');
 for(const [index,text]of ['Next.','下一段','继续读','Skip.'].entries())assert.equal(await f.service.receiveTranscript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text,itemId:`chat-navigation-${index}`,contextKey:`${c.id}:${c.epoch}:2`}),undefined);
 state=await f.service.get(f.owner,c.id);assert.equal(state.status,'active');assert.equal(state.stepIndex,2);assert.equal(state.outcomes.length,2);
 const chatRequest=delegate(state,'chat-navigation-3');const chatResult=await f.service.tool(f.owner,c.id,c.epoch,c.ownerToken,'delegate',chatRequest.command.arguments,undefined,{actor:'teacher',callId:chatRequest.callId,request:chatRequest});assert.equal(chatResult.output.status,'conversation');assert.equal(chatResult.snapshot.stepIndex,2);assert(!chatResult.execution);
});
test('reading fails closed on absent semantic judgment and complete passage recital',{skip:!database},async t=>{
 for(const mode of ['missing','recital'] as const){let count=0;const f=await fixture(t,mode==='missing'?undefined:async()=>{count++;return correct;}),c=await active(f);
  const text=mode==='missing'?'apple':course.steps[0].reading!.passage;
  await f.service.receiveTranscript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text,itemId:mode,contextKey:c.key});
  const state=await f.service.get(f.owner,c.id);assert.equal(state.stepIndex,0,mode);assert.deepEqual(state.outcomes,[]);assert.equal(count,0,mode);
 }
});
test('explicit reading questions, refusal and requests for help cannot progress even if a model would approve',{skip:!database},async t=>{
 let count=0;const f=await fixture(t,async()=>{count++;return correct;}),c=await active(f);
 for(const [index,text] of ['Can it fly?','I do not want to read.','You read it.','Help me.','I do not know.'].entries()){
  await f.service.receiveTranscript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text,itemId:`support-${index}`,contextKey:c.key});
  const state=await f.service.get(f.owner,c.id);assert.equal(state.stepIndex,0,text);assert.deepEqual(state.outcomes,[],text);
 }assert.equal(count,0);
});
test('reading low confidence and retry preserve ability evidence and do not fabricate progress',{skip:!database},async t=>{
 for(const mode of ['low','retry'] as const){const f=await fixture(t,async()=>({...correct,decision:mode==='retry'?'retry':'correct',confidence:mode==='low'?'low':'high'})),c=await active(f);
  await f.pool.query('UPDATE teeko_classrooms SET teaching_state=$2 WHERE id=$1',[c.id,JSON.stringify({level:'sentences',evidence:['independent'],hints:{},digressionTurns:0})]);
  await f.service.receiveTranscript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'It could explore a lake.',itemId:mode,contextKey:c.key});
  const state=await f.service.get(f.owner,c.id),runtime=await f.service.teacherRuntime(f.owner,c.id);assert.equal(state.stepIndex,0);assert.deepEqual(state.outcomes,[]);assert.equal(runtime.state.level,'sentences');assert.deepEqual(runtime.state.evidence,['independent']);
 }
});
test('stale reading evidence cannot advance a new task',{skip:!database},async t=>{
 let started:()=>void=()=>{},finish:(value:typeof correct)=>void=()=>{};const pending=new Promise<void>(resolve=>{started=resolve;});
 const f=await fixture(t,async()=>{started();return new Promise(resolve=>{finish=resolve;});}),c=await active(f);
 const work=f.service.receiveTranscript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'It could explore a lake.',itemId:'old-idea',contextKey:c.key});await pending;
 const current=await f.service.get(f.owner,c.id);await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:current.revision,type:'next'});finish(correct);await work;
 const state=await f.service.get(f.owner,c.id);assert.equal(state.stepIndex,1);assert.deepEqual(state.outcomes,[{stepId:'reading-first',status:'unassessed'}]);
});
test('a later reading utterance cancels the pending earlier assessment without creating participation',{skip:!database},async t=>{
 let started:()=>void=()=>{},finish:(value:typeof correct)=>void=()=>{};const pending=new Promise<void>(resolve=>{started=resolve;});
 const f=await fixture(t,async()=>{started();return new Promise(resolve=>{finish=resolve;});}),c=await active(f);
 const work=f.service.receiveTranscript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'It could explore a lake.',itemId:'old-idea',contextKey:c.key});await pending;
 await f.service.transcript(f.owner,c.id,c.epoch,c.ownerToken,{role:'child',final:true,text:'Actually, I have a question.',itemId:'new-question',contextKey:c.key});finish(correct);await work;
 const state=await f.service.get(f.owner,c.id);assert.equal(state.stepIndex,0);assert.deepEqual(state.outcomes,[]);
});
