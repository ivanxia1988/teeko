import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws';
import {attachClassroomSockets,type VoiceLease} from '../lib/server/classroom-sockets';
import {refreshClassroom} from '../lib/server/classroom-events';
import {ROBOT_READING_COURSE} from '../lib/server/robot-reading-course';
import {teacherSnapshot} from './teacher-runtime-fixture';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import type {ClassroomSnapshot} from '../lib/classroom-contract';
type Wire={type?:string;id?:string;content?:string;event_id?:string;audio?:string;playbackId?:number;classroom?:ClassroomSnapshot};
const waitFor=async(check:()=>boolean,message='Expected event did not arrive')=>{const until=Date.now()+2500;while(!check()){if(Date.now()>=until)throw Error(message);await new Promise(resolve=>setTimeout(resolve,5));}};
const pcm=(sample:number,ms=100)=>{const bytes=Buffer.alloc(ms*48);for(let i=0;i<bytes.length;i+=2)bytes.writeInt16LE(sample,i);return bytes.toString('base64');};
async function fixture(lab=false,gptAdvanceWaitMs?:number,toolAdvance=false,packagedReading=false){
 const id=randomUUID(),upHttp=createServer(),vendor=new WebSocketServer({server:upHttp}),app=createServer();
 const sent:Wire[]=[],down:Wire[]=[],transcripts:Array<{text:string;contextKey:string}>=[];let peer:WebSocket|undefined;
 let toolCalls=0;
 const course=packagedReading?{...ROBOT_READING_COURSE,topic:{category:'science' as const,difficulty:'starter' as const}}:ROBOT_READING_COURSE;
 let current=teacherSnapshot({id,course,stepIndex:0});
 const reference=()=>({snapshot:current,instructions:`Synthetic task ${current.stepIndex}.`});
 vendor.on('connection',socket=>{peer=socket;socket.on('message',raw=>{const event=JSON.parse(raw.toString()) as Wire;sent.push(event);if(event.type==='session.thinking.append')socket.send(JSON.stringify({type:'session.thinking.appended',client_event_id:event.event_id}));if(event.type==='session.close')socket.send(JSON.stringify({type:'session.closed'}));});socket.send(JSON.stringify({type:'session.started',session:{id:'synthetic-gpt-flow'}}));});
 upHttp.listen(0,'127.0.0.1');await once(upHttp,'listening');const up=upHttp.address();assert(up&&typeof up!=='string');
 const lease:VoiceLease={id,epoch:1,provider:'openai',...reference(),...(lab?{labCompletedSpeech:true as const}:{}),remainingMs:600000,initialCue:'Describe the robot.',heartbeat:async()=>reference(),transcript:async e=>{if(e.role==='child'&&e.final)transcripts.push({text:e.text,contextKey:e.contextKey});},tool:async(_name,_args,callId,request)=>{
   toolCalls++;
   if(!toolAdvance)return{output:{status:'conversation'},snapshot:current};
   assert(request);assert(callId);const before=captureClassroomToolState(current);assert(before.ok);
   current={...current,revision:current.revision+1,stepIndex:1};const after=captureClassroomToolState(current);assert(after.ok);
   return{output:{status:'confirmed',english:'The learner participation was recorded. Continue naturally.'},snapshot:current,execution:{type:'tool.advance' as const,requestId:request.id,callId,before:before.snapshot.context,after:after.snapshot.context}};
  },closed:async()=>{}};
 const owner=attachClassroomSockets(app,{origin:'http://localhost:8080',open:async()=>lease,config:()=>({key:'fixture-not-real',model:'gpt-live-1',voice:'gleam',childDataReady:true}),connect:()=>new WebSocket(`ws://127.0.0.1:${up.port}`),heartbeatMs:60000,startupMs:2000,closeMs:30,gptAdvanceWaitMs,silencePromptEnabled:false,connectionProbeMs:60000});
 app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert(address&&typeof address!=='string');
 const client=new WebSocket(`ws://127.0.0.1:${address.port}/ws/classrooms/${id}`,{headers:{Origin:'http://localhost:8080',Cookie:`teeko_session=${'f'.repeat(43)}`}});client.on('error',()=>{});client.on('message',raw=>down.push(JSON.parse(raw.toString()) as Wire));
 await once(client,'open');await waitFor(()=>down.some(e=>e.type==='ready')&&sent.some(e=>e.type==='session.commentary.append'));
 const flush=async()=>{assert(peer);const pong=once(peer,'pong');peer.ping('flush');await pong;await new Promise(resolve=>setTimeout(resolve,30));};
 return {client,down,sent,transcripts,id,flush,get toolCalls(){return toolCalls;},
  input(sample:number,count=1){for(let i=0;i<count;i++)client.send(JSON.stringify({type:'audio',audio:pcm(sample)}));},
  output(sample:number,ms=100){peer!.send(JSON.stringify({type:'session.output_audio.delta',delta:pcm(sample,ms)}));},
  delegate(){peer!.send(JSON.stringify({type:'session.delegation.created',delegation:{id:'gpt-advance-delegation',target:'client'}}));},
  transcript(text:string){peer!.send(JSON.stringify({type:'session.input_transcript.delta',delta:text}));},
  async advance(explicit=false){current={...current,revision:current.revision+1,stepIndex:1,outcomes:[{stepId:current.course.steps[0].id,status:'independent'}]};await refreshClassroom(id,explicit?'explicit_navigation':undefined);await flush();},
  async pause(){current={...current,revision:current.revision+1,status:'paused'};await refreshClassroom(id,'explicit_navigation');await flush();},
  answerProbe(probe:Wire){const audio=down.findLast(e=>e.type==='audio');assert(audio);client.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));},
  async close(){client.terminate();await owner.close();for(const s of vendor.clients)s.terminate();await new Promise<void>(r=>vendor.close(()=>r()));await new Promise<void>(r=>upHttp.close(()=>r()));await new Promise<void>(r=>app.close(()=>r()));}
 };
}

