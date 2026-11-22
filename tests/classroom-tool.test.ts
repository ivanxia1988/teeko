import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CLASSROOM_VOICE_TOOLS } from '../lib/voice-instructions';
import * as contract from '../lib/domain/classroom-tool';
const api = () => contract;
const context = () => ({ logicalSessionId: 'lesson-1', courseVersion: 'picnic:2', connectionEpoch: 1, stateRevision: 2, pageId: 'page-1', activityId: 'find-apple' });
const state = () => ({ status: 'active', context: context() });
const command = () => ({ name: 'highlight_objects', arguments: { contextKey: 'lesson-1:1:0', objectIds: ['apple'] } });
const request = () => ({ type: 'tool.requested', id: '06f6a0f8-9747-47b0-957c-93689bbed521', receivedAtMs: 1000, source: 'teacher', callId: 'call-1', context: context(), command: command() });
const result = () => ({ type: 'tool.result', requestId: request().id, callId: 'call-1', context: context(), phase: 'application', output: { status: 'confirmed', highlighted: ['apple'], english: 'The application confirmed the highlight.' } });

test('all three existing tool definitions remain wire-compatible and share one source', () => {
  assert.deepEqual(api().CLASSROOM_TOOL_DEFINITIONS, CLASSROOM_VOICE_TOOLS);
  assert.equal(createHash('sha256').update(JSON.stringify(CLASSROOM_VOICE_TOOLS)).digest('hex'), 'c53af286ea5227a9bd791fc49983ed54970888fc0b25b12e1c06ca009eea9609');
});
test('chalk commands have bounded plain text and duration without granting scoring or execution authority',()=>{
 const command={name:'chalk_write',arguments:{contextKey:'lesson-1:1:0',text:'I like apples.',seconds:8}};
 assert.deepEqual(api().parseClassroomToolCommand(command),{ok:true,command});
 for(const args of [{...command.arguments,seconds:1},{...command.arguments,seconds:21},{...command.arguments,seconds:2.5},{...command.arguments,text:' '},{...command.arguments,text:'x'.repeat(121)},{...command.arguments,text:'a\nb'},{...command.arguments,score:100}])assert.equal(api().parseClassroomToolCommand({...command,arguments:args}).ok,false);
 assert(api().validateClassroomToolRequest(state(),{...request(),command}).accepted);
});

test('application chalk has strict evidence binding and cannot masquerade as a native model command',()=>{
 const context={logicalSessionId:'10000000-0000-4000-8000-000000000001',courseVersion:'picnic:1',connectionEpoch:1,stateRevision:2,pageId:'p1',activityId:'s1'};
 const request={type:'tool.requested',id:'20000000-0000-4000-8000-000000000001',receivedAtMs:100,source:'application',callId:'chalk-1',context,command:{name:'chalk_write',arguments:{contextKey:'lesson:1:0',evidenceItemId:'child-1',text:'I like apples.',seconds:8}}};
 assert.equal(api().validateClassroomToolRequest({status:'active',context},request).accepted,true);
 assert.equal(api().validateClassroomToolRequest({status:'active',context},{...request,source:'teacher'}).accepted,false);
 assert.equal(api().parseClassroomToolCommand(request.command).ok,false);
 assert.equal(api().validateClassroomToolRequest({status:'active',context},{...request,command:{...request.command,arguments:{...request.command.arguments,correct:true}}}).accepted,false);
});

test('lesson review is a strict current read command without invented notes or grading authority',()=>{
 const command={name:'review_lesson_notes',arguments:{contextKey:'lesson-1:1:0'}};
 assert.deepEqual(api().parseClassroomToolCommand(command),{ok:true,command});
 assert.equal(api().validateClassroomToolRequest(state(),{...request(),command}).accepted,true);
 for(const extra of [{notes:['made up']},{score:100},{evidenceItemId:'borrowed'},{ended:true}])assert.equal(api().parseClassroomToolCommand({...command,arguments:{...command.arguments,...extra}}).ok,false);
});

test('strict commands distinguish highlight, answer and inspection without normalizing text', () => {
  for (const value of [command(), { name: 'submit_spoken_answer', arguments: { contextKey: 'lesson-1:1:0', answer: ' I like apples. ' } }, { name: 'inspect_current_page', arguments: { contextKey: 'lesson-1:1:0', question: 'What did I draw?' } }]) {
    assert.deepEqual(api().parseClassroomToolCommand(value), { ok: true, command: value });
  }
  for (const value of [null, [], { ...command(), name: 'delegate' }, { ...command(), name: 'skip' }, { ...command(), name: 'turn_page' }, { ...command(), extra: true }, { ...command(), arguments: { contextKey: 'lesson-1:1:0', answer: 'apple' } }]) {
    assert.deepEqual(api().parseClassroomToolCommand(value), { ok: false, reason: 'invalid_command' });
  }
});

