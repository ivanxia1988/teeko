import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws';
import {attachClassroomSockets,type VoiceLease} from '../lib/server/classroom-sockets';
import {refreshClassroom} from '../lib/server/classroom-events';
import {teacherSnapshot} from './teacher-runtime-fixture';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import type {ClassroomPointRequest} from '../lib/classroom-point';

type Event=Record<string,unknown>&{type?:string;session?:Record<string,unknown>;response?:Record<string,unknown>};
const voiced=Buffer.alloc(2400,0x11).toString('base64'),silent=Buffer.alloc(2400).toString('base64');
const waitFor=async(check:()=>boolean)=>{const until=Date.now()+2000;while(!check()){if(Date.now()>=until)throw new Error('Expected request-recovery event did not arrive.');await new Promise(resolve=>setTimeout(resolve,4));}};
async function fixture(options:{provider?:'qwen'|'grok';delayedTool?:boolean;delayedPoint?:boolean;nativeInputs?:boolean;timeoutMs?:number;capable?:boolean}={}){
 const id=randomUUID(),provider=options.provider??'qwen',vendorHttp=createServer(),vendor=new WebSocketServer({server:vendorHttp}),app=createServer();
 const sent:Event[]=[],received:Event[]=[],journal:Record<string,unknown>[]=[],transcripts:unknown[]=[],points:ClassroomPointRequest[]=[];
 let peer:WebSocket|undefined,released=0,tools=0,current=teacherSnapshot({id}),expectRecovery=false,holdNormalConfig=false,leaseAuthorized=true,resolveTool:()=>void=()=>{},resolvePoint:()=>void=()=>{};
 const probeUpdates:Event[]=[],probeCreates:Event[]=[],restoreUpdates:Event[]=[];
 const reference=()=>({snapshot:current,instructions:`CURRENT_RULES FIXTURE_REVISION_${current.revision}. Respect the learner and do not grade pointer gestures.`});
 vendor.on('connection',socket=>{peer=socket;socket.on('message',raw=>{
  const event=JSON.parse(raw.toString()) as Event;sent.push(event);
  if(event.type==='session.update'){
   if(expectRecovery){if(!probeUpdates.length)probeUpdates.push(event);else restoreUpdates.push(event);}
   else if(!holdNormalConfig)socket.send(JSON.stringify({type:'session.updated',session:event.session}));
  }
  if(event.type==='response.create'&&expectRecovery)probeCreates.push(event);
 });socket.send(JSON.stringify({type:'session.created',session:{id:'synthetic-recovery'}}));});
 vendorHttp.listen(0,'127.0.0.1');await once(vendorHttp,'listening');const vendorAddress=vendorHttp.address();assert(vendorAddress&&typeof vendorAddress!=='string');
 const lease:VoiceLease={id,epoch:1,provider,...reference(),nativeApplicationInputs:!!options.delayedTool||!!options.nativeInputs,initialCue:'A single original greeting.',remainingMs:60000,
  heartbeat:async()=>leaseAuthorized?reference():null,transcript:async event=>{transcripts.push(event);},tool:async()=>{tools++;if(options.delayedTool)await new Promise<void>(resolve=>{resolveTool=resolve;});current={...current,revision:current.revision+1};return {snapshot:current,output:{status:'conversation',english:'The application has recorded ordinary conversation without advancing the task.'}};},
  point:async(request,isCurrent)=>{points.push(request);if(options.delayedPoint)await new Promise<void>(resolve=>{resolvePoint=resolve;});if(!isCurrent())return {accepted:false,snapshot:current};current={...current,revision:current.revision+1};return {accepted:true,snapshot:current};},
  journal:async event=>{journal.push(event as unknown as Record<string,unknown>);},closed:async()=>{released++;}};
 const owner=attachClassroomSockets(app,{origin:'http://localhost:8080',open:async()=>lease,config:()=>({key:'synthetic-fixture',model:provider==='qwen'?'qwen3.8-omni-flash-realtime':'grok-voice-3.0',voice:provider==='qwen'?'Tina':'eve',workspaceId:'synthetic',region:'cn-beijing'}),connect:()=>new WebSocket(`ws://127.0.0.1:${vendorAddress.port}`),requestRecoveryMs:options.timeoutMs??200,heartbeatMs:60000,startupMs:2000,responseAckMs:2000,responseProgressMs:2000,connectionProbeMs:60000,closeMs:20});
 app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert(address&&typeof address!=='string');
 const client=new WebSocket(`ws://127.0.0.1:${address.port}/ws/classrooms/${id}`,{headers:{Origin:'http://localhost:8080',Cookie:`teeko_session=${'t'.repeat(43)}`}});
 client.on('error',()=>{});client.on('message',raw=>received.push(JSON.parse(raw.toString()) as Event));
 const emit=(event:Event)=>{assert(peer);peer.send(JSON.stringify(event));};
 const barrier=async()=>{assert(peer);if(peer.readyState!==WebSocket.OPEN)return;const pong=once(peer,'pong');peer.ping(randomUUID());await pong;};
 return {id,client,sent,received,journal,transcripts,points,probeUpdates,probeCreates,restoreUpdates,get released(){return released;},get tools(){return tools;},get snapshot(){return current;},
  emit,async provider(event:Event){emit(event);await barrier();},
  async start(){await once(client,'open');await waitFor(()=>received.some(event=>event.type==='ready'));if(options.capable!==false){client.send(JSON.stringify({type:'client.capabilities',diagnosticsVersion:1,pointVersion:1}));client.send(JSON.stringify({type:'ping',nonce:'capabilities_ready'}));await waitFor(()=>received.some(event=>event.type==='pong'&&event.nonce==='capabilities_ready'));}await waitFor(()=>sent.some(event=>event.type==='response.create'));emit({type:'response.created',response:{id:'greeting-response'}});emit({type:'response.audio.delta',response_id:'greeting-response',delta:voiced});emit({type:'response.done',response:{id:'greeting-response',status:'completed'}});await waitFor(()=>received.some(event=>event.type==='audio'));await barrier();},
  fault(error:Record<string,unknown>={}){expectRecovery=true;emit({type:'error',error:{type:'invalid_request_error',...error}});},
  ackProbe(){assert(probeUpdates[0]);emit({type:'session.updated',session:probeUpdates[0].session});},
  ackRestore(){assert(restoreUpdates.at(-1));emit({type:'session.updated',session:restoreUpdates.at(-1)!.session});},
  finishRecovery(){expectRecovery=false;},releaseTool(){resolveTool();},releasePoint(){resolvePoint();},
  revoke(){leaseAuthorized=false;},
  point(){const scope=captureClassroomToolState(current);assert(scope.ok);const eventId=randomUUID();client.send(JSON.stringify({type:'interaction.point',eventId,context:scope.snapshot.context,objectId:'apple'}));return eventId;},
  async feedback(){holdNormalConfig=true;current={...current,revision:current.revision+1,feedback:{id:randomUUID(),kind:'retry',message:'A newer hint.'}};await refreshClassroom(id);await waitFor(()=>sent.some(event=>event.type==='session.update'&&String(event.session?.instructions).includes('FIXTURE_REVISION_2')));},
  async changeTask(explicit=true){current={...current,revision:current.revision+1,stepIndex:current.stepIndex+1};await refreshClassroom(id,explicit?'explicit_navigation':undefined);},
  async changeRevision(){current={...current,revision:current.revision+1};await refreshClassroom(id);},
  async close(){resolveTool();resolvePoint();client.terminate();await owner.close();for(const socket of vendor.clients)socket.terminate();await new Promise<void>(resolve=>vendor.close(()=>resolve()));await new Promise<void>(resolve=>vendorHttp.close(()=>resolve()));await new Promise<void>(resolve=>app.close(()=>resolve()));},
 };
}
const checking=(f:Awaited<ReturnType<typeof fixture>>)=>f.received.filter(event=>event.type==='voice.recovery'&&event.state==='checking');
const recovered=(f:Awaited<ReturnType<typeof fixture>>)=>f.received.filter(event=>event.type==='voice.recovery'&&event.state==='recovered');
async function probe(f:Awaited<ReturnType<typeof fixture>>,id='new-probe-response',audio=voiced){
 await waitFor(()=>f.probeUpdates.length===1);assert(String(f.probeUpdates[0].session?.instructions).includes('CURRENT_RULES'));
 const before=f.sent.filter(event=>event.type==='response.create').length;assert.equal(before,1,'The probe must wait for its matching configuration echo.');
 f.ackProbe();await waitFor(()=>f.probeCreates.length===1);
 f.emit({type:'response.created',response:{id}});f.emit({type:'response.audio.delta',response_id:id,delta:audio});f.emit({type:'response.done',response:{id,status:'completed'}});
}
async function complete(f:Awaited<ReturnType<typeof fixture>>){
 await probe(f);await waitFor(()=>f.restoreUpdates.length===1);
 assert.notEqual(f.restoreUpdates[0].session?.instructions,f.probeUpdates[0].session?.instructions,'Validation instructions must not remain resident.');
 assert(String(f.restoreUpdates[0].session?.instructions).includes('CURRENT_RULES'));
 assert.equal(recovered(f).length,0,'Generation alone must not bypass normal configuration restoration.');
 f.ackRestore();await waitFor(()=>recovered(f).length===1);f.finishRecovery();
}