test('packaged GPT reading navigation persists the spoken control without a competing delegation',async()=>{
 const f=await fixture(false,undefined,false,true);
 try {
  f.delegate();f.input(1800,3);await f.flush();
  f.transcript('下一页。');f.input(0,12);
  await waitFor(()=>f.transcripts.length===1);
  await f.flush();
  assert.equal(f.transcripts[0].text,'下一页。');
  assert.equal(f.toolCalls,0);
 } finally {await f.close();}
});

test('GPT automatic advance preserves the current audio until fresh output quiet and browser drain',async()=>{
 const f=await fixture();try{
  f.input(0,8);f.output(1500,50);await waitFor(()=>f.down.some(e=>e.type==='audio'));await f.flush();
  const interrupts=f.down.filter(e=>e.type==='interrupt').length,spoken=f.sent.filter(e=>e.type==='session.commentary.append').length;
  await f.advance();assert.equal(f.down.filter(e=>e.type==='interrupt').length,interrupts,'Automatic advance cut the current teacher audio');assert.equal(f.down.some(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1),false);
  const audioCount=f.down.filter(e=>e.type==='audio').length;f.output(2000,50);await waitFor(()=>f.down.filter(e=>e.type==='audio').length>audioCount);
  f.output(0,500);await waitFor(()=>f.down.some(e=>e.type==='playback.probe'),'No browser drain check');assert.equal(f.down.some(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1),false);
  f.answerProbe(f.down.findLast(e=>e.type==='playback.probe')!);await waitFor(()=>f.down.some(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1));await f.flush();
  assert.equal(f.down.filter(e=>e.type==='interrupt').length,interrupts);assert.equal(f.sent.filter(e=>e.type==='session.commentary.append').length,spoken+1,'Advance should produce only one continuation cue');
 }finally{await f.close();}
});

test('GPT short media quiet resumes speech without prematurely completing student evidence',async()=>{
 const f=await fixture();try{
  const spoken=f.sent.filter(e=>e.type==='session.commentary.append').length;
  f.input(1500,2);await f.flush();f.transcript('It can');f.input(0,7);f.output(0,500);
  await waitFor(()=>f.sent.filter(e=>e.type==='session.commentary.append').length===spoken+1,'700ms input quiet did not resume media');assert.equal(f.transcripts.length,0,'Short media quiet completed the learner evidence too early');
  await new Promise(resolve=>setTimeout(resolve,1050));f.input(1500,2);f.transcript(' fly.');f.input(0,12);await waitFor(()=>f.transcripts.length===1);assert.equal(f.transcripts[0].text,'It can fly.');
 }finally{await f.close();}
});

test('GPT lab retains the longer completed-speech gate',async()=>{
 const f=await fixture(true);try{
  const spoken=f.sent.filter(e=>e.type==='session.commentary.append').length;f.input(1500,2);await f.flush();f.input(0,7);f.output(0,500);await f.flush();assert.equal(f.sent.filter(e=>e.type==='session.commentary.append').length,spoken);
 }finally{await f.close();}
});

test('a new learner input cancels deferred GPT advance before binding its transcript',async()=>{
 const f=await fixture();try{
  f.input(0,8);f.output(1500,50);await waitFor(()=>f.down.some(e=>e.type==='audio'));await f.advance();
  assert.equal(f.down.some(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1),false);
  await new Promise(resolve=>setTimeout(resolve,1050));f.input(1500,2);await waitFor(()=>f.down.some(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1));f.transcript('Wait, what is this?');f.input(0,12);await waitFor(()=>f.transcripts.length===1);assert.equal(f.transcripts[0].contextKey,`${f.id}:1:1`);
 }finally{await f.close();}
});