test('command limits and unknown fields are rejected without reflecting their input', () => {
  for (const arguments_ of [null, { objectIds: ['apple'] }, { ...command().arguments, objectIds: [] }, { ...command().arguments, objectIds: Array(6).fill('apple') }, { ...command().arguments, objectIds: [1] }, { ...command().arguments, objectIds: ['x'.repeat(101)] }, { ...command().arguments, contextKey: 'x'.repeat(1001) }, { ...command().arguments, image: 'PRIVATE_FIXTURE' }, { ...command().arguments, evidenceItemId: 'forged' }, { ...command().arguments, correct: true }]) {
    assert.deepEqual(api().parseClassroomToolCommand({ ...command(), arguments: arguments_ }), { ok: false, reason: 'invalid_command' });
  }
  for (const name of ['submit_spoken_answer', 'inspect_current_page']) {
    const field = name === 'submit_spoken_answer' ? 'answer' : 'question';
    for (const value of ['', '  ', 'x'.repeat(501), 1]) assert.equal(api().parseClassroomToolCommand({ name, arguments: { contextKey: 'key', [field]: value } }).ok, false);
    assert.equal(api().parseClassroomToolCommand({ name, arguments: { contextKey: 'x'.repeat(1000), [field]: 'x'.repeat(500) } }).ok, true);
  }
});

test('scoped requests preserve provider call IDs and never accept caller authority fields', () => {
  const input = { ...request(), callId: 'x'.repeat(300) };
  assert.deepEqual(api().validateClassroomToolRequest(state(), input), { accepted: true, request: input });
  for (const value of [{ ...request(), callId: 'x'.repeat(301) }, { ...request(), receivedAtMs: '1000' }, { ...request(), id: 'not-uuid' }, { ...request(), source: 'browser' }, { ...request(), authorized: true }, { ...request(), context: { ...context(), score: 100 } }]) {
    assert.deepEqual(api().validateClassroomToolRequest(state(), value), { accepted: false, reason: 'invalid_request' });
  }
  const parsed = api().validateClassroomToolRequest(state(), request());
  assert(parsed.accepted);assert(Object.isFrozen(parsed.request));assert(Object.isFrozen(parsed.request.command.arguments));
  assert(parsed.request.command.name === 'highlight_objects');
  assert(Object.isFrozen(parsed.request.command.arguments.objectIds));
});

for (const [field, value, reason] of [['logicalSessionId', 'other', 'session_mismatch'], ['courseVersion', 'picnic:3', 'course_version_mismatch'], ['connectionEpoch', 2, 'connection_epoch_mismatch'], ['stateRevision', 1, 'stale_revision'], ['stateRevision', 3, 'future_revision'], ['pageId', 'other', 'page_mismatch'], ['activityId', 'other', 'activity_mismatch']] as const) {
  test(`shared request scope rejects ${reason}`, () => {
    assert.deepEqual(api().validateClassroomToolRequest(state(), { ...request(), context: { ...context(), [field]: value } }), { accepted: false, reason });
  });
}

test('invalid state and format precedence remains explicit', () => {
  assert.deepEqual(api().validateClassroomToolRequest(null, null), { accepted: false, reason: 'invalid_state' });
  assert.deepEqual(api().validateClassroomToolRequest({ ...state(), status: 'ended' }, null), { accepted: false, reason: 'invalid_request' });
  for (const status of ['preflight', 'paused', 'ending', 'ended']) assert.deepEqual(api().validateClassroomToolRequest({ ...state(), status }, request()), { accepted: false, reason: 'not_active' });
});

test('application output preserves existing statuses without claiming rendering, playback or grades', () => {
  for (const status of ['confirmed', 'retry', 'conversation', 'reference', 'unavailable']) {
    const output = { status, english: 'A bounded application result.' };
    assert.deepEqual(api().parseClassroomToolOutput(output), { ok: true, output });
  }
  for (const output of [null, { status: 'played' }, { status: 'confirmed', rendered: true }, { status: 'confirmed', score: 100 }, { status: 'unavailable', highlighted: ['apple'] }, { status: 'reference', image: 'PRIVATE_FIXTURE' }, { status: 'confirmed', english: 'x'.repeat(6001) }]) {
    assert.deepEqual(api().parseClassroomToolOutput(output), { ok: false, reason: 'invalid_output' });
  }
});

test('result scope uses the post-execution revision rather than rejecting legitimate effects', () => {
  const current = { ...state(), context: { ...context(), stateRevision: 3 } };
  const input = { ...result(), context: current.context };
  assert.deepEqual(api().validateClassroomToolResult(current, input, request()), { accepted: true, result: input });
  assert.deepEqual(api().validateClassroomToolResult(current, result(), request()), { accepted: false, reason: 'stale_revision' });
  assert.deepEqual(api().validateClassroomToolResult({ ...current, status: 'ended' }, input, request()), { accepted: false, reason: 'not_active' });
  for (const value of [{ ...result(), phase: 'rendered' }, { ...result(), output: { status: 'confirmed', raw: 'PRIVATE_FIXTURE' } }]) assert.deepEqual(api().validateClassroomToolResult(state(), value, request()), { accepted: false, reason: 'invalid_result' });
});

