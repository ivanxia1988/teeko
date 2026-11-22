import assert from 'node:assert/strict';
import test from 'node:test';
import type {ClassroomJournalEvent} from '../lib/classroom-journal';
import {buildClassroomTimeline,describeClassroomProgress} from '../lib/classroom-timeline';

const turn='00000000-0000-4000-8000-000000000001',span='00000000-0000-4000-8000-000000000002';
const other='00000000-0000-4000-8000-000000000003';
const start=Date.parse('2026-11-15T00:00:00Z');
const event=(id:string,patch:Partial<ClassroomJournalEvent>={},details:ClassroomJournalEvent['details']={}):ClassroomJournalEvent=>({id,createdAt:new Date(start).toISOString(),epoch:1,revision:2,stepIndex:0,kind:'interaction',actor:'application',status:'recorded',name:'test_event',text:null,correlationId:null,...patch,details});
const progress=(events:ClassroomJournalEvent[],patch:Partial<Parameters<typeof describeClassroomProgress>[1]>={})=>describeClassroomProgress(events,{status:'active',now:start+1000,complete:true,...patch});

test('timeline shows conversation but hides normal diagnostic, heartbeat, board commit and internal assessment noise',()=>{
 const result=buildClassroomTimeline([
  event('1',{kind:'utterance',actor:'child',text:'An apple.',name:'transcript'}),
  event('2',{name:'diagnostic_phase'},{phase:'input_final',turnId:turn}),
  event('3',{kind:'tool',name:'submit_spoken_answer',status:'confirmed'},{resultStatus:'conversation'}),
  event('4',{kind:'connection',name:'heartbeat'}),event('5',{kind:'visual',name:'board_commit'}),
  event('6',{kind:'utterance',actor:'teacher',text:'Apples are sweet.',name:'teacher_speech'},{playback:'generated'}),
 ]);
 assert.equal(result.length,2);assert.equal(result[0].category,'child');assert.equal(result[0].text,'An apple.');
 assert.equal(result[1].category,'teacher');assert.equal(result[1].note,'播放未确认');
});

test('one explicitly correlated tool lifecycle becomes one action with actual application result',()=>{
 const result=buildClassroomTimeline([
  event('1',{kind:'tool',actor:'teacher',name:'highlight_objects',status:'requested',correlationId:'call-1'},{objectIds:['banana']}),
  event('2',{kind:'tool',actor:'teacher',name:'highlight_objects',status:'confirmed',correlationId:'call-1'},{resultStatus:'confirmed',highlighted:['banana']}),
 ]);
 assert.equal(result.length,1);assert.equal(result[0].category,'action');assert.match(result[0].title,/圈选.*确认/);
 assert.match(result[0].text??'',/banana/);assert.deepEqual(result[0].eventIds,['1','2']);assert.equal(result[0].severity,'normal');
});

test('application highlight receipts surface the actual circle while ordinary delegation stays hidden',()=>{
 const rows=buildClassroomTimeline([
  event('1',{kind:'tool',name:'delegate',status:'confirmed'},{resultStatus:'conversation'}),
  event('2',{kind:'tool',name:'delegate',status:'confirmed'},{effectiveTool:'highlight_objects',highlighted:['wings'],resultStatus:'confirmed'}),
  event('3',{kind:'tool',name:'delegate',status:'requested'},{effectiveTool:'highlight_objects'}),
 ]);
 assert.equal(rows.length,1);assert.equal(rows[0].title,'圈选操作已确认');assert.match(rows[0].text??'',/wings/);
 assert.equal(rows[0].events[0].name,'delegate');
});

test('overlap follow-up is visible as a request without claiming playback',()=>{
 const entry=event('1',{kind:'connection',name:'voice_overlap_reply',status:'requested'},{turnId:turn});
 const rows=buildClassroomTimeline([entry]);
 assert.equal(rows.length,1);assert.equal(rows[0].title,'已请求老师补答最新一句');
 assert.match(rows[0].note??'',/播放结果另行记录/);
 assert.equal(progress([entry]).title,'最近记录：已请求老师补答最新一句');
});