test('Qwen request recovery validates configuration, isolates a new audible probe, restores rules and continues without replaying the old question',async()=>{
 const f=await fixture();try{
  await f.start();const audioBefore=f.received.filter(event=>event.type==='audio').length,interruptsBefore=f.received.filter(event=>event.type==='interrupt').length;
  const startedBefore=f.received.filter(event=>event.type==='diagnostic.response'&&event.state==='started').length;
  const measurementsBefore=new Set(f.journal.map(event=>(event.details as {measurementId?:string}|undefined)?.measurementId).filter(Boolean));
  f.fault();await waitFor(()=>checking(f).length===1);await waitFor(()=>f.probeUpdates.length===1);f.ackProbe();await waitFor(()=>f.probeCreates.length===1);
  f.emit({type:'response.created',response:{id:'isolated-probe'}});
  f.emit({type:'response.audio_transcript.done',response_id:'isolated-probe',item_id:'technical-only',transcript:'TECHNICAL_PROBE_DO_NOT_PERSIST'});
  f.emit({type:'response.audio.delta',response_id:'isolated-probe',delta:voiced});f.emit({type:'response.done',response:{id:'isolated-probe',status:'completed'}});
  await waitFor(()=>f.restoreUpdates.length===1);assert.equal(recovered(f).length,0);
  assert.equal(f.received.filter(event=>event.type==='audio').length,audioBefore);assert.equal(f.tools,0);assert.equal(f.transcripts.length,0);
  assert.equal(f.received.filter(event=>event.type==='diagnostic.response'&&event.state==='started').length,startedBefore);
  assert(f.journal.every(event=>{const id=(event.details as {measurementId?:string}|undefined)?.measurementId;return !id||measurementsBefore.has(id);}), 'A transport probe must not create a learner latency measurement.');
  assert(!JSON.stringify(f.journal).includes('TECHNICAL_PROBE_DO_NOT_PERSIST'));
  f.ackRestore();await waitFor(()=>recovered(f).length===1);f.finishRecovery();
  assert.equal(f.received.filter(event=>event.type==='interrupt').length,interruptsBefore,'Verification must not stop audio already delivered to the browser.');
  assert.equal(f.released,0);assert.equal(f.client.readyState,WebSocket.OPEN);assert.equal(f.sent.filter(event=>event.type==='response.create').length,2,'A recovered connection must not replay its old teaching question.');
  f.client.send(JSON.stringify({type:'text',text:'Can we continue?'}));await waitFor(()=>f.sent.filter(event=>event.type==='response.create').length===3);
 }finally{await f.close();}
});

