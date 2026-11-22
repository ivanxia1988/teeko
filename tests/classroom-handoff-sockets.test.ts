import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws';
import {attachClassroomSockets,type VoiceLease} from '../lib/server/classroom-sockets';
import {refreshClassroom} from '../lib/server/classroom-events';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import {ROBOT_READING_COURSE} from '../lib/server/robot-reading-course';
import {teacherSnapshot} from './teacher-runtime-fixture';
import type {ClassroomSnapshot} from '../lib/classroom-contract';
import type {ClassroomToolRequest} from '../lib/domain/classroom-tool';

type WireEvent={type?:string;id?:string;audio?:string;playbackId?:number;session?:{instructions?:string};classroom?:ClassroomSnapshot};
const waitFor=async(check:()=>boolean,message:string)=>{const until=Date.now()+3000;while(!check()){if(Date.now()>=until)throw Error(message);await new Promise(resolve=>setTimeout(resolve,5));}};
const pcm=(sample:number)=>{const bytes=Buffer.alloc(2400);for(let i=0;i<bytes.length;i+=2)bytes.writeInt16LE(sample,i);return bytes.toString('base64');};

async function fixture(){
 const id=randomUUID(),vendorHttp=createServer(),vendor=new WebSocketServer({server:vendorHttp}),app=createServer();
 const sent:WireEvent[]=[],downstream:WireEvent[]=[],requests:ClassroomToolRequest[]=[],transcripts:string[]=[];
 let peer:WebSocket|undefined,finishTool:(()=>void)|undefined,afterHeartbeats=0,toolReleased=false;
 const initial=teacherSnapshot({id,course:ROBOT_READING_COURSE,stepIndex:0,profile:{name:'Synthetic learner',ageRange:'12–13',level:'sentences'}});
 let current=initial,committed:ClassroomSnapshot|undefined;
 const advance=()=>{current={...current,stepIndex:1,revision:current.revision+1,outcomes:[{stepId:initial.course.steps[0].id,status:'independent'}]};committed=current;};
 const reference=()=>({snapshot:current,instructions:`Synthetic task ${current.course.steps[current.stepIndex].id}.`});
 vendor.on('connection',socket=>{peer=socket;socket.on('message',raw=>{
  const event=JSON.parse(raw.toString()) as WireEvent;sent.push(event);
  if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));
  if(event.type==='response.create'){socket.send(JSON.stringify({type:'response.created',response:{id:`application-${sent.length}`}}));socket.send(JSON.stringify({type:'response.done'}));}
 });socket.send(JSON.stringify({type:'session.created',session:{id:'synthetic-handoff'}}));});
 vendorHttp.listen(0,'127.0.0.1');await once(vendorHttp,'listening');const vendorAddress=vendorHttp.address();assert(vendorAddress&&typeof vendorAddress!=='string');
 const lease:VoiceLease&{nativeApplicationInputs:true}={id,epoch:1,provider:'qwen',...reference(),nativeApplicationInputs:true,remainingMs:900000,initialCue:initial.course.steps[0].english,
  heartbeat:async()=>{if(current.stepIndex===1)afterHeartbeats++;return reference();},
  transcript:async event=>{if(event.role==='child')transcripts.push(event.text);},
  tool:async(name,_args,callId,request)=>{
   assert.equal(name,'delegate');assert(request);assert.equal(request.source,'application');assert.equal(request.command.name,'delegate');requests.push(request);
   await new Promise<void>(resolve=>{finishTool=resolve;});
   toolReleased=true;const snapshot=committed??current,before=captureClassroomToolState(initial),after=captureClassroomToolState(snapshot);assert(before.ok&&after.ok);assert(callId);
   return{snapshot,output:{status:'confirmed',english:'The previous answer was checked. Follow the learner naturally.'},execution:{type:'tool.advance',requestId:request.id,callId,before:before.snapshot.context,after:after.snapshot.context}};
  },closed:async()=>{}};
 const owner=attachClassroomSockets(app,{origin:'http://localhost:8080',open:async()=>lease,config:()=>({key:'non-production-fixture',model:'qwen3.8-omni-flash-realtime',voice:'Tina',workspaceId:'synthetic',region:'cn-beijing'}),connect:()=>new WebSocket(`ws://127.0.0.1:${vendorAddress.port}`),heartbeatMs:60000,startupMs:2000,closeMs:30,connectionProbeMs:60000,silencePromptMs:60000});
 app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert(address&&typeof address!=='string');
 const client=new WebSocket(`ws://127.0.0.1:${address.port}/ws/classrooms/${id}`,{headers:{Origin:'http://localhost:8080',Cookie:`teeko_session=${'h'.repeat(43)}`}});
 client.on('error',()=>{});client.on('message',raw=>downstream.push(JSON.parse(raw.toString()) as WireEvent));
 return{client,sent,downstream,requests,transcripts,id,
  send(event:unknown){assert(peer);peer.send(JSON.stringify(event));},
  async settle(){await once(client,'open');await waitFor(()=>downstream.some(event=>event.type==='ready')&&sent.some(event=>event.type==='response.create'),'Synthetic greeting did not settle.');assert(peer);const pong=once(peer,'pong');peer.ping('handoff-ready');await pong;},
  async flush(){assert(peer);const pong=once(peer,'pong');peer.ping('handoff-flush');await pong;await new Promise(resolve=>setTimeout(resolve,25));},
  async commit(){assert(finishTool);advance();finishTool();await waitFor(()=>afterHeartbeats>0,'Checked advance did not read its authoritative snapshot.');await refreshClassroom(id);await new Promise(resolve=>setTimeout(resolve,25));},
  async advanceBeforeReceipt(){assert(finishTool);advance();await refreshClassroom(id);await new Promise(resolve=>setTimeout(resolve,25));},
  async releaseTool(){assert(finishTool);finishTool();await waitFor(()=>toolReleased,'Tool result was not released.');await new Promise(resolve=>setTimeout(resolve,25));},
  async pause(){current={...current,status:'paused',revision:current.revision+1};await refreshClassroom(id,'explicit_navigation');await new Promise(resolve=>setTimeout(resolve,25));},
  async manualTask(stepIndex:number){current={...current,stepIndex,revision:current.revision+1};await refreshClassroom(id,'explicit_navigation');await new Promise(resolve=>setTimeout(resolve,25));},
  async refresh(){await refreshClassroom(id);},
  async close(){finishTool?.();client.terminate();await owner.close();for(const socket of vendor.clients)socket.terminate();await new Promise<void>(resolve=>vendor.close(()=>resolve()));await new Promise<void>(resolve=>vendorHttp.close(()=>resolve()));await new Promise<void>(resolve=>app.close(()=>resolve()));}
 };
}