test('tool requests and refused or failed operations cannot be described as completed',()=>{
 const requested=buildClassroomTimeline([event('1',{kind:'tool',name:'chalk_write',status:'requested'})])[0];
 assert.match(requested.title,/请求/);assert.doesNotMatch(requested.title,/已完成|已确认/);
 const refused=buildClassroomTimeline([event('1',{kind:'tool',name:'highlight_objects',status:'requested',correlationId:'c'}),event('2',{kind:'tool',name:'highlight_objects',status:'rejected',correlationId:'c'},{resultStatus:'retry'})])[0];
 assert.match(refused.title,/未执行|未完成/);assert.equal(refused.severity,'warning');assert.equal(refused.events.length,2);
 const failed=buildClassroomTimeline([event('3',{kind:'tool',name:'delegate',status:'failed'})])[0];assert.equal(failed.severity,'error');
});

test('nearby timestamps, another epoch, and a shared ambiguous turn never merge separate actions',()=>{
 const missing=buildClassroomTimeline([event('1',{kind:'tool',name:'highlight_objects',status:'requested'}),event('2',{kind:'tool',name:'highlight_objects',status:'confirmed'},{resultStatus:'confirmed'})]);assert.equal(missing.length,2);
 const epochs=buildClassroomTimeline([event('1',{kind:'tool',name:'highlight_objects',correlationId:'c'}),event('2',{kind:'tool',name:'highlight_objects',correlationId:'c',epoch:2})]);assert.equal(epochs.length,2);
 const ambiguous=buildClassroomTimeline([event('1',{kind:'tool',name:'highlight_objects',status:'requested'},{turnId:turn}),event('2',{kind:'tool',name:'highlight_objects',status:'requested'},{turnId:turn}),event('3',{kind:'tool',name:'highlight_objects',status:'confirmed'},{turnId:turn,resultStatus:'confirmed'})]);assert.equal(ambiguous.length,3);
});

test('decimal IDs retain precision and overlapping pages deduplicate without changing input',()=>{
 const input=[event('9007199254740994',{kind:'utterance',actor:'child',text:'Two.'}),event('9007199254740993',{kind:'utterance',actor:'child',text:'One.'}),event('9007199254740994',{kind:'utterance',actor:'child',text:'Two.'})];
 const result=buildClassroomTimeline(input);assert.deepEqual(result.map(x=>x.id),['9007199254740993','9007199254740994']);assert.equal(input[0].id,'9007199254740994');assert.equal(input.length,3);
});

test('only explicit unique current-epoch playback association can change teacher playback note',()=>{
 const input=[event('1',{kind:'utterance',actor:'teacher',name:'transcript',text:'Here it is.',correlationId:'teacher-item'},{playback:'generated'}),
 event('2',{name:'diagnostic_association',correlationId:'teacher-item'},{turnId:turn,spanId:span}),
 event('3',{kind:'connection',name:'diagnostic_phase'},{turnId:turn,spanId:span,phase:'playback_started',source:'client',clock:'client'})];
 const result=buildClassroomTimeline(input);assert.equal(result.length,1);assert.match(result[0].note??'',/浏览器.*开始播放/);assert.deepEqual(result[0].eventIds,['1','2','3']);
 const otherEpoch=buildClassroomTimeline([input[0],input[1],{...input[2],epoch:2}]);assert.match(otherEpoch[0].note??'',/未确认/);
 const unverified=buildClassroomTimeline([input[0],input[1],{...input[2],details:{turnId:turn,spanId:span,phase:'playback_finished',source:'provider',clock:'server'}}]);assert.match(unverified[0].note??'',/未确认/);
});

test('ambiguous teacher playback is not assigned to multiple replies sharing a turn',()=>{
 const result=buildClassroomTimeline([
 event('1',{kind:'utterance',actor:'teacher',text:'First.'},{turnId:turn}),event('2',{kind:'utterance',actor:'teacher',text:'Second.'},{turnId:turn}),
 event('3',{kind:'connection',name:'diagnostic_phase'},{turnId:turn,spanId:span,phase:'playback_finished',source:'client',clock:'client'})]);
 assert.equal(result.length,2);assert(result.every(x=>/未确认/.test(x.note??'')));
});

test('visual states and pen actions never invent screenshots, comprehension or absence detection',()=>{
 const result=buildClassroomTimeline([event('1',{kind:'visual',name:'camera_state'},{source:'camera',state:'off'}),event('2',{name:'annotation'},{action:'draw',strokeCount:1,pointCount:12}),event('3',{kind:'visual',name:'board_state',status:'failed'},{source:'board',state:'error'})]);
 assert.equal(result.length,3);assert.match(result[0].title,/关闭/);assert.match(result[1].title,/标注/);assert.equal(result[2].severity,'error');
 assert.doesNotMatch(result.map(x=>x.title).join(' '),/离开画面|不在屏幕|截图|理解/);
});