test('a current-looking result must still belong to its original request and task', () => {
  assert.deepEqual(api().validateClassroomToolResult(state(), result(), null), { accepted: false, reason: 'invalid_request' });
  for (const input of [{ ...result(), requestId: 'f171e0e0-7369-4462-91b2-47d68a838fa7' }, { ...result(), callId: 'other' }]) {
    assert.deepEqual(api().validateClassroomToolResult(state(), input, request()), { accepted: false, reason: 'request_mismatch' });
  }
  for (const [key, value] of [['logicalSessionId', 'other'], ['courseVersion', 'picnic:3'], ['connectionEpoch', 2], ['pageId', 'page-2'], ['activityId', 'other']] as const) {
    const input = { ...result(), context: { ...context(), [key]: value } };
    const current = { ...state(), context: input.context };
    assert.deepEqual(api().validateClassroomToolResult(current, input, request()), { accepted: false, reason: 'request_mismatch' });
  }
  assert.deepEqual(api().validateClassroomToolResult(state(), result(), { ...request(), context: { ...context(), stateRevision: 3 } }), { accepted: false, reason: 'request_mismatch' });
});

function spokenAdvance(){
 const before=context(),after={...before,stateRevision:3,pageId:'page-2',activityId:'next-task'};
 const original={...request(),command:{name:'submit_spoken_answer',arguments:{contextKey:'lesson-1:1:0',answer:'Apple.'}}};
 const completed={...result(),context:after,output:{status:'confirmed',english:'The expression goal was met.'}};
 return{original,completed,current:{status:'active',context:after},receipt:{type:'tool.advance',requestId:original.id,callId:original.callId,before,after}};
}
test('a scoped spoken result can advance only with a bound application receipt',()=>{
 const {original,completed,current,receipt}=spokenAdvance();
 assert.equal(api().validateClassroomToolResult(current,completed,original,receipt).accepted,true);
 assert.equal(api().validateClassroomToolResult(current,completed,original).accepted,false);
});
test('advance receipts reject swapped scope, authority, call and non-answer claims',()=>{
 const {original,completed,current,receipt}=spokenAdvance();
 for(const invalid of [null,{...receipt,requestId:'16f6a0f8-9747-47b0-957c-93689bbed521'},{...receipt,callId:'other'},{...receipt,before:{...receipt.before,stateRevision:1}},{...receipt,after:{...receipt.after,activityId:'other'}},{...receipt,score:100},{...receipt,type:'model.advance'}])assert.equal(api().validateClassroomToolResult(current,completed,original,invalid).accepted,false);
 for(const field of ['logicalSessionId','courseVersion','connectionEpoch'] as const){const after={...receipt.after,[field]:field==='connectionEpoch'?2:'other'};assert.equal(api().validateClassroomToolResult({status:'active',context:after},{...completed,context:after},original,{...receipt,after}).accepted,false);}
 for(const status of ['retry','conversation','reference','unavailable'])assert.equal(api().validateClassroomToolResult(current,{...completed,output:{status}},original,receipt).accepted,false);
 assert.equal(api().validateClassroomToolResult(current,completed,request(),receipt).accepted,false);
 const unchangedRevision={...receipt.after,stateRevision:receipt.before.stateRevision};assert.equal(api().validateClassroomToolResult({status:'active',context:unchangedRevision},{...completed,context:unchangedRevision},original,{...receipt,after:unchangedRevision}).accepted,false);
});

function applicationDelegation(){return{...request(),source:'application',command:{name:'delegate',arguments:{contextKey:'lesson-1:1:0',evidenceItemId:'completed-input'}}};}
test('application delegation binds only a stored complete input without widening provider tool commands',()=>{
 const input=applicationDelegation(),checked=api().validateClassroomToolRequest(state(),input);assert(checked.accepted);assert.deepEqual(checked.request,input);assert(Object.isFrozen(checked.request.command.arguments));
 assert.deepEqual(api().parseClassroomToolCommand(input.command),{ok:false,reason:'invalid_command'});assert.equal(api().CLASSROOM_TOOL_DEFINITIONS.some(tool=>(tool.name as string)==='delegate'),false);
 for(const invalid of [{...input,source:'teacher'},{...input,command:{...input.command,arguments:{contextKey:'lesson-1:1:0'}}},{...input,command:{...input.command,arguments:{...input.command.arguments,evidenceItemId:'x'.repeat(201)}}},...['answer','history','typed','correct','score'].map(field=>({...input,command:{...input.command,arguments:{...input.command.arguments,[field]:true}}}))])assert.equal(api().validateClassroomToolRequest(state(),invalid).accepted,false);
});
test('application delegation may acknowledge a verified advance only with its own PG receipt',()=>{
 const {completed,current,receipt}=spokenAdvance(),original=applicationDelegation();
 assert.equal(api().validateClassroomToolResult(current,completed,original,receipt).accepted,true);assert.equal(api().validateClassroomToolResult(current,completed,original).accepted,false);
 assert.equal(api().validateClassroomToolResult(current,completed,{...original,source:'teacher'},receipt).accepted,false);assert.equal(api().validateClassroomToolResult(current,completed,original,{...receipt,callId:'other'}).accepted,false);
});
