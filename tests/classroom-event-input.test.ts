import test from 'node:test';
import assert from 'node:assert/strict';
import {teacherSnapshot} from './teacher-runtime-fixture';
import {captureClassroomAnnotation,captureClassroomTranscript,captureClassroomSelection,captureClassroomVisualState} from '../lib/classroom-event-input';
const eventId='10000000-0000-4000-8000-000000000001';
const wire=()=>({type:'interaction',eventId,contextKey:`${teacherSnapshot().id}:1:1`,action:'draw',strokeCount:2,pointCount:12});

test('annotation captures authoritative complete scope, server time and fixed provenance without changing wire data',()=>{
 const snapshot=structuredClone(teacherSnapshot()),input=wire(),before=structuredClone(input),result=captureClassroomAnnotation(snapshot,1234,input);assert(result.accepted);
 assert.deepEqual(result.event,{id:eventId,receivedAtMs:1234,type:'annotation.changed',source:'action',context:{logicalSessionId:snapshot.id,courseVersion:'picnic:2',connectionEpoch:1,stateRevision:1,pageId:'picnic-table',activityId:'say-apple'},payload:{action:'draw',strokeCount:2,pointCount:12}});
 assert.deepEqual(input,before);snapshot.revision++;snapshot.course.version='new';input.pointCount=99;assert.equal(result.event.context.stateRevision,1);assert.equal(result.event.context.courseVersion,'picnic:2');assert.equal(result.event.payload.pointCount,12);
 assert(Object.isFrozen(result.event));assert(Object.isFrozen(result.event.context));assert(Object.isFrozen(result.event.payload));
});
for(const input of [null,[],{}, {...wire(),type:'tool.requested'},{...wire(),eventId:'not-an-event'},{...wire(),contextKey:'other:1:1'}, {...wire(),action:'clear'},{...wire(),strokeCount:-1},{...wire(),strokeCount:1001},{...wire(),pointCount:601},{...wire(),pointCount:.5},{...wire(),source:'teacher'},{...wire(),receivedAtMs:0},{...wire(),context:{stateRevision:1}},{...wire(),image:'PRIVATE_IMAGE'},{...wire(),score:100}].map((input,index)=>({input,index})))test(`annotation rejects invalid wire boundary ${input.index} without reflecting input`,()=>{
 assert.deepEqual(captureClassroomAnnotation(teacherSnapshot(),1234,input.input),{accepted:false,reason:'invalid_event'});
});
for(const receivedAtMs of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])test(`annotation rejects invalid server receipt ${String(receivedAtMs)}`,()=>{
 assert.deepEqual(captureClassroomAnnotation(teacherSnapshot(),receivedAtMs,wire()),{accepted:false,reason:'invalid_event'});
});
test('annotation cannot invent scope or accept paused and ended learner operations',()=>{
 for(const status of ['paused','ended','preflight'] as const)assert.equal(captureClassroomAnnotation(teacherSnapshot({status}),1234,wire()).accepted,false);
 for(const field of ['version','page','activity','index'] as const){const snapshot=structuredClone(teacherSnapshot());if(field==='version')snapshot.course.version='v'.repeat(129);else if(field==='page')snapshot.course.pages=[];else if(field==='activity')snapshot.course.steps[1].id='';else snapshot.stepIndex=999;assert.deepEqual(captureClassroomAnnotation(snapshot,1234,wire()),{accepted:false,reason:'invalid_state'});}
});
test('draw and undo preserve existing inclusive count limits',()=>{
 for(const action of ['draw','undo'])for(const [strokeCount,pointCount] of [[0,0],[1000,600]]){
  const result=captureClassroomAnnotation(teacherSnapshot(),0,{...wire(),action,strokeCount,pointCount});assert(result.accepted);assert.deepEqual(result.event.payload,{action,strokeCount,pointCount});
 }
});