test('all failed and rejected technical records stay visible with safe human summaries',()=>{
 const result=buildClassroomTimeline([event('1',{name:'assessment_phase',status:'failed'},{phase:'model_completed',errorCode:'assessment_unavailable'}),event('2',{kind:'connection',name:'journal_gap'},{errorCode:'journal_backpressure'}),event('3',{name:'diagnostic_phase',status:'recorded'},{phase:'input_failed'}),event('4',{kind:'tool',name:'submit_spoken_answer',status:'rejected'},{resultStatus:'retry'})]);
 assert.equal(result.length,4);assert(result.every(x=>x.severity!=='normal'));
});

test('timeline uses sanitized known fields and never displays hidden detail blobs as summaries',()=>{
 const sensitive='sk-abcdefghijklmnopqrstuv';
 const input=event('1',{kind:'utterance',actor:'child',text:`My secret is ${sensitive}.`},{message:'hidden-reasoning-fixture'});
 const row=buildClassroomTimeline([input])[0];assert(!JSON.stringify(row).includes(sensitive));assert(![row.title,row.text,row.note].join(' ').includes('hidden-reasoning-fixture'));
});

for(const [phase,title] of [
 ['speech_started','说话开始'],['input_final','学生文字'],['application_started','处理'],['model_started','教学判断'],['model_completed','教学判断'],
 ['response_requested','等待老师回复'],['response_started','生成回复'],['audio_first_received','服务器'],['audio_first_sent','浏览器'],
 ['response_completed','生成'],['playback_started','开始播放'],['playback_finished','播放结束'],
] as const)test(`progress describes the actual ${phase} stage without inferring another hop`,()=>{
 const result=progress([event('1',{name:phase==='model_started'||phase==='model_completed'?'assessment_phase':'diagnostic_phase'}, {phase,spanId:span,clock:phase.startsWith('playback_')?'client':'server',source:phase.startsWith('playback_')?'client':'application',elapsedMs:80})]);
 assert.match(result.title,new RegExp(title));assert.match(result.title,/最近记录/);assert.match(result.detail,/麦克风.*未记录/);assert.equal(result.tone,'neutral');
});

test('progress distinguishes configured idle reminder from a proven audible teacher reply',()=>{
 const result=progress([event('1',{name:'silence_prompt',status:'requested'})]);assert.match(result.title,/请求.*接话/);assert.doesNotMatch(result.title,/老师已说|播放结束/);
});

test('stale, future, partial, and missing records are not proof of a stuck API or absent microphone',()=>{
 for(const result of [progress([event('1',{name:'diagnostic_phase'},{phase:'response_requested'})],{now:start+60000}),progress([event('1',{name:'diagnostic_phase'},{phase:'response_requested'})],{complete:false}),progress([]),progress([event('1',{createdAt:new Date(start+60000).toISOString(),name:'diagnostic_phase'},{phase:'response_requested'})])]){
  assert.match(`${result.title} ${result.detail}`,/无法确认|未采集/);assert.doesNotMatch(result.title,/API.*卡|没有收音|学生.*沉默/);
 }
});

test('a recent heartbeat cannot refresh an old response phase or hide collection gaps',()=>{
 const result=progress([event('1',{name:'diagnostic_phase'},{phase:'response_requested'}),event('2',{name:'heartbeat',createdAt:new Date(start+59000).toISOString()})],{now:start+60000});assert.match(`${result.title} ${result.detail}`,/无法确认/);
 const gap=progress([event('1',{name:'journal_gap',status:'failed'}),event('2',{name:'diagnostic_phase'},{phase:'playback_started',source:'client',clock:'client'})]);assert.match(`${gap.title} ${gap.detail}`,/缺口|不完整/);
});

test('current epoch and explicit classroom status outrank obsolete failures',()=>{
 const rows=[event('1',{kind:'connection',name:'voice_closed',status:'failed'},{errorCode:'provider_error'}),event('2',{epoch:2,kind:'connection',name:'voice_connected',status:'confirmed'})];
 const result=progress(rows);assert.equal(result.tone,'neutral');assert.match(result.title,/连接/);
 assert.match(progress(rows,{status:'paused'}).title,/暂停/);assert.match(progress(rows,{status:'ended'}).title,/结束/);
});