test('Qwen invalid_value with no parameter uses the same one-time verification flow',async()=>{
 const f=await fixture();try{await f.start();f.fault({code:'invalid_value',param:null});await complete(f);assert.equal(f.released,0);}finally{await f.close();}
});

test('a previously unrecognized request code still requires the full positive verification sequence',async()=>{
 const f=await fixture();try{await f.start();f.fault({code:'unrecognized_fixture_code',param:null});await complete(f);assert.equal(f.released,0);}finally{await f.close();}
});

test('recovery may wait for a pending application check and then configures its newest authoritative revision',async()=>{
 const f=await fixture({delayedTool:true,timeoutMs:600});try{
  await f.start();f.emit({type:'input_audio_buffer.speech_started',item_id:'current-input'});f.emit({type:'input_audio_buffer.speech_stopped',item_id:'current-input'});f.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'current-input',transcript:'Tell me something.'});
  await waitFor(()=>f.tools===1);f.emit({type:'response.created',response:{id:'native-before-error'}});f.emit({type:'response.audio.delta',response_id:'native-before-error',delta:voiced});f.emit({type:'response.done',response:{id:'native-before-error',status:'completed'}});
  f.fault();await waitFor(()=>checking(f).length===1);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.probeUpdates.length,0);
  f.releaseTool();await waitFor(()=>f.probeUpdates.length===1);assert(String(f.probeUpdates[0].session?.instructions).includes('FIXTURE_REVISION_2'));
  await complete(f);assert.equal(f.released,0);
 }finally{await f.close();}
});