test('checked native input advance retains the current reply through refresh and browser drain without a second question',async()=>{
 const f=await fixture();
 try{
  await f.settle();const creates=f.sent.filter(event=>event.type==='response.create').length;
  f.send({type:'input_audio_buffer.speech_started',item_id:'learner-answer'});
  f.send({type:'input_audio_buffer.speech_stopped',item_id:'learner-answer'});
  f.send({type:'conversation.item.input_audio_transcription.completed',item_id:'learner-answer',transcript:'It can fly.'});
  await waitFor(()=>f.requests.length===1,'Native final input was not checked by the application delegate.');assert.deepEqual(f.transcripts,['It can fly.']);
  f.send({type:'response.created',response:{id:'native-answer'}});
  f.send({type:'response.audio.delta',response_id:'native-answer',delta:pcm(1200)});
  await waitFor(()=>f.downstream.some(event=>event.type==='audio'),'Native reply did not reach the browser.');
  const outputStart=f.downstream.length,interrupts=f.downstream.filter(event=>event.type==='interrupt').length;
  await f.commit();
  assert.equal(f.downstream.filter(event=>event.type==='interrupt').length,interrupts,'A checked task refresh cut off the native reply.');
  assert.equal(f.downstream.some(event=>event.type==='snapshot'&&event.classroom?.stepIndex===1),false,'New context applied before the existing reply drained.');
  f.send({type:'response.audio.delta',response_id:'native-answer',delta:pcm(2200)});
  await waitFor(()=>f.downstream.slice(outputStart).some(event=>event.type==='audio'),'Remaining native audio was discarded after the advance.');
  f.send({type:'response.done',response:{id:'native-answer',status:'completed'}});
  await waitFor(()=>f.downstream.slice(outputStart).some(event=>event.type==='playback.probe'),'Completed native reply did not request browser drain.');
  assert.equal(f.downstream.some(event=>event.type==='snapshot'&&event.classroom?.stepIndex===1),false,'Generation completion was mistaken for actual playback completion.');
  const probe=f.downstream.findLast(event=>event.type==='playback.probe')!,audio=f.downstream.findLast(event=>event.type==='audio')!;
  f.client.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));
  await waitFor(()=>f.downstream.some(event=>event.type==='snapshot'&&event.classroom?.stepIndex===1),'Drained handoff did not apply the next task.');
  await waitFor(()=>f.sent.some(event=>event.type==='session.update'&&event.session?.instructions?.includes('prediction-clue')),'Next teacher context was not applied.');
  assert.equal(f.sent.filter(event=>event.type==='response.create').length,creates,'Verified advance issued a duplicate application question.');
  assert.equal(f.downstream.filter(event=>event.type==='interrupt').length,interrupts,'Silent context application interrupted completed playback.');
  assert.equal(f.requests.length,1);assert.equal(f.downstream.some(event=>event.type==='error'),false);
 }finally{await f.close();}
});