test('timing displayed for progress never subtracts different endpoint clocks or journal timestamps',()=>{
 const result=progress([event('1',{name:'diagnostic_phase'},{phase:'response_requested',spanId:span,clock:'server',elapsedMs:100}),event('2',{name:'diagnostic_phase'},{phase:'playback_started',spanId:span,clock:'client',source:'client',elapsedMs:900})]);
 assert.doesNotMatch(`${result.title} ${result.detail}`,/800|毫秒|ms/);assert.match(result.title,/浏览器.*开始播放/);
});

test('merged action is ordered at its actual result record without moving dialogue after it',()=>{
 const rows=buildClassroomTimeline([
  event('1',{kind:'tool',name:'highlight_objects',status:'requested',correlationId:'call'}),
  event('2',{kind:'utterance',actor:'child',text:'Thank you.',createdAt:new Date(start+1000).toISOString()}),
  event('3',{kind:'tool',name:'highlight_objects',status:'confirmed',correlationId:'call',createdAt:new Date(start+2000).toISOString()},{resultStatus:'confirmed',highlighted:['banana']}),
 ]);assert.deepEqual(rows.map(row=>row.category),['child','action']);assert.equal(rows[1].at,new Date(start+2000).toISOString());assert.equal(rows[1].id,'1');
});

test('teacher playback requires that reply span, not merely one visible reply in a shared turn',()=>{
 const rows=buildClassroomTimeline([event('1',{kind:'utterance',actor:'teacher',text:'A reply.'},{turnId:turn}),event('2',{name:'diagnostic_phase'},{turnId:turn,spanId:span,phase:'playback_finished',source:'client',clock:'client'})]);assert.match(rows[0].note??'',/未确认/);
});

test('normal connection release is technical detail rather than another timeline action',()=>{
 assert.equal(buildClassroomTimeline([event('1',{kind:'connection',name:'connection_released'},{state:'paused'})]).length,0);
 assert.equal(buildClassroomTimeline([event('1',{kind:'connection',name:'connection_released',status:'failed'})]).length,1);
});

test('paused progress preserves the actual same-epoch voice failure and distinguishes a later explicit pause',()=>{
 const rows=[event('1',{kind:'connection',name:'voice_response_timeout',status:'failed'},{errorCode:'response_timeout'}),event('2',{kind:'connection',name:'voice_closed',status:'failed'},{errorCode:'response_timeout'}),event('3',{kind:'connection',name:'connection_released'},{state:'paused'})];
 const result=progress(rows,{status:'paused'});assert.match(result.detail,/等待老师回复超时/);assert.match(result.detail,/暂停/);
 const explicit=progress([...rows,event('4',{name:'pause',actor:'child',status:'confirmed'})],{status:'paused'});assert.match(explicit.detail,/主动暂停/);assert.doesNotMatch(explicit.detail,/因等待老师回复超时而暂停/);
 const newEpoch=progress([...rows,event('4',{epoch:2,kind:'connection',name:'voice_connected',status:'confirmed'})],{status:'paused'});assert.doesNotMatch(newEpoch.detail,/超时/);
});

test('a confirmed connection keeps its explicit epoch lifecycle in one timeline row',()=>{
 const rows=buildClassroomTimeline([event('1',{kind:'connection',name:'connection_started'}),event('2',{kind:'connection',name:'provider_ready',status:'confirmed'}),event('3',{kind:'connection',name:'voice_connected',status:'confirmed'})]);
 assert.equal(rows.length,1);assert.equal(rows[0].title,'课堂语音已连接');assert.deepEqual(rows[0].eventIds,['1','2','3']);assert.equal(rows[0].id,'3');
 assert.equal(buildClassroomTimeline([event('1',{kind:'connection',name:'connection_started'})])[0].title,'正在连接课堂');
 const failed=buildClassroomTimeline([event('1',{kind:'connection',name:'connection_started',status:'failed'}),event('2',{kind:'connection',name:'voice_connected',status:'confirmed'})]);assert.equal(failed.length,2);assert.equal(failed[0].severity,'error');
});

test('partial paused logs cannot turn an old loaded connection failure into the current pause cause',()=>{
 const rows=[event('1',{kind:'connection',name:'voice_closed',status:'failed'},{errorCode:'provider_error'})];
 const result=progress(rows,{status:'paused',complete:false});assert.match(result.detail,/语音服务返回异常/);assert.match(result.detail,/当前暂停原因无法确认/);assert.doesNotMatch(result.detail,/因语音服务返回异常而暂停/);
});