test('recovery waits for an already pending point transaction and never replays its interrupted reply',async()=>{
 const f=await fixture({delayedPoint:true,timeoutMs:600});try{
  await f.start();const pointId=f.point();await waitFor(()=>f.points.length===1);
  f.fault();await waitFor(()=>checking(f).length===1);await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.probeUpdates.length,0,'The probe cannot overtake a point persistence operation.');
  f.releasePoint();await waitFor(()=>f.probeUpdates.length===1);assert(String(f.probeUpdates[0].session?.instructions).includes('FIXTURE_REVISION_2'));
  await complete(f);assert.equal(f.points.length,1);assert.equal(f.snapshot.outcomes.length,0);assert.equal(f.sent.filter(event=>event.type==='response.create').length,2);
  assert(f.journal.some(event=>event.name==='point_trace'&&(event.details as {pointId?:string;pointStage?:string}|undefined)?.pointId===pointId&&(event.details as {pointStage?:string}|undefined)?.pointStage==='cancelled'),'An interrupted persisted point needs an explicit cancellation trace.');
  assert.equal(f.released,0);
 }finally{await f.close();}
});

test('a nonexplicit task change while recovery waits for application work closes before starting a probe',async()=>{
 const f=await fixture({delayedPoint:true,timeoutMs:600});try{
  await f.start();f.point();await waitFor(()=>f.points.length===1);
  f.fault();await waitFor(()=>checking(f).length===1);assert.equal(f.probeUpdates.length,0);
  await f.changeTask(false);await waitFor(()=>f.released===1);
  assert.equal(f.probeUpdates.length,0);assert.equal(f.probeCreates.length,0);assert.equal(recovered(f).length,0);
  assert(f.journal.some(event=>event.name==='voice_request_recovery'&&(event.details as {errorCode?:string}|undefined)?.errorCode==='request_recovery_context_changed'));
 }finally{await f.close();}
});

test('speech and ASR identities quarantined during verification cannot become fresh learner evidence after recovery',async()=>{
 const f=await fixture({nativeInputs:true});try{
  await f.start();f.fault();await waitFor(()=>checking(f).length===1);
  await f.provider({type:'input_audio_buffer.speech_started',item_id:'quarantined-started'});
  await f.provider({type:'conversation.item.input_audio_transcription.delta',item_id:'quarantined-asr-only',delta:'OLD_ASR_FRAGMENT'});
  await complete(f);
  for(const itemId of ['quarantined-started','quarantined-asr-only']){
   await f.provider({type:'conversation.item.input_audio_transcription.completed',item_id:itemId,transcript:'OLD_INPUT_MUST_NOT_RETURN'});
   await f.provider({type:'conversation.item.input_audio_transcription.failed',item_id:itemId});
  }
  await f.provider({type:'conversation.item.input_audio_transcription.completed',transcript:'UNBOUND_OLD_INPUT'});
  assert.equal(f.transcripts.length,0);assert.equal(f.tools,0);assert(!JSON.stringify(f.journal).includes('OLD_INPUT'));assert(!f.journal.some(event=>event.name==='input_transcription_failed'));
  f.emit({type:'input_audio_buffer.speech_started',item_id:'fresh-after-recovery'});f.emit({type:'input_audio_buffer.speech_stopped',item_id:'fresh-after-recovery'});
  f.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'fresh-after-recovery',transcript:'A new ordinary conversation.'});
  await waitFor(()=>f.transcripts.length===1&&f.tools===1);assert.equal(f.released,0);
 }finally{await f.close();}
});