async function learnerFinal(f:Awaited<ReturnType<typeof fixture>>){
 f.send({type:'input_audio_buffer.speech_started',item_id:'learner-answer'});
 f.send({type:'input_audio_buffer.speech_stopped',item_id:'learner-answer'});
 f.send({type:'conversation.item.input_audio_transcription.completed',item_id:'learner-answer',transcript:'It can fly.'});
 await waitFor(()=>f.requests.length===1,'Native input did not reach the delegate.');
}
async function nativeReply(f:Awaited<ReturnType<typeof fixture>>){
 f.send({type:'response.created',response:{id:'native-answer'}});
 f.send({type:'response.audio.delta',response_id:'native-answer',delta:pcm(1200)});
 await waitFor(()=>f.downstream.some(event=>event.type==='audio'),'Native reply audio did not arrive.');
}

test('a heartbeat arriving before the checked receipt preserves audio until that receipt and browser drain',async()=>{
 const f=await fixture();
 try{
  await f.settle();await learnerFinal(f);await nativeReply(f);
  const interrupts=f.downstream.filter(event=>event.type==='interrupt').length,creates=f.sent.filter(event=>event.type==='response.create').length;
  await f.advanceBeforeReceipt();
  assert.equal(f.downstream.filter(event=>event.type==='interrupt').length,interrupts,'Early heartbeat cut off an unverified handoff.');
  assert.equal(f.downstream.some(event=>event.type==='snapshot'&&event.classroom?.stepIndex===1),false);
  const audioCount=f.downstream.filter(event=>event.type==='audio').length;f.send({type:'response.audio.delta',response_id:'native-answer',delta:pcm(2200)});
  await waitFor(()=>f.downstream.filter(event=>event.type==='audio').length>audioCount,'Early heartbeat discarded active audio.');
  await f.releaseTool();f.send({type:'response.done',response:{id:'native-answer',status:'completed'}});
  await waitFor(()=>f.downstream.some(event=>event.type==='playback.probe'),'Checked reply did not request drain.');
  const probe=f.downstream.findLast(event=>event.type==='playback.probe')!,audio=f.downstream.findLast(event=>event.type==='audio')!;
  f.client.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));
  await waitFor(()=>f.downstream.some(event=>event.type==='snapshot'&&event.classroom?.stepIndex===1),'Early heartbeat was never applied.');
  assert.equal(f.downstream.filter(event=>event.type==='interrupt').length,interrupts);assert.equal(f.sent.filter(event=>event.type==='response.create').length,creates);
 }finally{await f.close();}
});

test('duplicate native final events admit one semantic check and no duplicate cue',async()=>{
 const f=await fixture();
 try{
  await f.settle();await learnerFinal(f);
  f.send({type:'conversation.item.input_audio_transcription.completed',item_id:'learner-answer',transcript:'It can fly.'});await f.flush();
  assert.equal(f.requests.length,1);assert.deepEqual(f.transcripts,['It can fly.']);
  f.send({type:'response.created',response:{id:'empty-native'}});f.send({type:'response.done',response:{id:'empty-native',status:'completed'}});await f.flush();
  const creates=f.sent.filter(event=>event.type==='response.create').length;await f.commit();
  await waitFor(()=>f.downstream.some(event=>event.type==='snapshot'&&event.classroom?.stepIndex===1),'Empty reply handoff did not apply.');
  await waitFor(()=>f.sent.filter(event=>event.type==='response.create').length===creates+1,'Empty native reply did not produce its one next cue.');
  await f.refresh();await f.flush();assert.equal(f.sent.filter(event=>event.type==='response.create').length,creates+1);
  assert.equal(f.requests.length,1);assert.equal(f.downstream.some(event=>event.type==='error'),false);
 }finally{await f.close();}
});