test('conflicting explicit turns make a shared tool correlation ambiguous rather than one completed action',()=>{
 const rows=buildClassroomTimeline([event('1',{kind:'tool',name:'highlight_objects',status:'requested',correlationId:'shared'},{turnId:turn}),event('2',{kind:'tool',name:'highlight_objects',status:'requested',correlationId:'shared'},{turnId:other}),event('3',{kind:'tool',name:'highlight_objects',status:'confirmed',correlationId:'shared'},{resultStatus:'confirmed'})]);assert.equal(rows.length,3);assert(rows.every(row=>row.eventIds.length===1));
});

test('redacted identifiers never become shared evidence for joining unrelated actions',()=>{
 const rows=buildClassroomTimeline([event('1',{kind:'tool',name:'highlight_objects',status:'requested',correlationId:'sk-abcdefghijklmnop'}),event('2',{kind:'tool',name:'highlight_objects',status:'confirmed',correlationId:'sk-qrstuvwxyzabcdef'},{resultStatus:'confirmed'})]);assert.equal(rows.length,2);assert(rows.every(row=>row.events.length===1));assert(!JSON.stringify(rows).includes('abcdefghijklmnop'));
});

test('two redacted requests sharing a span are still separate operations',()=>{
 const rows=buildClassroomTimeline([event('1',{kind:'tool',name:'highlight_objects',status:'requested',correlationId:'sk-abcdefghijklmnop'},{spanId:span}),event('2',{kind:'tool',name:'highlight_objects',status:'requested',correlationId:'sk-qrstuvwxyzabcdef'},{spanId:span})]);assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.eventIds),[['1'],['2']]);
});

test('weak turn association cannot merge multiple terminal action results',()=>{
 const first=event('1',{kind:'tool',name:'highlight_objects',status:'requested'},{turnId:turn});
 const results=[event('2',{kind:'tool',name:'highlight_objects',status:'confirmed'},{turnId:turn,resultStatus:'confirmed',highlighted:['apple']}),event('3',{kind:'tool',name:'highlight_objects',status:'confirmed'},{turnId:turn,resultStatus:'confirmed',highlighted:['banana']})];
 assert.equal(buildClassroomTimeline([first,...results]).length,3);assert.equal(buildClassroomTimeline(results).length,2);
});