test('retired probe IDs cannot contaminate a subsequent legitimate point response or its latency trace',async()=>{
 const f=await fixture();try{
  await f.start();f.fault();await complete(f);f.point();await waitFor(()=>f.sent.filter(event=>event.type==='response.create').length===3);
  f.emit({type:'response.created',response:{id:'legitimate-point-response'}});await f.provider({type:'test-barrier'});
  const audioBefore=f.received.filter(event=>event.type==='audio').length,startedBefore=f.received.filter(event=>event.type==='diagnostic.response'&&event.state==='started').length;
  f.emit({type:'response.audio.delta',response_id:'new-probe-response',delta:voiced});
  f.emit({type:'response.audio_transcript.delta',response_id:'new-probe-response',item_id:'retired-probe-text',delta:'RETIRED_PROBE_TEXT'});
  f.emit({type:'response.audio_transcript.done',response_id:'new-probe-response',item_id:'retired-probe-text',transcript:'RETIRED_PROBE_TEXT'});
  f.emit({type:'response.function_call_arguments.done',response_id:'new-probe-response',call_id:'retired-probe-tool',name:'highlight_objects',arguments:JSON.stringify({contextKey:`${f.id}:1:1`,objectIds:['apple']})});
  f.emit({type:'response.created',response:{id:'new-probe-response'}});await f.provider({type:'response.done',response:{id:'new-probe-response',status:'completed'}});
  await new Promise(resolve=>setTimeout(resolve,70));assert.equal(f.received.filter(event=>event.type==='audio').length,audioBefore);assert.equal(f.received.filter(event=>event.type==='diagnostic.response'&&event.state==='started').length,startedBefore);assert.equal(f.tools,0);assert.equal(f.transcripts.length,0);assert(!JSON.stringify(f.journal).includes('RETIRED_PROBE_TEXT'));
  f.emit({type:'response.audio.delta',response_id:'legitimate-point-response',delta:voiced});f.emit({type:'response.audio_transcript.done',response_id:'legitimate-point-response',item_id:'normal-point-text',transcript:'You pointed to the apple.'});f.emit({type:'response.done',response:{id:'legitimate-point-response',status:'completed'}});
  await waitFor(()=>f.received.filter(event=>event.type==='audio').length===audioBefore+1);
  const audio=f.received.filter(event=>event.type==='audio').at(-1)!;assert.equal(typeof audio.diagnosticSpanId,'string');assert.equal(f.snapshot.outcomes.length,0);assert.equal(f.released,0);
 }finally{await f.close();}
});

for(const kind of ['stale_ack','stale_restore','old_response','foreign_audio','silent_probe','failed_probe','no_response','task_change','revision_change','probe_tool'] as const)test(`request recovery cannot accept ${kind} as positive evidence`,async()=>{
 const f=await fixture({timeoutMs:100});try{
  await f.start();f.fault();await waitFor(()=>f.probeUpdates.length===1);
  if(kind==='stale_ack')f.emit({type:'session.updated',session:{instructions:'CURRENT_RULES stale normal configuration'}});
  else if(kind==='no_response'){f.ackProbe();await waitFor(()=>f.probeCreates.length===1);}
  else if(kind==='task_change'){await f.changeTask();}
  else if(kind==='revision_change'){await f.changeRevision();}
  else if(kind==='probe_tool'){f.ackProbe();await waitFor(()=>f.probeCreates.length===1);f.emit({type:'response.created',response:{id:'tool-probe'}});f.emit({type:'response.function_call_arguments.done',response_id:'tool-probe',name:'highlight_objects',call_id:'never-execute-probe-tool',arguments:JSON.stringify({contextKey:`${f.id}:1:1`,objectIds:['apple']})});}
  else if(kind==='stale_restore'){await probe(f);await waitFor(()=>f.restoreUpdates.length===1);f.emit({type:'session.updated',session:f.probeUpdates[0].session});}
  else if(kind==='foreign_audio'||kind==='failed_probe'){f.ackProbe();await waitFor(()=>f.probeCreates.length===1);f.emit({type:'response.created',response:{id:'current-probe'}});f.emit({type:'response.audio.delta',response_id:kind==='foreign_audio'?'foreign-response':'current-probe',delta:voiced});f.emit({type:'response.done',response:{id:'current-probe',status:kind==='failed_probe'?'failed':'completed'}});}
  else await probe(f,kind==='old_response'?'greeting-response':'silent-probe',kind==='silent_probe'?silent:voiced);
  await waitFor(()=>f.released===1);assert.equal(recovered(f).length,0);
 }finally{await f.close();}
});