const receipt=()=>({id:eventId,receivedAtMs:1234});
const finalInput=()=>({role:'child',text:' I like apples. ',final:true,itemId:'native-final',contextKey:wire().contextKey,source:'speech'});
test('final text preserves provider, application and typed provenance rather than claiming one shared final boundary',()=>{
 for(const provider of ['qwen','openai','grok'] as const){
  const final=captureClassroomTranscript(teacherSnapshot(),receipt(),finalInput(),provider);assert(final.accepted&&final.event.type==='transcript.final'&&final.event.source==='voice');assert.equal(final.event.payload.boundary,provider==='openai'?'application_segment':'provider_final');assert.equal(final.event.payload.text,' I like apples. ');
  const typed=captureClassroomTranscript(teacherSnapshot(),receipt(),{...finalInput(),source:'typed'},provider);assert(typed.accepted&&typed.event.type==='transcript.final'&&typed.event.source==='action');assert.equal(typed.event.payload.input,'typed');assert(!('boundary' in typed.event.payload));
 }
});
test('final text rejects malformed, partial, old and forged metadata without reflecting private content',()=>{
 for(const input of [{...finalInput(),final:false},{...finalInput(),itemId:'x'.repeat(201)},{...finalInput(),text:' '},{...finalInput(),text:'x'.repeat(6001)},{...finalInput(),contextKey:'old'},{...finalInput(),role:'teacher',source:'typed'},{...finalInput(),source:'browser'},{...finalInput(),boundary:'provider_final'},{...finalInput(),image:'PRIVATE_IMAGE'},{...finalInput(),context:{score:100}}])assert.equal(captureClassroomTranscript(teacherSnapshot(),receipt(),input,'openai').accepted,false);
 assert.equal(captureClassroomTranscript(teacherSnapshot(),{id:'native-id',receivedAtMs:1234},finalInput(),'qwen').accepted,false);
});
test('selection captures only an explicit current-revision learner proposal, never correctness',()=>{
 const snapshot=structuredClone(teacherSnapshot()),input={type:'select',eventId,expectedRevision:1,objectIds:['apple']};const result=captureClassroomSelection(snapshot,1234,input);assert(result.accepted&&result.event.type==='selection.committed');assert.equal(result.event.source,'interaction');assert.deepEqual(result.event.payload,{objectIds:['apple']});input.objectIds[0]='banana';snapshot.revision++;assert.deepEqual(result.event.payload,{objectIds:['apple']});assert(Object.isFrozen(result.event.payload.objectIds));
 for(const extra of [{expectedRevision:0},{expectedRevision:2},{objectIds:[]},{objectIds:['x'.repeat(101)]},{type:'hint'},{source:'teacher'},{score:100},{context:{activityId:'other'}}])assert.equal(captureClassroomSelection(teacherSnapshot(),1234,{type:'select',eventId,expectedRevision:1,objectIds:['apple'],...extra}).accepted,false);
});
test('visual state carries only bounded status metadata and never the error body, image or observation',()=>{
 for(const target of ['camera','board'] as const)for(const status of ['off','starting','sharing','error','unavailable']){
  const result=captureClassroomVisualState(teacherSnapshot(),receipt(),target,{status,generation:1,message:'PRIVATE_ERROR_BODY'});assert(result.accepted&&result.event.type==='visual.state');assert.deepEqual(result.event.payload,{target,status,generation:1});assert(!JSON.stringify(result).includes('PRIVATE_ERROR_BODY'));
 }
 for(const input of [{status:'attention',generation:1},{status:'sharing',generation:-1},{status:'sharing',generation:2_000_000_001},{status:'sharing',generation:1,image:'PRIVATE_IMAGE'}])assert.equal(captureClassroomVisualState(teacherSnapshot(),receipt(),'camera',input).accepted,false);
});
test('all remaining input adapters fail closed on invalid or non-active current scope',()=>{
 for(const status of ['preflight','paused','ended'] as const){const snapshot=teacherSnapshot({status});assert.equal(captureClassroomTranscript(snapshot,receipt(),finalInput(),'qwen').accepted,false);assert.equal(captureClassroomSelection(snapshot,1234,{type:'select',eventId,expectedRevision:1,objectIds:['apple']}).accepted,false);assert.equal(captureClassroomVisualState(snapshot,receipt(),'board',{status:'off',generation:1}).accepted,false);}
 const snapshot=structuredClone(teacherSnapshot());snapshot.course.pages=[];assert.deepEqual(captureClassroomTranscript(snapshot,receipt(),finalInput(),'qwen'),{accepted:false,reason:'invalid_state'});
});