for(const action of ['pause','explicit'] as const)test(`GPT pending advance cannot delay ${action}`,async()=>{
 const f=await fixture();try{f.input(0,8);f.output(1500,50);await waitFor(()=>f.down.some(e=>e.type==='audio'));const n=f.down.filter(e=>e.type==='interrupt').length;if(action==='pause'){await f.advance();await f.pause();await waitFor(()=>f.down.some(e=>e.type==='snapshot'&&e.classroom?.status==='paused'));}else{await f.advance(true);await waitFor(()=>f.down.some(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1));}assert(f.down.filter(e=>e.type==='interrupt').length>n);}finally{await f.close();}
});


test('fresh teacher audio invalidates an older GPT browser-drain receipt',async()=>{
 const f=await fixture();try{
  f.input(0,8);f.output(1500,50);await waitFor(()=>f.down.some(e=>e.type==='audio'));await f.advance();f.output(0,500);
  await waitFor(()=>f.down.some(e=>e.type==='playback.probe'));const oldProbe=f.down.findLast(e=>e.type==='playback.probe')!;
  f.output(2500,50);await f.flush();f.answerProbe(oldProbe);await f.flush();assert.equal(f.down.some(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1),false,'An older playback receipt authorized a still-speaking transition');
  await new Promise(resolve=>setTimeout(resolve,350));f.input(0);f.output(0,500);await waitFor(()=>f.down.some(e=>e.type==='playback.probe'&&e.id!==oldProbe.id));f.answerProbe(f.down.findLast(e=>e.type==='playback.probe')!);await waitFor(()=>f.down.some(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1));
 }finally{await f.close();}
});

test('missing browser drain takes one bounded protected fallback instead of waiting forever',async()=>{
 const f=await fixture(false,120);try{
  f.input(0,8);f.output(1500,50);await waitFor(()=>f.down.some(e=>e.type==='audio'));const spoken=f.sent.filter(e=>e.type==='session.commentary.append').length;await f.advance();
  await waitFor(()=>f.down.some(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1));assert.equal(f.sent.filter(e=>e.type==='session.commentary.append').length,spoken,'Fallback bypassed its output gate');
  f.output(0,500);await waitFor(()=>f.sent.filter(e=>e.type==='session.commentary.append').length===spoken+1);await f.flush();assert.equal(f.down.some(e=>e.type==='error'),false);
 }finally{await f.close();}
});

test('typed input during deferred GPT advance binds the latest authoritative activity',async()=>{
 const f=await fixture();try{
  f.input(0,8);f.output(1500,50);await waitFor(()=>f.down.some(e=>e.type==='audio'));await f.advance();f.client.send(JSON.stringify({type:'text',text:'Can we talk about its tail?'}));await waitFor(()=>f.transcripts.length===1);assert.equal(f.transcripts[0].contextKey,`${f.id}:1:1`);
 }finally{await f.close();}
});

test('muting the microphone does not block GPT playback drain or fabricate completed speech',async()=>{
 const f=await fixture();try{
  f.output(1500,50);await waitFor(()=>f.down.some(e=>e.type==='audio'));await f.advance();f.client.send(JSON.stringify({type:'mute',muted:true}));await f.flush();f.output(0,500);
  await waitFor(()=>f.down.some(e=>e.type==='playback.probe'));f.answerProbe(f.down.findLast(e=>e.type==='playback.probe')!);await waitFor(()=>f.down.some(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1));assert.equal(f.transcripts.length,0);assert.equal(f.down.some(e=>e.type==='error'),false);
 }finally{await f.close();}
});


test('GPT delegated advance winning before refresh also waits for current teacher playback',async()=>{
 const f=await fixture(false,undefined,true);try{
  f.input(1500,2);await f.flush();f.transcript('It can fly.');f.input(0,12);f.output(0,500);await waitFor(()=>f.transcripts.length===1);
  f.output(1500,50);await waitFor(()=>f.down.some(e=>e.type==='audio'));const interrupts=f.down.filter(e=>e.type==='interrupt').length,spoken=f.sent.filter(e=>e.type==='session.commentary.append').length;
  f.delegate();await waitFor(()=>f.sent.some(e=>e.type==='session.thinking.append'&&String(e.content).includes('verifiedApplicationResult')));await f.flush();
  assert.equal(f.down.filter(e=>e.type==='interrupt').length,interrupts,'A tool-first advance cut active audio');assert.equal(f.down.some(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1),false);
  assert.equal(f.sent.filter(e=>e.type==='session.commentary.append').length,spoken,'The tool started another reply before drain');
  f.client.send(JSON.stringify({type:'mute',muted:true}));f.output(0,500);await waitFor(()=>f.down.some(e=>e.type==='playback.probe'));f.answerProbe(f.down.findLast(e=>e.type==='playback.probe')!);await waitFor(()=>f.down.some(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1));
  await f.flush();assert.equal(f.sent.filter(e=>e.type==='session.commentary.append').length,spoken+1);
 }finally{await f.close();}
});