test('checking blocks business inputs without inventing transcripts, executing annotations or forwarding queued media',async()=>{
 const f=await fixture();try{
  await f.start();f.fault();await waitFor(()=>checking(f).length===1);
  const audioCount=f.sent.filter(event=>event.type==='input_audio_buffer.append').length;
  f.client.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200,0x11).toString('base64')}));
  f.client.send(JSON.stringify({type:'text',text:'SHOULD_NOT_BECOME_TRANSCRIPT'}));
  f.client.send(JSON.stringify({type:'interaction',eventId:randomUUID(),contextKey:`${f.id}:1:1`,action:'draw',strokeCount:1,pointCount:2}));
  const scope=captureClassroomToolState(f.snapshot);assert(scope.ok);
  f.client.send(JSON.stringify({type:'interaction.point',eventId:randomUUID(),context:scope.snapshot.context,objectId:'apple'}));
  const pongs=f.received.filter(event=>event.type==='pong').length;
  f.client.send(JSON.stringify({type:'ping'}));await waitFor(()=>f.received.filter(event=>event.type==='pong').length>pongs);
  assert.equal(f.sent.filter(event=>event.type==='input_audio_buffer.append').length,audioCount);assert.equal(f.transcripts.length,0);assert.equal(f.tools,0);assert.equal(f.points.length,0);assert(!f.journal.some(event=>event.name==='annotation'));assert(!JSON.stringify(f.journal).includes('SHOULD_NOT_BECOME_TRANSCRIPT'));
  await complete(f);assert.equal(f.released,0);
 }finally{await f.close();}
});

test('a repeated request error during checking closes instead of recursively validating',async()=>{
 const f=await fixture();try{await f.start();f.fault();await waitFor(()=>checking(f).length===1);f.fault();await waitFor(()=>f.released===1);assert.equal(checking(f).length,1);assert.equal(recovered(f).length,0);}finally{await f.close();}
});

test('a connection gets only one recovery even when its first validation succeeded',async()=>{
 const f=await fixture();try{await f.start();f.fault();await complete(f);f.fault();await waitFor(()=>f.released===1);assert.equal(checking(f).length,1);assert.equal(recovered(f).length,1);}finally{await f.close();}
});

for(const error of [{code:'invalid_api_key'},{code:'insufficient_quota'},{type:'server_error'},{message:'Input data may contain inappropriate content.'},{param:'input_audio_buffer.append'},{param:'session.modalities'}])test(`recovery never softens a fatal error ${JSON.stringify(error)}`,async()=>{
 const f=await fixture();try{await f.start();f.fault(error);await waitFor(()=>f.released===1);assert.equal(checking(f).length,0);assert.equal(f.probeUpdates.length,0);}finally{await f.close();}
});

for(const pending of ['configuration','response','vad'] as const)test(`a pending provider ${pending} prevents speculative recovery`,async()=>{
 const f=await fixture();try{
  await f.start();
  if(pending==='configuration')await f.feedback();
  if(pending==='response'){f.client.send(JSON.stringify({type:'text',text:'Another thought.'}));await waitFor(()=>f.sent.filter(event=>event.type==='response.create').length===2);}
  if(pending==='vad'){f.emit({type:'input_audio_buffer.speech_stopped',item_id:'still-waiting'});await f.provider({type:'test-barrier'});}
  f.fault();await waitFor(()=>f.released===1);assert.equal(checking(f).length,0);
 }finally{await f.close();}
});

test('request verification is not applied to another voice provider',async()=>{
 const f=await fixture({provider:'grok'});try{await f.start();f.fault();await waitFor(()=>f.released===1);assert.equal(checking(f).length,0);}finally{await f.close();}
});

test('an older client without a capability handshake is not left silently waiting in verification',async()=>{
 const f=await fixture({capable:false});try{await f.start();f.fault();await waitFor(()=>f.released===1);assert.equal(checking(f).length,0);}finally{await f.close();}
});

test('an unfinished native speech window prevents recovery even before VAD creates a response',async()=>{
 const f=await fixture();try{await f.start();await f.provider({type:'input_audio_buffer.speech_started',item_id:'still-speaking'});f.fault();await waitFor(()=>f.released===1);assert.equal(checking(f).length,0);}finally{await f.close();}
});

test('recent audible local PCM prevents recovery before a provider speech-start receipt',async()=>{
 const f=await fixture();try{
  await f.start();const pongs=f.received.filter(event=>event.type==='pong').length;f.client.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200,0x11).toString('base64')}));f.client.send(JSON.stringify({type:'ping'}));await waitFor(()=>f.received.filter(event=>event.type==='pong').length>pongs);
  f.fault();await waitFor(()=>f.released===1);assert.equal(checking(f).length,0);
 }finally{await f.close();}
});

test('a restored configuration cannot recover a lease revoked before the final heartbeat',async()=>{
 const f=await fixture();try{await f.start();f.fault();await probe(f);await waitFor(()=>f.restoreUpdates.length===1);f.revoke();f.ackRestore();await waitFor(()=>f.released===1);assert.equal(recovered(f).length,0);}finally{await f.close();}
});
