import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import {validateClassroomToolRequest} from '../lib/domain/classroom-tool';
import type {ClassroomSnapshot} from '../lib/classroom-contract';
import type {ClassroomChalkCandidate} from '../lib/server/classroom-chalk-candidate';

const database = process.env.TEST_DATABASE_URL;
if (database) {
  const url = new URL(database);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/test/.test(url.pathname)) throw new Error('A loopback disposable test database is required.');
}
async function fixture(t: TestContext) {
  const admin = new Pool({ connectionString: database });
  const schema = `classroom_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: database, options: `-c search_path=${schema},public`, max:8 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  for (const file of ['0001_accounts.sql','0002_classrooms.sql','0003_teacher_agents.sql','0006_classroom_journal.sql','0007_classroom_notes.sql']) await pool.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
  const { ClassroomService } = await import('../lib/server/classroom-service.ts');
  const { publishTrialCourses } = await import('../lib/server/course-catalog.ts');
  await publishTrialCourses(pool);
  const owner = randomUUID(), other = randomUUID();
  for (const id of [owner,other]) {
    await pool.query("INSERT INTO teeko_accounts(id,email,password_hash,consent_version,consented_at,created_at) VALUES($1,$2,'synthetic','v1',now(),now())",[id,`${id}@example.test`]);
    await pool.query("INSERT INTO teeko_profiles(account_id,name,age_range,level,updated_at) VALUES($1,'Test learner','10–11','unsure',now())",[id]);
  }
  let clock = new Date('2026-11-01T01:00:00Z');
  const options = { now:()=>new Date(clock), maxSeconds:60, dailySeconds:120 };
  const service = new ClassroomService(pool,options);
  return { pool,owner,other,service,options,advance:(ms:number)=>{ clock=new Date(clock.getTime()+ms); } };
}

function scopedHighlight(snapshot:ClassroomSnapshot,callId:string,objectIds=['apple']){
  const captured=captureClassroomToolState(snapshot);assert(captured.ok);
  const checked=validateClassroomToolRequest(captured.snapshot,{type:'tool.requested',id:randomUUID(),receivedAtMs:Date.now(),source:'teacher',callId,context:captured.snapshot.context,command:{name:'highlight_objects',arguments:{contextKey:`${snapshot.id}:${snapshot.connectionEpoch}:${snapshot.stepIndex}`,objectIds}}});
  assert(checked.accepted);return checked.request;
}

test('scoped teacher highlight applies without progress, grading or repeated hint credit',{skip:!database},async t=>{
  const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
  const request=scopedHighlight(lease.snapshot,'scoped-first');
  const first=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'highlight_objects',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});
  assert.equal(first.output.status,'confirmed');assert.deepEqual(first.snapshot.teacherObjectIds,['apple']);
  assert.equal(first.snapshot.stepIndex,0);assert.deepEqual(first.snapshot.outcomes,[]);assert(first.snapshot.revision>request.context.stateRevision);
  const next=scopedHighlight(first.snapshot,'scoped-repeat');
  const repeat=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'highlight_objects',next.command.arguments,undefined,{actor:'teacher',callId:next.callId,request:next});
  assert.equal(repeat.output.status,'confirmed');assert.equal(repeat.snapshot.revision,first.snapshot.revision);
  const state=(await f.pool.query('SELECT teaching_state,helped_steps FROM teeko_classrooms WHERE id=$1',[created.id])).rows[0];
  assert.equal(state.teaching_state.hints['find-apple'],1);assert.deepEqual(state.helped_steps,['find-apple']);
  const logs=(await f.pool.query("SELECT status,details FROM teeko_classroom_journal WHERE classroom_id=$1 AND kind='tool'",[created.id])).rows;
  assert(logs.some(row=>row.status==='requested'));assert(logs.some(row=>row.status==='confirmed'&&row.details.highlighted?.includes('apple')));
  assert(logs.every(row=>!('phase' in row.details)&&!('rendered' in row.details)&&!('request' in row.details)));
});

test('lesson review reads only saved own-class sources after an explicit latest request without assessment or progression',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 let state=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
 const {teacherConfig}=await import('./teacher-runtime-fixture');await f.pool.query('UPDATE teeko_classrooms SET teacher_config=$2 WHERE id=$1',[created.id,JSON.stringify(teacherConfig)]);
 const {ClassroomService}=await import('../lib/server/classroom-service');let assessments=0;
 const service=new ClassroomService(f.pool,{...f.options,assess:async()=>{assessments++;return{decision:'conversation',confidence:'high',reason:'PRIVATE_REVIEW_REASON',suggestedResponse:'My dog likes apples.',nextAction:'model'};}});
 await service.receiveTranscript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:'My dog like apples.',final:true,itemId:'review-source',contextKey:`${created.id}:${lease.epoch}:1`});
 f.advance(1);await service.receiveTranscript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:'Can we review this lesson?',final:true,itemId:'review-request',contextKey:`${created.id}:${lease.epoch}:1`});state=await service.get(f.owner,created.id);
 const captured=captureClassroomToolState(state);assert(captured.ok);
 const checked=validateClassroomToolRequest(captured.snapshot,{type:'tool.requested',id:randomUUID(),receivedAtMs:Date.now(),source:'teacher',callId:'native-review',context:captured.snapshot.context,command:{name:'review_lesson_notes',arguments:{contextKey:`${created.id}:${lease.epoch}:1`}}});assert(checked.accepted);
 const request=checked.request;
 await assert.rejects(service.tool(f.other,created.id,lease.epoch,lease.ownerToken,'review_lesson_notes',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request}),{code:'NOT_FOUND'});
 const revoked=await service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'review_lesson_notes',request.command.arguments,async()=>false,{actor:'teacher',callId:request.callId,request});assert.equal(revoked.output.status,'unavailable');
 await f.pool.query("UPDATE teeko_classroom_transcripts SET created_at=$2 WHERE classroom_id=$1 AND item_id='review-request'",[created.id,new Date(f.options.now().getTime()+1000)]);
 const future=await service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'review_lesson_notes',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});assert.equal(future.output.status,'unavailable');
 await f.pool.query("UPDATE teeko_classroom_transcripts SET created_at=$2 WHERE classroom_id=$1 AND item_id='review-request'",[created.id,f.options.now()]);
 const result=await service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'review_lesson_notes',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});assert.equal(result.output.status,'reference');assert(result.output.english?.includes('My dog likes apples.'));assert(!result.output.english?.includes('PRIVATE_REVIEW_REASON'));assert.equal(assessments,1);assert.equal(result.snapshot.revision,state.revision);assert.deepEqual(result.snapshot.outcomes,state.outcomes);assert.deepEqual(result.snapshot.feedback,state.feedback);
 const repeat=await service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'review_lesson_notes',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});assert.equal(repeat.output.status,'unavailable');
 const logs=JSON.stringify((await f.pool.query("SELECT details FROM teeko_classroom_journal WHERE classroom_id=$1 AND kind='tool' AND name='review_lesson_notes'",[created.id])).rows);assert(!logs.includes('My dog likes apples.'));
});

test('GPT delegates an explicit optional recap but rejects a superseded or negative review request',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);let state=lease.snapshot;
 const apply=async(text:string,itemId:string)=>{f.advance(1);await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text,final:true,itemId,contextKey:`${created.id}:${lease.epoch}:0`});const request=scopedDelegation(state,`request-${itemId}`,itemId);return f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'delegate',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});};
 const empty=await apply("Let's review.",'empty-review');assert.equal(empty.output.status,'reference');assert(empty.output.english?.includes('No saved expression'));state=empty.snapshot;assert.equal(state.revision,lease.snapshot.revision);assert.deepEqual(state.outcomes,[]);
 const old=scopedDelegation(state,'superseded-review','empty-review');await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:"I don't want to review.",final:true,itemId:'declined-review',contextKey:`${created.id}:${lease.epoch}:0`});const denied=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'delegate',old.command.arguments,undefined,{actor:'teacher',callId:old.callId,request:old});assert.equal(denied.output.status,'unavailable');
 const negative=await apply("I don't want to review.",'negative-review');assert.equal(negative.output.status,'conversation');assert(!negative.output.english?.includes('Saved source pairs'));
});

test('captured lesson notes survive rolling evidence and finalize once without changing learning facts',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
 const {teacherConfig}=await import('./teacher-runtime-fixture');await f.pool.query('UPDATE teeko_classrooms SET teacher_config=$2 WHERE id=$1',[created.id,JSON.stringify(teacherConfig)]);
 const {ClassroomService}=await import('../lib/server/classroom-service');const service=new ClassroomService(f.pool,{...f.options,assess:async()=>({decision:'conversation',confidence:'high',reason:'PRIVATE_NOTE_REASON',suggestedResponse:'My dog likes apples.',nextAction:'model'})});
 for(let i=0;i<70;i++){
  f.advance(1);await service.receiveTranscript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:`My dog like apples ${i}.`,final:true,itemId:`persist-${String(i).padStart(3,'0')}`,contextKey:`${created.id}:${lease.epoch}:1`});
 }
 await service.receiveTranscript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:'My dog like apples 69.',final:true,itemId:'persist-069',contextKey:`${created.id}:${lease.epoch}:1`});
 const before=await service.get(f.owner,created.id),ended=await service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:before.revision,type:'end'});
 assert.equal(Number((await f.pool.query('SELECT count(*) AS n FROM teeko_classroom_note_records WHERE classroom_id=$1',[created.id])).rows[0].n),70);
 assert.equal(Number((await f.pool.query('SELECT count(*) AS n FROM teeko_classroom_transcripts WHERE classroom_id=$1',[created.id])).rows[0].n),64);
 const {ClassroomNoteJobs}=await import('../lib/server/classroom-note-jobs');const jobs=new ClassroomNoteJobs(f.pool,{now:f.options.now});
 const pendingPage=await service.notes(f.owner,created.id,{pageSize:10});assert.equal(pendingPage.preparation,'pending');assert.equal(pendingPage.entries.length,10);
 assert.equal(await jobs.runOne(),'succeeded');assert.equal(await jobs.runOne(),'empty');
 await assert.rejects(service.notes(f.other,created.id),{code:'NOT_FOUND'});
 let cursor:string|undefined;const ids:string[]=[];
 do{const page=await service.notes(f.owner,created.id,{pageSize:10,...(cursor?{cursor}:{})});assert.equal(page.coverage,'captured_sources');assert.equal(page.preparation,'ready');ids.push(...page.entries.map(note=>note.origin.itemId));cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(ids.length,70);assert(ids.includes('persist-000'));assert.equal(new Set(ids).size,70);
 assert.deepEqual((await service.get(f.owner,created.id)).outcomes,ended.outcomes);assert.equal((await service.get(f.owner,created.id)).revision,ended.revision);
 const stored=JSON.stringify((await f.pool.query('SELECT card FROM teeko_classroom_note_records WHERE classroom_id=$1',[created.id])).rows);assert(!stored.includes('PRIVATE_NOTE_REASON'));
 const repeat=await service.get(f.owner,created.id);assert.equal(repeat.status,'ended');assert.equal(Number((await f.pool.query('SELECT count(*) AS n FROM teeko_classroom_note_jobs WHERE classroom_id=$1',[created.id])).rows[0].n),1);
});

test('note job claims are exclusive, expired owners are fenced and cancellation cannot resurrect a task',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic');await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:created.revision,type:'end'});
 const {ClassroomNoteJobs}=await import('../lib/server/classroom-note-jobs');const jobs=new ClassroomNoteJobs(f.pool,{now:f.options.now});
 const claims=await Promise.all([jobs.claim(),jobs.claim()]),first=claims.find(Boolean);assert(first);assert.equal(claims.filter(Boolean).length,1);
 f.advance(30000);const second=await jobs.claim();assert(second);assert.notEqual(first.ownerToken,second.ownerToken);
 const manifest=await jobs.build(first);assert(manifest);assert.equal(await jobs.complete(first,manifest),false);
 assert.equal(await jobs.cancel(created.id),true);assert.equal(await jobs.complete(second,manifest),false);assert.equal(await jobs.runOne(),'empty');
 const row=(await f.pool.query('SELECT status,result FROM teeko_classroom_note_jobs WHERE classroom_id=$1',[created.id])).rows[0];assert.equal(row.status,'cancelled');assert.equal(row.result,null);
});

test('note tasks retry bounded failures, survive owner restart and do not publish an obsolete revision',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic');await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:created.revision,type:'end'});
 const {ClassroomNoteJobs}=await import('../lib/server/classroom-note-jobs');const jobs=new ClassroomNoteJobs(f.pool,{now:f.options.now});
 for(let attempt=1;attempt<=3;attempt++){const task=await jobs.claim();assert(task);assert.equal(task.attempts,attempt);assert.equal(await jobs.fail(task),attempt<3?'retry':'failed');assert.equal(await jobs.claim(),null);f.advance(10000);}
 assert.equal(await jobs.runOne(),'empty');assert.equal((await f.pool.query('SELECT status FROM teeko_classroom_note_jobs WHERE classroom_id=$1',[created.id])).rows[0].status,'failed');
});

test('an expired note worker cannot cancel a newly claimed owner after its source check finishes late',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic');await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:created.revision,type:'end'});
 const {ClassroomNoteJobs}=await import('../lib/server/classroom-note-jobs');const first=new ClassroomNoteJobs(f.pool,{now:f.options.now}),second=new ClassroomNoteJobs(f.pool,{now:f.options.now});
 let release:()=>void=()=>{},started:()=>void=()=>{};const waiting=new Promise<void>(resolve=>{started=resolve;});const blocked=new Promise<void>(resolve=>{release=resolve;});
 first.build=async()=>{started();await blocked;return null;};const pending=first.runOne();
 try{await waiting;f.advance(30000);const newOwner=await second.claim();assert(newOwner);release();assert.equal(await pending,'lost');
  const row=(await f.pool.query('SELECT status,owner_token FROM teeko_classroom_note_jobs WHERE classroom_id=$1',[created.id])).rows[0];assert.equal(row.status,'running');assert.equal(row.owner_token,newOwner.ownerToken);
 }finally{release();await pending;}
});

test('a note task cannot publish after source revision changes and exhausted leases terminate',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic');await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:created.revision,type:'end'});
 const {ClassroomNoteJobs}=await import('../lib/server/classroom-note-jobs');const jobs=new ClassroomNoteJobs(f.pool,{now:f.options.now}),task=await jobs.claim();assert(task);const manifest=await jobs.build(task);assert(manifest);
 assert.equal(await jobs.complete(task,{...manifest,reason:'hidden'}),false);
 await f.pool.query('UPDATE teeko_classrooms SET revision=revision+1 WHERE id=$1',[created.id]);assert.equal(await jobs.complete(task,manifest),false);
 for(let i=0;i<2;i++){f.advance(30000);assert(await jobs.claim());}f.advance(30000);assert.equal(await jobs.claim(),null);
 assert.equal((await f.pool.query('SELECT status,result FROM teeko_classroom_note_jobs WHERE classroom_id=$1',[created.id])).rows[0].status,'failed');
});

test('the real note worker CLI consumes a disposable PG task without exposing configuration',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic');await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:created.revision,type:'end'});
 const schema=(await f.pool.query('SELECT current_schema() AS name')).rows[0].name;assert.match(schema,/^classroom_test_[a-f0-9]+$/);
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const result=await promisify(execFile)(process.execPath,['--import','tsx','scripts/run-classroom-note-jobs.ts','--once'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:database!,PGOPTIONS:`-c search_path=${schema},public`},timeout:10000,maxBuffer:2048});
 assert.equal(result.stderr,'');assert.match(result.stdout,/Processed: 1; succeeded: 1/);assert.equal(result.stdout.includes(database!),false);
 assert.equal((await f.service.notes(f.owner,created.id)).preparation,'ready');
});

test('the note cap is explicit and failed consolidation still reads saved source cards',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 const state=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
 const {buildClassroomNote}=await import('../lib/server/classroom-notes');const card=buildClassroomNote(state,{epoch:lease.epoch,itemId:'cap-source',stepIndex:1,transcriptText:'My dog like apples.',transcriptSource:'speech',transcriptAt:f.options.now().toISOString(),contextKey:`${created.id}:${lease.epoch}:1`,decisionAt:f.options.now().toISOString(),decision:{decision:'conversation',confidence:'high',reason:'PRIVATE_CAP_REASON',suggestedResponse:'My dog likes apples.',nextAction:'model'}});assert(card);
 await f.pool.query(`INSERT INTO teeko_classroom_note_records(classroom_id,connection_epoch,item_id,source_revision,card,saved_at) SELECT $1::uuid,$2::integer,'cap-'||n,$3::integer,jsonb_set(jsonb_set($4::jsonb,'{id}',to_jsonb(($2::integer)::text||':cap-'||n)),'{origin,itemId}',to_jsonb('cap-'||n)),$5::timestamptz FROM generate_series(1,256) n`,[created.id,lease.epoch,state.revision,JSON.stringify(card),f.options.now()]);
 const {teacherConfig}=await import('./teacher-runtime-fixture');await f.pool.query('UPDATE teeko_classrooms SET teacher_config=$2 WHERE id=$1',[created.id,JSON.stringify(teacherConfig)]);
 const {ClassroomService}=await import('../lib/server/classroom-service');const service=new ClassroomService(f.pool,{...f.options,assess:async()=>({decision:'conversation',confidence:'high',reason:'private',suggestedResponse:'My dog likes apples.',nextAction:'model'})});
 f.advance(1);await service.receiveTranscript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:'My dog like apples again.',final:true,itemId:'over-cap',contextKey:`${created.id}:${lease.epoch}:1`});
 const current=await service.get(f.owner,created.id);await service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:current.revision,type:'end'});
 const {ClassroomNoteJobs}=await import('../lib/server/classroom-note-jobs');const jobs=new ClassroomNoteJobs(f.pool,{now:f.options.now}),task=await jobs.claim();assert(task);const manifest=await jobs.build(task);assert(manifest);assert.equal(manifest.coverage,'limited_sources');assert.equal(manifest.entries.length,256);
 await jobs.cancel(created.id);const page=await service.notes(f.owner,created.id);assert.equal(page.preparation,'unavailable');assert.equal(page.coverage,'limited_sources');assert.equal(page.entries.length,5);
});

test('legacy consolidation preserves only retained linked sources and never claims capture from the start',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 await f.pool.query('DELETE FROM teeko_classroom_note_state WHERE classroom_id=$1',[created.id]);
 const contextKey=`${created.id}:${lease.epoch}:0`,decision={decision:'conversation',confidence:'high',reason:'PRIVATE_LEGACY_REASON',suggestedResponse:'My dog likes apples.',nextAction:'model'};
 await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:'My dog like apples.',final:true,itemId:'legacy-note',contextKey});
 await f.pool.query('INSERT INTO teeko_teaching_decisions(classroom_id,connection_epoch,item_id,context_key,decision,created_at) VALUES($1,$2,$3,$4,$5,$6)',[created.id,lease.epoch,'legacy-note',contextKey,JSON.stringify(decision),f.options.now()]);
 await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'end'});
 const {ClassroomNoteJobs}=await import('../lib/server/classroom-note-jobs');assert.equal(await new ClassroomNoteJobs(f.pool,{now:f.options.now}).runOne(),'succeeded');
 await f.pool.query('DELETE FROM teeko_classroom_transcripts WHERE classroom_id=$1',[created.id]);await f.pool.query('DELETE FROM teeko_teaching_decisions WHERE classroom_id=$1',[created.id]);
 const page=await f.service.notes(f.owner,created.id);assert.equal(page.coverage,'retained_sources');assert.equal(page.preparation,'ready');assert.equal(page.entries.length,1);assert.equal(page.entries[0].origin.itemId,'legacy-note');assert(!JSON.stringify(page).includes('PRIVATE_LEGACY_REASON'));
});

test('a note completion waiting on the row lock must recheck expiry after acquiring it',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic');await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:created.revision,type:'end'});
 const {ClassroomNoteJobs}=await import('../lib/server/classroom-note-jobs');const jobs=new ClassroomNoteJobs(f.pool,{now:f.options.now}),task=await jobs.claim();assert(task);const manifest=await jobs.build(task);assert(manifest);
 const blocker=await f.pool.connect();let pending:Promise<boolean>|undefined;
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM teeko_classroom_note_jobs WHERE id=$1 FOR UPDATE',[task.id]);pending=jobs.complete(task,manifest);
  const until=Date.now()+2000;for(;;){const waiting=(await f.pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%teeko_classroom_note_jobs%' AND pid<>pg_backend_pid()) AS waiting")).rows[0].waiting;if(waiting)break;assert(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,5));}
  f.advance(30000);await blocker.query('COMMIT');assert.equal(await pending,false);assert.equal((await f.pool.query('SELECT status FROM teeko_classroom_note_jobs WHERE id=$1',[task.id])).rows[0].status,'running');
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending;}
});

test('legacy pagination keeps byte ordering when pending notes become a finalized manifest',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);await f.pool.query('DELETE FROM teeko_classroom_note_state WHERE classroom_id=$1',[created.id]);
 for(const itemId of ['a','B','孩子']){
  const contextKey=`${created.id}:${lease.epoch}:0`;
  await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:'I likes apples.',final:true,itemId,contextKey});
  await f.pool.query('INSERT INTO teeko_teaching_decisions(classroom_id,connection_epoch,item_id,context_key,decision,created_at) VALUES($1,$2,$3,$4,$5,$6)',[created.id,lease.epoch,itemId,contextKey,JSON.stringify({decision:'retry',confidence:'high',reason:'private',suggestedResponse:'I like apples.',nextAction:'model'}),f.options.now()]);
 }
 await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'end'});
 const first=await f.service.notes(f.owner,created.id,{pageSize:1});assert.equal(first.preparation,'pending');assert.equal(first.entries[0].origin.itemId,'孩子');assert(first.nextCursor);
 const pendingSecond=await f.service.notes(f.owner,created.id,{pageSize:1,cursor:first.nextCursor});assert.equal(pendingSecond.entries[0].origin.itemId,'a');assert(pendingSecond.nextCursor);
 const {ClassroomNoteJobs}=await import('../lib/server/classroom-note-jobs');assert.equal(await new ClassroomNoteJobs(f.pool,{now:f.options.now}).runOne(),'succeeded');
 const second=await f.service.notes(f.owner,created.id,{pageSize:1,cursor:first.nextCursor});assert.equal(second.preparation,'ready');assert.equal(second.entries[0].origin.itemId,'a');assert(second.nextCursor);
 const third=await f.service.notes(f.owner,created.id,{pageSize:1,cursor:pendingSecond.nextCursor});assert.equal(third.entries[0].origin.itemId,'B');assert.equal(third.nextCursor,null);
});

test('PG checks scoped highlights against current revision, request binding and authorization',{skip:!database},async t=>{
  const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
  const old=scopedHighlight(lease.snapshot,'old');
  const changed=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'hint'});
  const stale=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'highlight_objects',old.command.arguments,undefined,{actor:'teacher',callId:old.callId,request:old});assert.equal(stale.output.status,'unavailable');
  for(const [field,value] of [['courseVersion','picnic:other'],['connectionEpoch',lease.epoch+1],['pageId','other'],['activityId','other']] as const){
    const fresh=scopedHighlight(changed,`wrong-${field}`),request={...fresh,context:{...fresh.context,[field]:value}};
    const result=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'highlight_objects',fresh.command.arguments,undefined,{actor:'teacher',callId:fresh.callId,request});
    assert.equal(result.output.status,'unavailable');assert.deepEqual(result.snapshot.teacherObjectIds,changed.teacherObjectIds);
  }
  const current=scopedHighlight(changed,'current');
  const mismatched=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'highlight_objects',{contextKey:current.command.arguments.contextKey,objectIds:['banana']},undefined,{actor:'teacher',callId:current.callId,request:current});assert.equal(mismatched.output.status,'unavailable');
  const revoked=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'highlight_objects',current.command.arguments,async()=>false,{actor:'teacher',callId:current.callId,request:current});assert.equal(revoked.output.status,'unavailable');
  const unknown=scopedHighlight(changed,'unknown',['not-in-course']);
  assert.equal((await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'highlight_objects',unknown.command.arguments,undefined,{actor:'teacher',callId:unknown.callId,request:unknown})).output.status,'unavailable');
  const ended=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:changed.revision,type:'end'});
  const late=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'highlight_objects',current.command.arguments,undefined,{actor:'teacher',callId:current.callId,request:current});assert.equal(late.output.status,'unavailable');assert.equal(late.snapshot.status,'ended');assert.equal(late.snapshot.revision,ended.revision);
});
test('real classroom persistence, concurrency, evidence and bounded leases', {skip:!database}, async t=>{
  await t.test('published courses have valid material and a single competing active classroom',async t=>{
    const f=await fixture(t); const catalog=await f.service.courses(f.owner);
    assert.deepEqual(catalog.courses.map(course=>course.id).sort(),['picnic','robot-reading']);
    const results=await Promise.allSettled([f.service.create(f.owner,'picnic'),f.service.create(f.owner,'picnic')]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    const row=(await f.pool.query('SELECT id FROM teeko_classrooms')).rows[0];
    await assert.rejects(f.service.get(f.other,row.id));
    const restarted=new (await import('../lib/server/classroom-service.ts')).ClassroomService(f.pool,f.options);
    assert.equal((await restarted.get(f.owner,row.id)).course.version,'2');
  });
  await t.test('actions are idempotent, stale ones fail, assisted selections never become independent',async t=>{
    const f=await fixture(t); const created=await f.service.create(f.owner,'picnic');
    const lease=await f.service.claim(f.owner,created.id);
    const first=lease.snapshot;
    const hint=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:first.revision,type:'hint'});
    const step=hint.course.steps[hint.stepIndex];
    const action={eventId:randomUUID(),expectedRevision:hint.revision,type:'select' as const,objectIds:[step.targetId!]};
    const answered=await f.service.action(f.owner,created.id,action);
    assert.equal(answered.outcomes[0].status,'assisted');
    assert.equal(answered.stepIndex,1);
    assert.equal((await f.service.action(f.owner,created.id,action)).stepIndex,1);
    await assert.rejects(f.service.action(f.owner,created.id,{...action,eventId:randomUUID()}));
    await f.service.release(f.owner,created.id,lease.epoch,lease.ownerToken);
  });
  await t.test('spoken tools require recent server transcript and do not assess pronunciation',async t=>{
    const f=await fixture(t); const c=await f.service.create(f.owner,'picnic'); const lease=await f.service.claim(f.owner,c.id);
    const selected=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
    const contextKey=`${c.id}:${lease.epoch}:1`;
    const forged=await f.service.tool(f.owner,c.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',{contextKey,answer:'It is an apple.'});
    assert.equal(forged.output.status,'retry'); assert.equal(forged.snapshot.stepIndex,selected.stepIndex);
    await f.service.transcript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey,role:'child',text:'It is an apple.',final:true,itemId:'spoken-one'});
    const actual=await f.service.tool(f.owner,c.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',{contextKey,answer:'It is an apple.'});
    assert.equal(actual.output.status,'confirmed'); assert.equal(actual.snapshot.stepIndex,2);
    assert(!JSON.stringify(actual).includes('pronunciationScore'));
  });
  await t.test('manual ending preserves a checkpoint for a new lesson without reusing its speaking evidence',async t=>{
    const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id);
    const a=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
    await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:a.revision,type:'end'});
    const next=await f.service.create(f.owner,'picnic');assert.equal(next.stepIndex,1);assert.deepEqual(next.outcomes,[]);
  });
  await t.test('a received complete learner answer progresses without depending on a vendor tool call',async t=>{
    const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id);
    await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
    const event={contextKey:`${c.id}:${lease.epoch}:1`,source:'speech' as const,role:'child' as const,text:'It is an apple.',final:false,itemId:'utterance'};
    await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,event);
    assert.equal((await f.service.get(f.owner,c.id)).stepIndex,1);
    await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{...event,final:true});
    assert.equal((await f.service.get(f.owner,c.id)).stepIndex,2);
    await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{...event,final:true});
    assert.equal((await f.service.get(f.owner,c.id)).stepIndex,2);
  });
  await t.test('lease expiry accounts only for its valid interval and stale model context cannot answer a new task',async t=>{
    const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id);
    const selected=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
    await f.service.transcript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey:`${c.id}:${lease.epoch}:1`,role:'child',text:'an apple',final:true,itemId:'a'});
    const stale=await f.service.tool(f.owner,c.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',{contextKey:`${c.id}:${lease.epoch}:0`,answer:'an apple'});
    assert.equal(stale.output.status,'retry');assert.equal(stale.snapshot.stepIndex,selected.stepIndex);
    f.advance(30_000);assert.equal(await f.service.heartbeat(f.owner,c.id,lease.epoch,lease.ownerToken),null);
    const paused=await f.service.get(f.owner,c.id);assert.equal(paused.status,'paused');assert.equal(paused.elapsedSeconds,15);
  });
  await t.test('negative or mixed answers and missing task context never count as correct',async t=>{
    const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id);
    await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
    const contextKey=`${c.id}:${lease.epoch}:1`;
    await f.service.transcript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey,role:'child',text:'Not an apple. It is a banana.',final:true,itemId:'negative'});
    const negative=await f.service.tool(f.owner,c.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',{contextKey,answer:'Not an apple. It is a banana.'});
    assert.equal(negative.output.status,'retry');assert.equal(negative.snapshot.stepIndex,1);
    f.advance(1);
    await f.service.transcript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey,role:'child',text:'an apple',final:true,itemId:'positive'});
    const missing=await f.service.tool(f.owner,c.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',{answer:'an apple'});
    assert.equal(missing.output.status,'retry');assert.equal(missing.snapshot.stepIndex,1);
  });
  await t.test('an explicit completed request to stop pauses instead of demanding the answer again',async t=>{
    const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id);
    await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey:`${c.id}:${lease.epoch}:0`,role:'child',text:'Please stop.',final:true,itemId:'stop'});
    const state=await f.service.get(f.owner,c.id);assert.equal(state.status,'paused');assert.equal(state.outcomes.length,0);
  });
  await t.test('a completed explicit request to skip is respected by the application for either provider',async t=>{
    const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id);
    await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey:`${c.id}:${lease.epoch}:0`,role:'child',text:'Can we skip this?',final:true,itemId:'skip'});
    const state=await f.service.get(f.owner,c.id);assert.equal(state.stepIndex,1);assert.equal(state.outcomes[0].status,'skipped');
  });
  await t.test('stories mentioning a target and next weekend neither answer nor skip an activity',async t=>{
    const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id);
    let state=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
    const contextKey=`${c.id}:${lease.epoch}:1`;
    for(const [index,text] of ['My dog stole an apple yesterday.','Next weekend I will visit my grandma.','Tell me another story.'].entries()){
      f.advance(1);
      await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey,role:'child',text,final:true,itemId:`story-${index}`});
      const result=await f.service.tool(f.owner,c.id,lease.epoch,lease.ownerToken,'delegate',{contextKey});
      assert.equal(result.output.status,'conversation');assert.equal(result.snapshot.stepIndex,1);assert.equal(result.snapshot.outcomes.length,1);
      const attemptedSkip=await f.service.tool(f.owner,c.id,lease.epoch,lease.ownerToken,'skip',{contextKey});
      assert.equal(attemptedSkip.snapshot.stepIndex,1);
    }
    state=await f.service.get(f.owner,c.id);assert.equal(state.status,'active');
    await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey,role:'child',text:'It is an apple.',final:true,itemId:'real-answer'});
    assert.equal((await f.service.get(f.owner,c.id)).stepIndex,2);
  });
  await t.test('new picnic applied expressions lead to open conversation, not automatic hang-up',async t=>{
    const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id);let state=lease.snapshot;
    for(let i=0;i<6;i++)state=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:state.revision,type:'skip'});
    for(const [index,text] of ['I like apples.',"Let's have a picnic!",'I will bring bananas.'].entries()){
      f.advance(1);await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey:`${c.id}:${lease.epoch}:${state.stepIndex}`,role:'child',text,final:true,itemId:`answer-${index}`});
      state=await f.service.get(f.owner,c.id);assert.equal(state.status,'active');assert.equal(state.stepIndex,7+index);
    }
    assert.equal(state.course.steps[state.stepIndex].id,'picnic-chat');
    for(const [index,text] of ['I like strawberries.','I want to tell you about my dog.'].entries()){
      f.advance(1);await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey:`${c.id}:${lease.epoch}:9`,role:'child',text,final:true,itemId:`chat-${index}`});
    }
    state=await f.service.get(f.owner,c.id);assert.equal(state.status,'active');assert.equal(state.stepIndex,9);assert.equal(state.outcomes.length,9);
    await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey:`${c.id}:${lease.epoch}:9`,role:'child',text:'Next.',final:true,itemId:'last-next'});
    const nextTopic=await f.service.tool(f.owner,c.id,lease.epoch,lease.ownerToken,'delegate',{contextKey:`${c.id}:${lease.epoch}:9`});
    assert.equal(nextTopic.snapshot.status,'active');assert.equal(nextTopic.snapshot.stepIndex,9);
    state=await f.service.get(f.owner,c.id);
    state=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:state.revision,type:'next'});
    assert.equal(state.status,'ended');assert.equal(state.endReason,'content_completed');assert.equal(state.outcomes.at(-1)?.status,'unassessed');
  });
  await t.test('publishing v2 keeps an old v1 session and checksum intact without transferring its checkpoint',async t=>{
    const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');
    await f.pool.query("UPDATE teeko_classrooms SET course_version='1' WHERE id=$1",[c.id]);
    const checksum=(await f.pool.query("SELECT checksum FROM teeko_courses WHERE id='picnic' AND version='1'")).rows[0].checksum;
    await (await import('../lib/server/course-catalog.ts')).publishTrialCourses(f.pool);
    assert.equal((await f.pool.query("SELECT checksum FROM teeko_courses WHERE id='picnic' AND version='1'")).rows[0].checksum,checksum);
    const lease=await f.service.claim(f.owner,c.id);assert.equal(lease.snapshot.course.version,'1');assert.equal(lease.snapshot.course.steps.length,7);
    const skipped=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'skip'});
    await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:skipped.revision,type:'end'});
    const v2=await f.service.create(f.owner,'picnic');assert.equal(v2.course.version,'2');assert.equal(v2.stepIndex,0);assert.deepEqual(v2.outcomes,[]);
  });
  await t.test('usage is assigned to actual local calendar intervals and an old classroom cannot bypass a new daily cap',async t=>{
    const f=await fixture(t);f.advance(new Date('2026-11-01T15:59:55Z').getTime()-f.options.now().getTime());
    const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id);
    f.advance(10_000);const state=await f.service.heartbeat(f.owner,c.id,lease.epoch,lease.ownerToken);assert(state);
    const buckets=(await f.pool.query('SELECT day_key,milliseconds FROM teeko_classroom_usage WHERE account_id=$1 ORDER BY day_key',[f.owner])).rows;
    assert.deepEqual(buckets.map(x=>[x.day_key,Number(x.milliseconds)]),[['2026-11-01',5000],['2026-11-02',5000]]);
    await f.service.release(f.owner,c.id,lease.epoch,lease.ownerToken);
    await f.pool.query('UPDATE teeko_classroom_usage SET milliseconds=120000 WHERE account_id=$1 AND day_key=$2',[f.owner,'2026-11-02']);
    await assert.rejects(f.service.claim(f.owner,c.id),error=>!!error&&typeof error==='object'&&'code'in error&&error.code==='DAILY_LIMIT');
  });
  await t.test('pause settles elapsed time; expired/revoked leases and ended classes cannot revive',async t=>{
    const f=await fixture(t); const c=await f.service.create(f.owner,'picnic'); const lease=await f.service.claim(f.owner,c.id);
    await assert.rejects(f.service.claim(f.owner,c.id));
    f.advance(11_000);
    const paused=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'pause'});
    assert.equal(paused.elapsedSeconds,11);
    assert.equal(await f.service.heartbeat(f.owner,c.id,lease.epoch,lease.ownerToken),null);
    const resumed=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:paused.revision,type:'resume'});
    const next=await f.service.claim(f.owner,c.id);
    assert(next.epoch>lease.epoch); assert.equal(next.snapshot.elapsedSeconds,11);
    for(let i=0;i<4;i++){f.advance(10_000);assert(await f.service.heartbeat(f.owner,c.id,next.epoch,next.ownerToken));}
    f.advance(10_000);assert.equal(await f.service.heartbeat(f.owner,c.id,next.epoch,next.ownerToken),null);
    const ended=await f.service.get(f.owner,c.id);
    assert.equal(ended.status,'ended'); assert.equal(ended.endReason,'time_limit'); assert.equal(ended.elapsedSeconds,60);
    await assert.rejects(f.service.claim(f.owner,c.id));
    assert.equal(resumed.status,'preflight');
  });
  await t.test('all steps can be skipped without claiming mastery and daily consumption survives new classes',async t=>{
    const f=await fixture(t); let c=await f.service.create(f.owner,'picnic'); const lease=await f.service.claim(f.owner,c.id); c=lease.snapshot;
    while(c.status!=='ended') c=await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:c.revision,type:'skip'});
    assert.equal(c.endReason,'content_completed'); assert(c.outcomes.every(x=>x.status==='skipped'));
    assert.equal((await f.service.courses(f.owner)).courses[0].progress.completed,true);
    const other=await f.service.create(f.owner,'picnic'); const a=await f.service.claim(f.owner,other.id);
    for(let i=0;i<6;i++){f.advance(10_000);await f.service.heartbeat(f.owner,other.id,a.epoch,a.ownerToken);}
    const last=await f.service.create(f.owner,'picnic'); const b=await f.service.claim(f.owner,last.id);
    for(let i=0;i<6;i++){f.advance(10_000);await f.service.heartbeat(f.owner,last.id,b.epoch,b.ownerToken);}
    await assert.rejects(f.service.create(f.owner,'picnic'));
  });
});

test('completed explicit annotation requests execute without depending on a realtime model tool call',{skip:!database},async t=>{
 const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id),contextKey=`${c.id}:${lease.epoch}:0`;
 const event={contextKey,role:'child' as const,source:'speech' as const,text:'Could you please draw a circle around the apple?',final:true,itemId:'draw-apple'};
 await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,event);
 const first=await f.service.get(f.owner,c.id);assert.equal((await f.service.courses(f.owner)).activeClassroom?.provider,'qwen');assert.deepEqual(first.teacherObjectIds,['apple']);assert.equal(first.stepIndex,0);assert.equal(first.outcomes.length,0);
 assert.equal((await f.service.teacherRuntime(f.owner,c.id)).state.hints['find-apple'],1);
 await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,event);
 const duplicate=await f.service.get(f.owner,c.id);assert.equal(duplicate.revision,first.revision);assert.deepEqual(duplicate.teacherObjectIds,['apple']);
 await f.service.tool(f.owner,c.id,lease.epoch,lease.ownerToken,'highlight_objects',{contextKey,objectIds:['apple']});
 assert.equal((await f.service.teacherRuntime(f.owner,c.id)).state.hints['find-apple'],1);
});
test('teacher tap requests visibly highlight without answering on behalf of the learner',{skip:!database},async t=>{
 const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id),contextKey=`${c.id}:${lease.epoch}:0`;
 for(const [index,text] of ['Can you tap the banana?','请帮我点一下苹果。'].entries()){
  f.advance(1);await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey,role:'child',text,final:true,itemId:`tap-request-${index}`});
  const state=await f.service.get(f.owner,c.id);assert.deepEqual(state.teacherObjectIds,[index===0?'banana':'apple']);assert.equal(state.stepIndex,0);assert.deepEqual(state.outcomes,[]);
 }
});
test('ambiguous, negative and narrative references never highlight or complete a task',{skip:!database},async t=>{
 const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id),contextKey=`${c.id}:${lease.epoch}:0`;
 for(const [index,text] of ['Do not circle the apple.','I circled the apple yesterday.','Circle this.','Could you circle the apple or banana?','请不要圈苹果。'].entries()){
  f.advance(1);await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{contextKey,role:'child',text,final:true,itemId:`not-command-${index}`});
 }
 const state=await f.service.get(f.owner,c.id);assert.deepEqual(state.teacherObjectIds,[]);assert.equal(state.stepIndex,0);assert.equal(state.outcomes.length,0);
});
test('annotation execution rechecks a newer input, caller authorization and connection generation',{skip:!database},async t=>{
 const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id),contextKey=`${c.id}:${lease.epoch}:0`;
 const first={contextKey,role:'child' as const,text:'Circle the apple.',final:true,itemId:'older-request'};
 await f.service.transcript(f.owner,c.id,lease.epoch,lease.ownerToken,first);f.advance(1);
 await f.service.transcript(f.owner,c.id,lease.epoch,lease.ownerToken,{...first,text:'I want to talk about my dog.',itemId:'newer-topic'});
 await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,first);
 assert.deepEqual((await f.service.get(f.owner,c.id)).teacherObjectIds,[]);
 await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{...first,itemId:'revoked-request'},async()=>false);
 assert.deepEqual((await f.service.get(f.owner,c.id)).teacherObjectIds,[]);
 await f.service.release(f.owner,c.id,lease.epoch,lease.ownerToken);
 const paused=await f.service.get(f.owner,c.id);await f.service.action(f.owner,c.id,{eventId:randomUUID(),expectedRevision:paused.revision,type:'resume'});
 const next=await f.service.claim(f.owner,c.id);
 await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{...first,itemId:'stale-epoch'});
 const state=await f.service.get(f.owner,c.id);assert.equal(state.connectionEpoch,next.epoch);assert.deepEqual(state.teacherObjectIds,[]);assert.equal(state.stepIndex,0);
});


test('an old annotation cannot replace the latest already-consumed annotation',{skip:!database},async t=>{
 const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id),contextKey=`${c.id}:${lease.epoch}:0`;
 const old={contextKey,role:'child' as const,text:'Circle the apple.',final:true,itemId:'old-apple'};
 await f.service.transcript(f.owner,c.id,lease.epoch,lease.ownerToken,old);f.advance(1);
 await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{...old,text:'Circle the banana.',itemId:'new-banana'});
 const marked=await f.service.get(f.owner,c.id);assert.deepEqual(marked.teacherObjectIds,['banana']);
 await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,old);
 const after=await f.service.get(f.owner,c.id);assert.deepEqual(after.teacherObjectIds,['banana']);assert.equal(after.revision,marked.revision);
});


test('a duplicate final item cannot replace persisted story evidence with an annotation command',{skip:!database},async t=>{
 const f=await fixture(t);const c=await f.service.create(f.owner,'picnic');const lease=await f.service.claim(f.owner,c.id),contextKey=`${c.id}:${lease.epoch}:0`;
 const event={contextKey,role:'child' as const,text:'My dog likes apples.',final:true,itemId:'same-final-id'};
 await f.service.transcript(f.owner,c.id,lease.epoch,lease.ownerToken,event);
 await f.service.receiveTranscript(f.owner,c.id,lease.epoch,lease.ownerToken,{...event,text:'Circle the apple.'});
 const state=await f.service.get(f.owner,c.id);assert.deepEqual(state.teacherObjectIds,[]);assert.equal(state.stepIndex,0);assert.equal(state.outcomes.length,0);
});

test('classroom journal preserves complete final turns beyond the rolling teaching evidence without duplicating finals',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id),contextKey=`${created.id}:${lease.epoch}:0`;
 for(let index=0;index<70;index++){
  f.advance(1);await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:`Synthetic learner turn ${index}`,final:true,itemId:`journal-${index}`,contextKey});
 }
 const event={role:'teacher' as const,text:'Hello, what fruit do you like?',final:true,itemId:'teacher-final',contextKey};
 await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,event);await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,event);
 const evidence=await f.pool.query('SELECT count(*)::int count FROM teeko_classroom_transcripts WHERE classroom_id=$1',[created.id]);assert.equal(evidence.rows[0].count,64);
 const journal=await f.pool.query("SELECT actor,text,details FROM teeko_classroom_journal WHERE classroom_id=$1 AND kind='utterance' ORDER BY id",[created.id]);
 assert.equal(journal.rowCount,71);assert.equal(journal.rows[0].text,'Synthetic learner turn 0');assert.equal(journal.rows.at(-1).actor,'teacher');assert.equal(journal.rows.at(-1).details.playback,'generated');
});
test('tool journal distinguishes application fallback from model requests and records actual confirmed or stale results',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id),contextKey=`${created.id}:${lease.epoch}:0`;
 await f.service.receiveTranscript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:'Please tap the banana.',final:true,itemId:'journal-tap',contextKey});
 await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'highlight_objects',{contextKey,objectIds:['apple'],apiKey:'never-store-fixture-key',image:'never-store-fixture-pixels'},undefined,{actor:'teacher',callId:'model-call'});
 await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'highlight_objects',{contextKey:`${created.id}:999:0`,objectIds:['apple']},undefined,{actor:'teacher',callId:'stale-call'});
 const logs=(await f.pool.query("SELECT actor,status,correlation_id,details FROM teeko_classroom_journal WHERE classroom_id=$1 AND kind='tool' ORDER BY id",[created.id])).rows;
 assert(logs.some(row=>row.actor==='application'&&row.status==='confirmed'&&row.details.highlighted?.includes('banana')));
 assert.deepEqual(logs.filter(row=>row.correlation_id==='model-call').map(row=>row.status),['requested','confirmed']);
 assert.deepEqual(logs.filter(row=>row.correlation_id==='stale-call').map(row=>row.status),['requested','rejected']);
 assert(!JSON.stringify(logs).includes('never-store-fixture'));assert.equal((await f.service.get(f.owner,created.id)).outcomes.length,0);
});
test('authenticated journal capture rejects obsolete child actions while preserving generated historical teacher text',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id),oldKey=`${created.id}:${lease.epoch}:0`;
 await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
 const note={eventKey:'late-teacher',kind:'utterance' as const,actor:'teacher' as const,status:'recorded' as const,name:'teacher_speech',text:'That was the apple.',details:{contextKey:oldKey,boundary:'application_segment' as const,playback:'generated' as const}};
 assert.equal(await f.service.journal(f.owner,created.id,lease.epoch,lease.ownerToken,note),true);
 assert.equal(await f.service.journal(f.owner,created.id,lease.epoch,lease.ownerToken,{...note,eventKey:'stale-draw',kind:'interaction',actor:'child',name:'annotation',text:undefined}),false);
 assert.equal(await f.service.journal(f.owner,created.id,lease.epoch,'invalid-owner-token',{...note,eventKey:'revoked'}),false);
 await assert.rejects(f.service.journal(f.other,created.id,lease.epoch,lease.ownerToken,note));
 const logs=(await f.pool.query('SELECT kind,name,step_index FROM teeko_classroom_journal WHERE classroom_id=$1',[created.id])).rows;
 assert(logs.some(row=>row.name==='teacher_speech'&&row.step_index===0));assert(!logs.some(row=>row.name==='annotation'));
});
test('GPT input journal describes an application segment rather than inventing a provider final event',{skip:!database},async t=>{
 const f=await fixture(t);await f.service.savePreferences(f.owner,{provider:'openai',language:'english',style:'gentle',voice:'female',soundEffects:false});
 const created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:'Hello.',final:true,itemId:'gpt-complete',contextKey:`${created.id}:${lease.epoch}:0`,source:'speech'});
 const log=(await f.pool.query("SELECT details FROM teeko_classroom_journal WHERE classroom_id=$1 AND kind='utterance'",[created.id])).rows[0];assert.equal(log.details.boundary,'application_segment');
});
test('revoked authorization and old leases cannot append tool payloads into a newer classroom journal',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id),contextKey=`${created.id}:${lease.epoch}:0`;
 const before=Number((await f.pool.query('SELECT count(*) count FROM teeko_classroom_journal WHERE classroom_id=$1',[created.id])).rows[0].count);
 await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',{contextKey,answer:'revoked-payload'},async()=>false);
 assert.equal(Number((await f.pool.query('SELECT count(*) count FROM teeko_classroom_journal WHERE classroom_id=$1',[created.id])).rows[0].count),before);
 await f.service.release(f.owner,created.id,lease.epoch,lease.ownerToken);const state=await f.service.get(f.owner,created.id);
 await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:state.revision,type:'resume'});await f.service.claim(f.owner,created.id);
 const next=Number((await f.pool.query('SELECT count(*) count FROM teeko_classroom_journal WHERE classroom_id=$1',[created.id])).rows[0].count);
 await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',{contextKey,answer:'old-lease-payload'});
 assert.equal(Number((await f.pool.query('SELECT count(*) count FROM teeko_classroom_journal WHERE classroom_id=$1',[created.id])).rows[0].count),next);
});
test('pause events do not inherit the previous correct-answer feedback',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 const selected=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
 await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:selected.revision,type:'pause'});
 const logs=(await f.pool.query("SELECT name,details FROM teeko_classroom_journal WHERE classroom_id=$1 AND kind='interaction' ORDER BY id",[created.id])).rows;
 assert.equal(logs.find(row=>row.name==='select').details.feedbackKind,'correct');assert.equal(logs.find(row=>row.name==='pause').details.feedbackKind,undefined);
});

function scopedInspection(snapshot:ClassroomSnapshot,callId:string){
 const captured=captureClassroomToolState(snapshot);assert(captured.ok);
 const checked=validateClassroomToolRequest(captured.snapshot,{type:'tool.requested',id:randomUUID(),receivedAtMs:Date.now(),source:'teacher',callId,context:captured.snapshot.context,command:{name:'inspect_current_page',arguments:{contextKey:`${snapshot.id}:${snapshot.connectionEpoch}:${snapshot.stepIndex}`,question:'What did I draw?'}}});assert(checked.accepted);return checked.request;
}
test('scoped inspection validates its request without grading, hint credit or PG visual storage',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id),request=scopedInspection(lease.snapshot,'scoped-inspect');
 const result=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'inspect_current_page',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});
 assert.equal(result.output.status,'unavailable');assert.match(result.output.english??'',/unknown marks/);assert.equal(result.snapshot.revision,lease.snapshot.revision);assert.deepEqual(result.snapshot.outcomes,[]);assert.deepEqual(result.snapshot.teacherObjectIds,[]);
 const row=(await f.pool.query('SELECT teaching_state,helped_steps FROM teeko_classrooms WHERE id=$1',[created.id])).rows[0];assert.equal(row.teaching_state.hints?.['find-apple']??0,0);assert.deepEqual(row.helped_steps,[]);
 const logs=(await f.pool.query('SELECT details FROM teeko_classroom_journal WHERE classroom_id=$1',[created.id])).rows;assert(logs.every(row=>!('request' in row.details)&&!('image' in row.details)));
});
test('PG refuses stale, swapped and revoked scoped inspection proposals',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id),old=scopedInspection(lease.snapshot,'old-inspect');
 const changed=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'hint'});
 const stale=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'inspect_current_page',old.command.arguments,undefined,{actor:'teacher',callId:old.callId,request:old});assert.match(stale.output.english??'',/no longer valid/);
 const fresh=scopedInspection(changed,'fresh-inspect');
 for(const request of [{...fresh,context:{...fresh.context,pageId:'other'}},{...fresh,source:'application' as const},{...fresh,callId:'swapped'}]){
  const result=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'inspect_current_page',fresh.command.arguments,undefined,{actor:'teacher',callId:fresh.callId,request});assert.match(result.output.english??'',/no longer valid/);
 }
 const swapped=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'inspect_current_page',{...fresh.command.arguments,question:'A different question'},undefined,{actor:'teacher',callId:fresh.callId,request:fresh});assert.match(swapped.output.english??'',/no longer valid/);
 const revoked=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'inspect_current_page',fresh.command.arguments,async()=>false,{actor:'teacher',callId:fresh.callId,request:fresh});assert.equal(revoked.output.status,'unavailable');
 await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:changed.revision,type:'end'});const ended=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'inspect_current_page',fresh.command.arguments,undefined,{actor:'teacher',callId:fresh.callId,request:fresh});assert.equal(ended.output.status,'unavailable');assert.equal(ended.snapshot.status,'ended');
});

function scopedSpoken(snapshot:ClassroomSnapshot,callId:string){
 const captured=captureClassroomToolState(snapshot);assert(captured.ok);const checked=validateClassroomToolRequest(captured.snapshot,{type:'tool.requested',id:randomUUID(),receivedAtMs:Date.now(),source:'teacher',callId,context:captured.snapshot.context,command:{name:'submit_spoken_answer',arguments:{contextKey:`${snapshot.id}:${snapshot.connectionEpoch}:${snapshot.stepIndex}`,answer:'It is an apple.'}}});assert(checked.accepted);return checked.request;
}
test('PG returns a request-bound advance receipt only for a verified scoped spoken completion',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 const selected=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});const request=scopedSpoken(selected,'spoken-receipt');
 const noEvidence=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});assert.equal(noEvidence.output.status,'retry');assert(!('execution' in noEvidence));
 await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{contextKey:request.command.arguments.contextKey,role:'child',text:'It is an apple.',final:true,itemId:'scoped-spoken-evidence'});
 const actual=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});assert.equal(actual.output.status,'confirmed');assert.equal(actual.snapshot.stepIndex,2);
 const after=captureClassroomToolState(actual.snapshot);assert(after.ok);assert('execution' in actual);assert.deepEqual(actual.execution,{type:'tool.advance',requestId:request.id,callId:request.callId,before:request.context,after:after.snapshot.context});
 const repeated=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});assert(!('execution' in repeated));assert.equal(repeated.snapshot.outcomes.filter(o=>o.stepId===request.context.activityId).length,1);
 const logs=(await f.pool.query('SELECT details FROM teeko_classroom_journal WHERE classroom_id=$1',[created.id])).rows;assert(!JSON.stringify(logs).includes('tool.advance'));
});

test('scoped spoken checks precede model work and repeat after a newer revision or revoked authorization',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 const selected=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
 const {teacherConfig}=await import('./teacher-runtime-fixture');await f.pool.query('UPDATE teeko_classrooms SET teacher_config=$2 WHERE id=$1',[created.id,JSON.stringify(teacherConfig)]);
 const {ClassroomService}=await import('../lib/server/classroom-service');let calls=0,release:()=>void=()=>{};
 const service=new ClassroomService(f.pool,{...f.options,assess:async()=>{calls++;await new Promise<void>(resolve=>{release=resolve;});return{decision:'correct',confidence:'high',reason:'The synthetic complete response meets the expression goal.',suggestedResponse:'You said you like apples.',nextAction:'continue_topic'};}});
 const old=scopedSpoken(selected,'old-before-reasoning');await service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{contextKey:old.command.arguments.contextKey,role:'child',text:'It is an apple.',final:true,itemId:'scoped-network-evidence'});
 const changed=await service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:selected.revision,type:'hint'});
 const rejected=await service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',old.command.arguments,undefined,{actor:'teacher',callId:old.callId,request:old});assert.equal(rejected.output.status,'unavailable');assert.equal(calls,0);
 const fresh=scopedSpoken(changed,'current-before-reasoning');let authorizationChecks=0;
 const revoked=await service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',fresh.command.arguments,async()=>++authorizationChecks!==1,{actor:'teacher',callId:fresh.callId,request:fresh});assert.equal(revoked.output.status,'unavailable');assert.equal(calls,0);
 const pending=service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'submit_spoken_answer',fresh.command.arguments,undefined,{actor:'teacher',callId:fresh.callId,request:fresh});
 try{
  const until=Date.now()+2000;while(!calls){assert(Date.now()<until,'Synthetic assessment was not invoked.');await new Promise(resolve=>setTimeout(resolve,5));}
  await service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:changed.revision,type:'hint'});release();const result=await pending;assert.equal(result.output.status,'unavailable');assert(!('execution' in result));assert.equal(result.snapshot.stepIndex,1);assert.equal(result.snapshot.outcomes.length,1);
 }finally{release();await pending;}
});

test('selection normalization refuses injected authority while preserving ambiguous feedback and valid follow-up',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 const injected={eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select' as const,objectIds:['apple'],correct:true};
 const rejected=await f.service.action(f.owner,created.id,injected);assert.equal(rejected.feedback?.kind,'ambiguous');assert.equal(rejected.stepIndex,0);assert.deepEqual(rejected.outcomes,[]);
 const accepted=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:rejected.revision,type:'select',objectIds:['apple']});assert.equal(accepted.feedback?.kind,'correct');assert.equal(accepted.stepIndex,1);assert.equal(accepted.outcomes.length,1);
});

function scopedDelegation(snapshot:ClassroomSnapshot,callId:string,evidenceItemId:string){
 const captured=captureClassroomToolState(snapshot);assert(captured.ok);const checked=validateClassroomToolRequest(captured.snapshot,{type:'tool.requested',id:randomUUID(),receivedAtMs:Date.now(),source:'application',callId,context:captured.snapshot.context,command:{name:'delegate',arguments:{contextKey:`${snapshot.id}:${snapshot.connectionEpoch}:${snapshot.stepIndex}`,evidenceItemId}}});assert(checked.accepted);return checked.request;
}
test('scoped GPT delegation uses only the bound persisted input for conversation, highlights, assessment and skipping',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 let state=lease.snapshot;
 const apply=async(text:string,itemId:string)=>{
  const request=scopedDelegation(state,`delegate-${itemId}`,itemId);await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{contextKey:request.command.arguments.contextKey,role:'child',source:'typed',text,final:true,itemId});
  const result=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'delegate',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});state=result.snapshot;return{request,result};
 };
 const chat=await apply('My dog likes apples.','delegate-chat');assert.equal(chat.result.output.status,'conversation');assert.equal(state.stepIndex,0);assert.deepEqual(state.outcomes,[]);
 f.advance(1);const shown=await apply('Please circle the apple.','delegate-show');assert.equal(shown.result.output.status,'confirmed');assert.deepEqual(state.teacherObjectIds,['apple']);assert.equal(state.outcomes.length,0);assert(!shown.result.execution);
 state=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:state.revision,type:'select',objectIds:['apple']});f.advance(1);
 const answered=await apply('It is an apple.','delegate-answer');assert.equal(answered.result.output.status,'confirmed');assert.equal(state.stepIndex,2);assert.equal(answered.result.execution?.requestId,answered.request.id);assert.equal(answered.result.execution?.before.activityId,answered.request.context.activityId);
 f.advance(1);const skipped=await apply('Please skip this.','delegate-skip');assert.equal(skipped.result.output.status,'confirmed');assert.equal(state.stepIndex,3);assert.equal(state.outcomes.at(-1)?.status,'skipped');assert.equal(skipped.result.execution?.requestId,skipped.request.id);
 const logs=(await f.pool.query('SELECT details FROM teeko_classroom_journal WHERE classroom_id=$1',[created.id])).rows;assert(!JSON.stringify(logs).includes('tool.advance'));
});
test('adjacent robot-reading speech segments highlight a known object once without scoring',{skip:!database},async t=>{
 const f=await fixture(t),course=await f.service.create(f.owner,'robot-reading'),lease=await f.service.claim(f.owner,course.id);
 const contextKey=`${course.id}:${lease.epoch}:0`,event={contextKey,role:'child' as const,source:'speech' as const,final:true};
 const apply=async(snapshot:ClassroomSnapshot,itemId:string,callId:string)=>{
  const request=scopedDelegation(snapshot,callId,itemId);
  return f.service.tool(f.owner,course.id,lease.epoch,lease.ownerToken,'delegate',request.command.arguments,undefined,{actor:'application',callId,request});
 };
 await f.service.transcript(f.owner,course.id,lease.epoch,lease.ownerToken,{...event,itemId:'circle-cue',text:'Um. Can you circle?'});
 const cue=await apply(lease.snapshot,'circle-cue','circle-cue-call');
 assert.equal(cue.output.status,'conversation');assert.match(cue.output.english??'',/which visible textbook object/);assert.deepEqual(cue.snapshot.teacherObjectIds,[]);
 f.advance(2100);
 await f.service.transcript(f.owner,course.id,lease.epoch,lease.ownerToken,{...event,itemId:'circle-target',text:'The wings for me.'});
 const marked=await apply(cue.snapshot,'circle-target','circle-target-call');
 assert.equal(marked.output.status,'confirmed');assert.deepEqual(marked.output.highlighted,['wings']);
 assert.deepEqual(marked.snapshot.teacherObjectIds,['wings']);assert.equal(marked.snapshot.stepIndex,0);assert.deepEqual(marked.snapshot.outcomes,[]);assert.equal(marked.execution,undefined);
 const used=(await f.pool.query('SELECT consumed FROM teeko_classroom_transcripts WHERE classroom_id=$1 AND role=$2',[course.id,'child'])).rows;
 assert.deepEqual(used,[{consumed:true},{consumed:true}]);
 const duplicate=await apply(marked.snapshot,'circle-target','circle-target-retry');assert.equal(duplicate.output.status,'unavailable');assert.equal(duplicate.snapshot.revision,marked.snapshot.revision);
});
test('direct final transcript intake can complete an adjacent segment without a vendor tool',{skip:!database},async t=>{
 const f=await fixture(t),course=await f.service.create(f.owner,'robot-reading'),lease=await f.service.claim(f.owner,course.id);
 const event={contextKey:`${course.id}:${lease.epoch}:0`,role:'child' as const,final:true};
 await f.service.receiveTranscript(f.owner,course.id,lease.epoch,lease.ownerToken,{...event,itemId:'circle-cue',text:'请帮我圈一下。'});
 f.advance(500);
 await f.service.receiveTranscript(f.owner,course.id,lease.epoch,lease.ownerToken,{...event,itemId:'circle-target',text:'尾部。'});
 const marked=await f.service.get(f.owner,course.id);assert.deepEqual(marked.teacherObjectIds,['tail']);assert.equal(marked.stepIndex,0);assert.deepEqual(marked.outcomes,[]);
});
test('split highlight never crosses age, intervention, source, or lesson context and asks about unknown targets',{skip:!database},async t=>{
 const f=await fixture(t),course=await f.service.create(f.owner,'robot-reading'),lease=await f.service.claim(f.owner,course.id);
 let state=lease.snapshot;
 const write=async(text:string,source:'speech'|'typed'='speech',delay=1)=>{
  const itemId=randomUUID();f.advance(delay);
  await f.service.transcript(f.owner,course.id,lease.epoch,lease.ownerToken,{contextKey:`${course.id}:${lease.epoch}:${state.stepIndex}`,role:'child',final:true,text,itemId,source});
  return itemId;
 };
 const apply=async(itemId:string)=>{
  const callId=randomUUID(),request=scopedDelegation(state,callId,itemId),result=await f.service.tool(f.owner,course.id,lease.epoch,lease.ownerToken,'delegate',request.command.arguments,undefined,{actor:'application',callId,request});
  state=result.snapshot;assert.deepEqual(state.teacherObjectIds,[]);return result;
 };
 await write('Could you circle?');const unknown=await apply(await write('The plane for me.'));
 assert.equal(unknown.output.status,'conversation');assert.match(unknown.output.english??'',/which visible textbook object/);
 await write('Can you circle?');await apply(await write('The wings for me.','speech',5001));
 await write('Can you circle?');await write('My dog likes airplanes.');await apply(await write('The wings for me.'));
 await write('Can you circle?','typed');await apply(await write('The wings for me.'));
 await write('Can you circle?');await apply(await write('The wings for me.','typed'));
 await write('Can you circle?');f.advance(1);
 const scope=captureClassroomToolState(state);assert(scope.ok);
 const pointed=await f.service.point(f.owner,course.id,lease.epoch,lease.ownerToken,{type:'interaction.point',eventId:randomUUID(),objectId:'body',context:scope.snapshot.context});
 assert.equal(pointed.accepted,true);state=pointed.snapshot;
 await apply(await write('The wings for me.'));
 await write('Can you circle?');
 state=await f.service.action(f.owner,course.id,{eventId:randomUUID(),expectedRevision:state.revision,type:'next'});
 await apply(await write('The wings for me.'));
 assert.equal(state.stepIndex,1);assert.equal(state.outcomes.length,1);
});
test('PG rejects scoped GPT delegation with stale, replaced, mismatched or injected evidence',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id),request=scopedDelegation(lease.snapshot,'delegation-evidence','first-input');
 await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{contextKey:request.command.arguments.contextKey,role:'child',text:'Circle the apple.',final:true,itemId:'first-input'});f.advance(1);
 await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{contextKey:request.command.arguments.contextKey,role:'child',text:'My dog is funny.',final:true,itemId:'newer-input'});
 const apply=(args:unknown,proposed=request,callId=request.callId)=>f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'delegate',args,undefined,{actor:'teacher',callId,request:proposed});
 assert.equal((await apply(request.command.arguments)).output.status,'unavailable');
 const fresh=scopedDelegation(lease.snapshot,'fresh-delegation','newer-input');
 for(const extra of [{answer:'Apple.'},{history:[]},{score:100}])assert.equal((await apply({...fresh.command.arguments,...extra},fresh,fresh.callId)).output.status,'unavailable');
 assert.equal((await apply(fresh.command.arguments,fresh,'other-call')).output.status,'unavailable');assert.equal((await apply({...fresh.command.arguments,evidenceItemId:'first-input'},fresh,fresh.callId)).output.status,'unavailable');
 const changed=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'hint'});
 assert.equal((await apply(fresh.command.arguments,fresh,fresh.callId)).output.status,'unavailable');assert.deepEqual((await f.service.get(f.owner,created.id)).outcomes,[]);assert.equal(changed.stepIndex,0);
});

test('PG accepts only a bound chalk proposal without claiming display, retaining its text or changing learning evidence',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id),scope=captureClassroomToolState(lease.snapshot);assert(scope.ok);
 const command={name:'chalk_write',arguments:{contextKey:`${created.id}:${lease.epoch}:0`,text:'A temporary apple sentence.',seconds:8}};
 const captured=validateClassroomToolRequest(scope.snapshot,{type:'tool.requested',id:randomUUID(),receivedAtMs:Date.now(),source:'teacher',callId:'chalk-pg',context:scope.snapshot.context,command});assert(captured.accepted);const request=captured.request;
 const result=await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,command.name,command.arguments,undefined,{actor:'teacher',callId:request.callId,request});
 assert.equal(result.output.status,'reference');assert.equal(result.execution,undefined);assert.deepEqual(result.snapshot.outcomes,lease.snapshot.outcomes);assert.deepEqual(result.snapshot.teacherObjectIds,[]);assert.equal(result.snapshot.revision,lease.snapshot.revision);assert.equal(result.snapshot.feedback,null);
 const apply=(args:unknown,proposed:unknown=request,authorize:()=>Promise<boolean>=async()=>true)=>f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,command.name,args,authorize,{actor:'teacher',callId:request.callId,request:proposed as typeof request});
 assert.equal((await apply({...command.arguments,score:100})).output.status,'unavailable');assert.equal((await f.service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,command.name,command.arguments,undefined,{actor:'teacher',callId:request.callId})).output.status,'unavailable');assert.equal((await apply(command.arguments,request,async()=>false)).output.status,'unavailable');
 const changed=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'hint'});assert.equal((await apply(command.arguments)).output.status,'unavailable');assert.equal(changed.stepIndex,0);
});

test('lesson notes require the owner and an ended classroom and page only linked saved expression references',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 await assert.rejects(f.service.notes(f.owner,created.id),{code:'NOT_READY'});
 const decision={decision:'conversation',confidence:'high',reason:'HIDDEN_REASON',suggestedResponse:'Your brother likes dinosaurs.',nextAction:'model'};
 for(const itemId of ['note-a','note-b','note-c']){
  await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:`My brother like dinosaurs. ${itemId}`,final:true,itemId,contextKey:`${created.id}:${lease.epoch}:0`,source:'speech'});
  await f.pool.query('INSERT INTO teeko_teaching_decisions(classroom_id,connection_epoch,item_id,context_key,decision,created_at) VALUES($1,$2,$3,$4,$5,$6)',[created.id,lease.epoch,itemId,`${created.id}:${lease.epoch}:0`,decision,f.options.now()]);
 }
 await f.pool.query('INSERT INTO teeko_teaching_decisions(classroom_id,connection_epoch,item_id,context_key,decision,created_at) VALUES($1,$2,$3,$4,$5,$6)',[created.id,lease.epoch,'unlinked',`${created.id}:${lease.epoch}:0`,decision,f.options.now()]);
 const latest=await f.service.get(f.owner,created.id);await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:latest.revision,type:'end'});
 const entries:unknown[]=[],ids:string[]=[];let cursor:string|undefined;
 do{const page=await f.service.notes(f.owner,created.id,{pageSize:1,...(cursor?{cursor}:{})});assert.equal(page.classroomId,created.id);assert.equal(page.courseVersion,`${created.course.id}:${created.course.version}`);assert(page.entries.length<=1);entries.push(...page.entries);ids.push(...page.entries.map(entry=>entry.origin.itemId));cursor=page.nextCursor??undefined;}while(cursor);
 assert.deepEqual(ids,['note-c','note-b','note-a']);assert(!JSON.stringify(entries).includes('HIDDEN_REASON'));assert(!JSON.stringify(entries).includes('unlinked'));assert.deepEqual((await f.service.get(f.owner,created.id)).outcomes,[]);
 await assert.rejects(f.service.notes(f.other,created.id),{code:'NOT_FOUND'});await assert.rejects(f.service.notes(f.owner,created.id,{cursor:'bad'}),{code:'INVALID_INPUT'});
});
test('lesson notes do not fill missing source or promote uncertain, stale or hidden metadata into cards',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id),base={decision:'conversation',confidence:'high',reason:'PRIVATE_REASON',suggestedResponse:'A useful expression.',nextAction:'model'};
 for(const [itemId,changes,context] of [['low',{confidence:'low'},`${created.id}:1:0`],['wrong-task',{},'other:1:0'],['hidden-field',{score:100},`${created.id}:1:0`]] as const){
  await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:'A saved input.',final:true,itemId,contextKey:`${created.id}:1:0`});
  await f.pool.query('INSERT INTO teeko_teaching_decisions(classroom_id,connection_epoch,item_id,context_key,decision,created_at) VALUES($1,$2,$3,$4,$5,$6)',[created.id,lease.epoch,itemId,context,{...base,...changes},f.options.now()]);
 }
 const latest=await f.service.get(f.owner,created.id);await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:latest.revision,type:'end'});
 const page=await f.service.notes(f.owner,created.id);assert.deepEqual(page.entries,[]);assert.equal(page.nextCursor,null);assert(!JSON.stringify(page).includes('PRIVATE_REASON'));
});

test('notes pagination preserves sub-millisecond ordering and scans past an invalid newest source',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id),base={decision:'conversation',confidence:'high',reason:'PRIVATE_REASON',suggestedResponse:'A useful expression.',nextAction:'model'};
 for(const [itemId,at,extra] of [['bad','2026-11-01T01:00:00.000900Z',{score:100}],['newer','2026-11-01T01:00:00.000800Z',{}],['older','2026-11-01T01:00:00.000700Z',{}]] as const){
  await f.service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',text:'A saved phrase.',final:true,itemId,contextKey:`${created.id}:1:0`});
  await f.pool.query('INSERT INTO teeko_teaching_decisions(classroom_id,connection_epoch,item_id,context_key,decision,created_at) VALUES($1,$2,$3,$4,$5,$6)',[created.id,lease.epoch,itemId,`${created.id}:1:0`,{...base,...extra},at]);
 }
 f.advance(1000);const latest=await f.service.get(f.owner,created.id);await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:latest.revision,type:'end'});
 const first=await f.service.notes(f.owner,created.id,{pageSize:1});assert.deepEqual(first.entries,[]);assert(first.nextCursor);
 const second=await f.service.notes(f.owner,created.id,{pageSize:1,cursor:first.nextCursor});assert.deepEqual(second.entries.map(note=>note.origin.itemId),['newer']);assert(second.nextCursor);
 const third=await f.service.notes(f.owner,created.id,{pageSize:1,cursor:second.nextCursor});assert.deepEqual(third.entries.map(note=>note.origin.itemId),['older']);assert.equal(third.nextCursor,null);
});

test('GPT chalk candidates and execution bind saved supported retries to the latest complete input',{skip:!database},async t=>{
 const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 let state=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
 const {teacherConfig}=await import('./teacher-runtime-fixture');await f.pool.query('UPDATE teeko_classrooms SET teacher_config=$2 WHERE id=$1',[created.id,JSON.stringify(teacherConfig)]);
 const {ClassroomService}=await import('../lib/server/classroom-service');let calls=0;
 const service=new ClassroomService(f.pool,{...f.options,assess:async()=>{calls++;return{decision:'retry',confidence:'high',reason:'private synthetic reason',suggestedResponse:'I like apples.',nextAction:'model'};}});
 let candidate:ClassroomChalkCandidate|undefined;
 for(let i=1;i<=2;i++){
  f.advance(1);const itemId=`chalk-child-${i}`;const request=scopedDelegation(state,`chalk-delegate-${i}`,itemId);
  await service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{contextKey:request.command.arguments.contextKey,role:'child',text:'I not know.',final:true,itemId});
  const result=await service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'delegate',request.command.arguments,undefined,{actor:'teacher',callId:request.callId,request});state=result.snapshot;
  candidate=(result as typeof result&{chalk?:ClassroomChalkCandidate}).chalk;
  if(i===1)assert.equal(candidate,undefined);else assert(candidate);
 }
 assert(candidate);assert.equal(candidate.text,'I like apples.');assert(!JSON.stringify(candidate).includes('private synthetic reason'));assert.equal(calls,2);
 const proposal={type:'tool.requested',id:randomUUID(),receivedAtMs:Date.now(),source:'application',callId:'application-chalk-1',context:candidate.context,command:{name:'chalk_write',arguments:{contextKey:`${created.id}:${lease.epoch}:${state.stepIndex}`,evidenceItemId:candidate.evidenceItemId,text:candidate.text,seconds:8}}};
 const captured=captureClassroomToolState(state);assert(captured.ok);const parsed=validateClassroomToolRequest(captured.snapshot,proposal);assert(parsed.accepted);
 const apply=(request:typeof parsed.request,authorize?:()=>Promise<boolean>)=>service.tool(f.owner,created.id,lease.epoch,lease.ownerToken,'chalk_write',request.command.arguments,authorize,{actor:'teacher',callId:request.callId,request});
 const accepted=await apply(parsed.request);assert.equal(accepted.output.status,'reference');assert.deepEqual(accepted.snapshot.outcomes,state.outcomes);assert.equal(accepted.snapshot.revision,state.revision);
 const originRows=(await f.pool.query("SELECT actor,details->>'source' AS source FROM teeko_classroom_journal WHERE classroom_id=$1 AND name='chalk_write' AND correlation_id='application-chalk-1'",[created.id])).rows;assert.equal(originRows.length,2);assert(originRows.every(row=>row.actor==='application'&&row.source==='application'));
 const changed=validateClassroomToolRequest(captured.snapshot,{...proposal,id:randomUUID(),callId:'changed-reference',command:{...proposal.command,arguments:{...proposal.command.arguments,text:'A made-up reference.'}}});assert(changed.accepted);assert.equal((await apply(changed.request)).output.status,'unavailable');
 assert.equal((await apply(parsed.request,async()=>false)).output.status,'unavailable');
 await service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{contextKey:proposal.command.arguments.contextKey,role:'child',text:'Now another idea.',final:true,itemId:'new-chalk-child'});
 assert.equal((await apply(parsed.request)).output.status,'unavailable');assert.equal(calls,2);
});


test('private chalk candidates read only the latest saved supported input in the exact live scope',{skip:!database},async t=>{
 const signal=new AbortController().signal;const f=await fixture(t),created=await f.service.create(f.owner,'picnic'),lease=await f.service.claim(f.owner,created.id);
 let state=await f.service.action(f.owner,created.id,{eventId:randomUUID(),expectedRevision:lease.snapshot.revision,type:'select',objectIds:['apple']});
 const {teacherConfig}=await import('./teacher-runtime-fixture');await f.pool.query('UPDATE teeko_classrooms SET teacher_config=$2 WHERE id=$1',[created.id,JSON.stringify(teacherConfig)]);
 const {ClassroomService}=await import('../lib/server/classroom-service');let calls=0;
 const service=new ClassroomService(f.pool,{...f.options,assess:async()=>{calls++;return{decision:'retry',confidence:'high',reason:'private fixture reason',suggestedResponse:'I like apples.',nextAction:'model'};}});
 assert.equal(await service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,state,signal),null);
 for(let i=1;i<=2;i++){f.advance(1);await service.receiveTranscript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',source:'speech',text:'I need some help.',final:true,itemId:`private-candidate-${i}`,contextKey:`${created.id}:${lease.epoch}:1`});state=await service.get(f.owner,created.id);if(i===1)assert.equal(await service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,state,signal),null);}
 const locked=await f.pool.connect(),cancel=new AbortController(),readTimer=setTimeout(()=>cancel.abort(),1000);
 try{await locked.query('BEGIN');await locked.query('SELECT id FROM teeko_classrooms WHERE id=$1 FOR UPDATE',[created.id]);assert(await service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,state,cancel.signal));}finally{clearTimeout(readTimer);await locked.query('ROLLBACK');locked.release();}
 const blocked=await f.pool.connect(),blockedCancel=new AbortController(),blockedTimer=setTimeout(()=>blockedCancel.abort(),1000);
 try{await blocked.query('BEGIN');await blocked.query('LOCK TABLE teeko_teaching_decisions IN ACCESS EXCLUSIVE MODE');await assert.rejects(service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,state,blockedCancel.signal),(error:unknown)=>(error as {code?:string}).code==='55P03');assert(await service.heartbeat(f.owner,created.id,lease.epoch,lease.ownerToken));assert(await service.teacherRuntime(f.owner,created.id));}finally{clearTimeout(blockedTimer);await blocked.query('ROLLBACK');blocked.release();}
 const before=(await f.pool.query('SELECT revision,teaching_state,outcomes FROM teeko_classrooms WHERE id=$1',[created.id])).rows[0];
 const candidate=await service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,state,signal);assert(candidate);assert.equal(candidate.evidenceItemId,'private-candidate-2');assert.equal(candidate.text,'I like apples.');assert(!JSON.stringify(candidate).includes('private fixture reason'));assert.equal(await service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,{...state,status:'paused'},signal),null);assert.equal(calls,2);
 assert.deepEqual((await f.pool.query('SELECT revision,teaching_state,outcomes FROM teeko_classrooms WHERE id=$1',[created.id])).rows[0],before);
 assert.equal(await service.readChalkCandidate(f.owner,created.id,lease.epoch,'wrong-owner',state,signal),null);assert.equal(await service.readChalkCandidate(f.owner,created.id,lease.epoch+1,lease.ownerToken,state,signal),null);assert.equal(await service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,{...state,revision:state.revision-1},signal),null);
 assert.equal(await service.readChalkCandidate(f.other,created.id,lease.epoch,lease.ownerToken,state,signal),null);
 await f.pool.query("UPDATE teeko_classroom_transcripts SET consumed=true WHERE classroom_id=$1 AND item_id='private-candidate-2'",[created.id]);assert.equal(await service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,state,signal),null);
 await f.pool.query("UPDATE teeko_classroom_transcripts SET consumed=false,created_at=$2 WHERE classroom_id=$1 AND item_id='private-candidate-2'",[created.id,new Date(f.options.now().getTime()+1)]);assert.equal(await service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,state,signal),null);
 await f.pool.query("UPDATE teeko_classroom_transcripts SET created_at=$2 WHERE classroom_id=$1 AND item_id='private-candidate-2'",[created.id,f.options.now()]);
 const originalLease=(await f.pool.query('SELECT lease_until FROM teeko_classrooms WHERE id=$1',[created.id])).rows[0].lease_until;
 await f.pool.query('UPDATE teeko_classrooms SET lease_until=$2 WHERE id=$1',[created.id,new Date(f.options.now().getTime()-1)]);assert.equal(await service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,state,signal),null);await f.pool.query('UPDATE teeko_classrooms SET lease_until=$2 WHERE id=$1',[created.id,originalLease]);
 await f.pool.query("UPDATE teeko_teaching_decisions SET created_at=$2 WHERE classroom_id=$1 AND item_id='private-candidate-2'",[created.id,new Date(f.options.now().getTime()+1)]);assert.equal(await service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,state,signal),null);await f.pool.query("UPDATE teeko_teaching_decisions SET created_at=$2 WHERE classroom_id=$1 AND item_id='private-candidate-2'",[created.id,f.options.now()]);
 await f.pool.query("UPDATE teeko_classroom_transcripts SET created_at=$2 WHERE classroom_id=$1 AND item_id='private-candidate-2'",[created.id,new Date(f.options.now().getTime()-60001)]);assert.equal(await service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,state,signal),null);await f.pool.query("UPDATE teeko_classroom_transcripts SET created_at=$2 WHERE classroom_id=$1 AND item_id='private-candidate-2'",[created.id,f.options.now()]);
 await service.transcript(f.owner,created.id,lease.epoch,lease.ownerToken,{role:'child',source:'speech',text:'A new unassessed expression.',final:true,itemId:'new-unassessed-private',contextKey:`${created.id}:${lease.epoch}:1`});assert.equal(await service.readChalkCandidate(f.owner,created.id,lease.epoch,lease.ownerToken,state,signal),null);assert.equal(calls,2);
});