const latencyMeasurementId='10000000-0000-4000-8000-000000000091',latencyInputId='20000000-0000-4000-8000-000000000091';
function latencyEvent(id:string,stage:string,extra:Record<string,unknown>={}):ClassroomJournalEvent{return event(id,{kind:'connection',actor:'application',name:'latency_stage',text:null},{measurementId:latencyMeasurementId,latencyInputId,latencyStage:stage,latencyBasis:'provider_turn',clock:'server',elapsedMs:100,...extra} as ClassroomJournalEvent['details']);}
test('latency stages become one round even without a recognized transcript',()=>{
 const rows=buildClassroomTimeline([latencyEvent('1','input_received'),latencyEvent('2','speech_stopped'),latencyEvent('3','response_requested')]);
 assert.equal(rows.length,1);assert.equal(rows[0].title,'本轮语音');assert.equal(rows[0].latency?.status,'waiting');assert.deepEqual(rows[0].eventIds,['1','2','3']);
});
test('explicit measurement attaches once to its student row rather than repeating stages',()=>{
 const rows=buildClassroomTimeline([latencyEvent('1','input_received'),event('2',{kind:'utterance',name:'transcript',actor:'child',text:'An apple.'},{source:'speech',measurementId:latencyMeasurementId,latencyInputId}),latencyEvent('3','playback_started',{clock:'client',waitMs:2300})]);
 assert.equal(rows.length,1);assert.equal(rows[0].text,'An apple.');assert.equal(rows[0].latency?.waitMs,2300);assert.deepEqual(rows[0].eventIds,['1','2','3']);
});
test('latency never attaches by nearby time, shared epoch alone, or an ambiguous input UUID',()=>{
 const rows=buildClassroomTimeline([event('1',{kind:'utterance',name:'transcript',actor:'child',text:'Unlinked.'},{source:'speech'}),latencyEvent('2','input_received')]);
 assert.equal(rows.length,2);assert.equal(rows[0].latency,undefined);assert.equal(rows[1].latency?.measurementId,latencyMeasurementId);
});
test('speech measurement cannot be attached to typed input or a different explicit measurement',()=>{
 for(const details of [{source:'typed' as const,measurementId:latencyMeasurementId,latencyInputId},{source:'speech' as const,measurementId:other,latencyInputId}]){
  const rows=buildClassroomTimeline([event('1',{kind:'utterance',name:'transcript',actor:'child',text:'A separate input.'},details),latencyEvent('2','input_received')]);
  assert.equal(rows.length,2);assert.equal(rows[0].latency,undefined);assert.equal(rows[1].title,'本轮语音');
 }
});
test('shared input ID across measurements is insufficient to attach to an unbound student transcript',()=>{
 const rows=buildClassroomTimeline([event('1',{kind:'utterance',name:'transcript',actor:'child',text:'An ambiguous input.'},{source:'speech',latencyInputId}),latencyEvent('2','input_received'),latencyEvent('3','input_received',{measurementId:other})]);
 assert.equal(rows.length,3);assert.equal(rows[0].latency,undefined);
});
test('partial or stale latency snapshots cannot be presented as a current stuck stage',()=>{
 const rows=[latencyEvent('1','speech_stopped'),latencyEvent('2','response_requested',{elapsedMs:3000})];
 assert.match(progress(rows,{complete:false}).title,/无法确认/);
 assert.match(progress(rows,{now:start+60000}).title,/无法确认/);
 const pending=progress(rows);assert.match(pending.title,/等待老师语音/);assert.doesNotMatch(pending.detail,/已等待 60|API/);
});
test('an unknown latency heartbeat cannot refresh an obsolete waiting stage',()=>{
 const rows=[latencyEvent('1','speech_stopped'),{...latencyEvent('2','wait_update',{state:'waiting_unknown',elapsedMs:60000}),createdAt:new Date(start+60000).toISOString()}];
 assert.match(progress(rows,{now:start+60000}).title,/无法确认/);
});
test('a validated first-audible latency receipt updates only its explicit teacher reply span',()=>{
 const rows=buildClassroomTimeline([
  latencyEvent('1','speech_stopped'),
  event('2',{kind:'utterance',actor:'teacher',text:'A generated reply.'},{turnId:turn,spanId:span,playback:'generated'}),
  latencyEvent('3','playback_started',{clock:'client',waitMs:3200,turnId:turn,spanId:span}),
  event('4',{kind:'utterance',actor:'teacher',text:'Another reply.'},{turnId:turn,spanId:other,playback:'generated'}),
 ]);
 const teacher=rows.find(row=>row.text==='A generated reply.')!;assert.equal(teacher.note,'浏览器报告开始有声播放');
 assert.match(rows.find(row=>row.text==='Another reply.')?.note??'',/未确认/);
 assert.deepEqual(teacher.eventIds,['2']);
});
test('unmeasured or obsolete latency receipts cannot change a teacher playback note',()=>{
 for(const receipt of [latencyEvent('3','playback_started',{clock:'client',waitMs:120001,spanId:span}),{...latencyEvent('3','playback_started',{clock:'client',waitMs:100,spanId:span}),epoch:2}]){
  const rows=buildClassroomTimeline([event('1',{kind:'utterance',actor:'teacher',text:'A reply.'},{spanId:span}),receipt]);
  assert.match(rows.find(row=>row.category==='teacher')?.note??'',/未确认/);
 }
});
test('an explicit legacy playback-finished report remains stronger than a new first-audible receipt',()=>{
 const rows=buildClassroomTimeline([
  event('1',{kind:'utterance',actor:'teacher',text:'A reply.'},{turnId:turn,spanId:span}),
  latencyEvent('2','playback_started',{clock:'client',waitMs:100,turnId:turn,spanId:span}),
  event('3',{name:'diagnostic_phase'},{turnId:turn,spanId:span,clock:'client',source:'client',phase:'playback_finished'}),
 ]);
 assert.equal(rows.find(row=>row.category==='teacher')?.note,'浏览器报告播放结束');
});