test('new learner speech revokes a checked handoff, rejects its old drain receipt and discards the remaining old audio',async()=>{
 const f=await fixture();
 try{
  await f.settle();await learnerFinal(f);await nativeReply(f);await f.commit();
  f.send({type:'response.done',response:{id:'native-answer',status:'completed'}});
  await waitFor(()=>f.downstream.some(event=>event.type==='playback.probe'),'Checked reply did not request drain.');
  const probe=f.downstream.findLast(event=>event.type==='playback.probe')!,audio=f.downstream.findLast(event=>event.type==='audio')!,audioCount=f.downstream.filter(event=>event.type==='audio').length;
  const creates=f.sent.filter(event=>event.type==='response.create').length;
  f.send({type:'input_audio_buffer.speech_started',item_id:'new-learner-turn'});await f.flush();
  f.client.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));
  f.send({type:'response.audio.delta',response_id:'native-answer',delta:pcm(2200)});await f.flush();
  assert.equal(f.downstream.filter(event=>event.type==='audio').length,audioCount,'Old reply resumed after new speech.');
  assert(f.downstream.some(event=>event.type==='snapshot'&&event.classroom?.stepIndex===1));
  assert.equal(f.sent.filter(event=>event.type==='response.create').length,creates,'Revocation replayed an old application cue.');
  assert.equal(f.downstream.some(event=>event.type==='error'),false);
 }finally{await f.close();}
});

for(const phase of ['before_receipt','after_receipt'] as const)test(`manual pause ${phase} revokes the handoff and stops old native audio`,async()=>{
 const f=await fixture();
 try{
  await f.settle();await learnerFinal(f);await nativeReply(f);if(phase==='after_receipt')await f.commit();
  await f.pause();const count=f.downstream.filter(event=>event.type==='audio').length;
  assert(f.downstream.some(event=>event.type==='snapshot'&&event.classroom?.status==='paused'),'Pause was hidden behind the handoff.');
  f.send({type:'response.audio.delta',response_id:'native-answer',delta:pcm(2200)});f.send({type:'response.done',response:{id:'native-answer',status:'completed'}});await f.flush();
  assert.equal(f.downstream.filter(event=>event.type==='audio').length,count,'Paused classroom forwarded the stale native response.');
  f.send({type:'response.created',response:{id:'late-paused-native'}});
  f.send({type:'response.audio.delta',response_id:'late-paused-native',delta:pcm(2200)});await f.flush();
  assert.equal(f.downstream.filter(event=>event.type==='audio').length,count,'A late native response reopened audio while paused.');
 }finally{await f.close();}
});

test('an explicit nonadjacent task change supersedes an unverified handoff and rejects its delayed receipt',async()=>{
 const f=await fixture();
 try{
  await f.settle();await learnerFinal(f);await nativeReply(f);await f.advanceBeforeReceipt();await f.manualTask(2);
  await waitFor(()=>f.downstream.some(event=>event.type==='snapshot'&&event.classroom?.stepIndex===2),'Manual task change was hidden by the pending advance.');
  const count=f.downstream.filter(event=>event.type==='audio').length;await f.releaseTool();
  f.send({type:'response.audio.delta',response_id:'native-answer',delta:pcm(2200)});f.send({type:'response.done',response:{id:'native-answer',status:'completed'}});await f.flush();
  assert.equal(f.downstream.filter(event=>event.type==='audio').length,count);assert.equal(f.downstream.findLast(event=>event.type==='snapshot')?.classroom?.stepIndex,2);
 }finally{await f.close();}
});

test('an explicit next action cannot be held as a verified automatic advance while the old semantic check is pending',async()=>{
 const f=await fixture();
 try{
  await f.settle();await learnerFinal(f);await nativeReply(f);await f.manualTask(1);
  assert(f.downstream.some(event=>event.type==='snapshot'&&event.classroom?.stepIndex===1),'The explicit next action was hidden by an unrelated pending semantic check.');
  const count=f.downstream.filter(event=>event.type==='audio').length;
  f.send({type:'response.audio.delta',response_id:'native-answer',delta:pcm(2200)});await f.flush();
  assert.equal(f.downstream.filter(event=>event.type==='audio').length,count,'Explicit next kept playing the previous task.');
 }finally{await f.close();}
});