test('a textbook pointer reference is visible without claiming speech, correctness or teaching completion',()=>{
 const rows=buildClassroomTimeline([event('1',{actor:'child',name:'point',status:'recorded'},{action:'point',objectIds:['wings'],source:'client'})]);
 assert.equal(rows.length,1);assert.equal(rows[0].category,'action');assert.match(rows[0].title,/指向/);assert.match(rows[0].text??'',/wings/);assert.doesNotMatch(rows[0].title,/答对|完成|掌握|发言/);
});
const pointId='30000000-0000-4000-8000-000000000091';
const pointTrace=(id:string,stage:string,source='application',extra:Record<string,unknown>={})=>event(id,{name:'point_trace',correlationId:pointId,actor:source==='client'?'child':'application'},{pointId,pointStage:stage,source,...extra}as ClassroomJournalEvent['details']);
test('one point timeline merges client observations, PG commit and explicit reply hops without duplicate legacy row',()=>{
 const rows=buildClassroomTimeline([pointTrace('1','clicked','client'),pointTrace('2','sent','client'),event('3',{name:'point',actor:'child',correlationId:pointId},{objectIds:['wings'],source:'client'}),pointTrace('4','accepted'),pointTrace('5','reply_requested'),pointTrace('6','audio_sent')]);
 assert.equal(rows.length,1);assert.deepEqual(rows[0].eventIds,['1','2','3','4','5','6']);assert.match(rows[0].title,/声音.*浏览器/);assert.match(rows[0].note??'',/播放.*未确认/);assert.doesNotMatch(rows[0].title,/答对|已播放|理解/);
 const played=buildClassroomTimeline([...rows[0].events,pointTrace('7','playback_started','client',{clock:'client'})]);assert.match(played[0].title,/浏览器报告.*播放/);
});
test('client point acknowledgement alone never claims PG acceptance, teacher speech or playback',()=>{
 const rows=buildClassroomTimeline([pointTrace('1','clicked','client'),pointTrace('2','acknowledged','client'),pointTrace('3','accepted','client')]);assert.equal(rows.length,1);assert.match(rows[0].title,/浏览器.*确认/);assert.doesNotMatch(rows[0].title,/已保存|老师|播放/);assert.match(rows[0].note??'',/服务端.*未确认|尚无服务端/);
});
test('point failures stay prominent and identical IDs in different connection epochs remain separate',()=>{
 const failed={...pointTrace('2','timeout','client',{pointReason:'ack_timeout'}),status:'failed' as const};const rows=buildClassroomTimeline([pointTrace('1','accepted'),failed,{...pointTrace('3','clicked','client'),epoch:2}]);assert.equal(rows.length,2);assert.equal(rows[0].severity,'error');assert.match(rows[0].title,/未收到.*确认/);assert.match(rows[0].note??'',/已保存/);assert.deepEqual(rows[0].eventIds,['1','2']);assert.deepEqual(rows[1].eventIds,['3']);
});
test('voice recovery shows checking and the verified terminal result while intermediate verification stays technical',()=>{
 const recovery=(id:string,state:string,status:ClassroomJournalEvent['status']='confirmed')=>event(id,{name:'voice_request_recovery',kind:'connection',actor:'application',status},{state,source:'application'});
 const rows=buildClassroomTimeline([event('1',{name:'voice_provider_failure',kind:'connection',status:'failed'},{errorCode:'provider_invalid_request',action:'recovery_check'}),recovery('2','checking','requested'),recovery('3','configuration_verified'),recovery('4','audio_verified'),recovery('5','recovered')]);
 assert.deepEqual(rows.map(row=>row.title),['语音请求被拒绝','正在核验语音连接','语音连接已恢复']);assert.match(rows[0].note??'',/尚未确认/);assert.doesNotMatch(rows.map(row=>row.title).join(' '),/断开|停止/);
 const failed=buildClassroomTimeline([recovery('1','checking','requested'),recovery('2','failed','failed')]);assert.equal(failed[1].title,'语音恢复失败');assert.equal(failed[1].severity,'error');
 const notConfirmed=buildClassroomTimeline([recovery('1','recovered','requested')]);assert(!notConfirmed.some(row=>row.title==='语音连接已恢复'));
});
test('a refused request under recovery cannot be declared the cause of a later paused connection',()=>{
 const result=progress([event('1',{name:'voice_provider_failure',kind:'connection',status:'failed'},{errorCode:'provider_invalid_request',action:'recovery_check'}),event('2',{name:'voice_request_recovery',kind:'connection',status:'confirmed'},{state:'recovered'})],{status:'paused'});assert.doesNotMatch(result.detail,/因.*而暂停/);
});
