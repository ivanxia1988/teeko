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
import type {ClassroomPointRequest} from '../lib/classroom-point';

type WireEvent={type?:string;content?:string;event_id?:string;eventId?:string;status?:string;audio?:string;[key:string]:unknown};
const waitFor=async(check:()=>boolean,message:string)=>{const end=Date.now()+3000;while(!check()){if(Date.now()>=end)throw Error(message);await new Promise(resolve=>setTimeout(resolve,5));}};
const pcm=(bytes:number,amplitude=0)=>{
 const data=Buffer.alloc(bytes);
 if(amplitude)for(let offset=0;offset<bytes;offset+=2)data.writeInt16LE(Math.floor(offset/80)%2?amplitude:-amplitude,offset);
 return data.toString('base64');
};
const VOICE_AMPLITUDE=1800;
function broadbandNoise(){
 const data=Buffer.alloc(4800);
 let seed=37;
 for(let offset=0;offset<data.length;offset+=2){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  data.writeInt16LE(Math.floor(((seed>>>16)/32768-1)*3000),offset);
 }
 return data.toString('base64');
}
function hasPcmSample(event:WireEvent,amplitude:number){
 if(event.type!=='audio'||!event.audio)return false;
 const pcm=Buffer.from(event.audio,'base64');
 for(let offset=0;offset<pcm.length;offset+=2)if(Math.abs(pcm.readInt16LE(offset))===amplitude)return true;
 return false;
}
const isPointCue=(event:WireEvent)=>event.type==='session.commentary.append'&&event.content?.includes('pointer gesture')===true;

async function fixture(labTool?: VoiceLease['tool']){
 const id=randomUUID(),vendorHttp=createServer(),vendor=new WebSocketServer({server:vendorHttp}),app=createServer();
 let current=teacherSnapshot({id,course:ROBOT_READING_COURSE,stepIndex:1,preferences:{provider:'openai',language:'bilingual',style:'gentle',voice:'female',soundEffects:false}}),peer:WebSocket|undefined;
 const sent:WireEvent[]=[],received:WireEvent[]=[],points:ClassroomPointRequest[]=[],transcripts:unknown[]=[];
 const withheldAudioReasons:string[]=[];
 let tools=0;
 vendor.on('connection',socket=>{peer=socket;socket.on('message',raw=>{
  const event=JSON.parse(raw.toString()) as WireEvent;sent.push(event);
  if(event.type==='session.start')socket.send(JSON.stringify({type:'session.started',session:{id:'synthetic-gpt-point'}}));
  if(event.type==='session.close')socket.send(JSON.stringify({type:'session.closed'}));
 });});
 vendorHttp.listen(0,'127.0.0.1');await once(vendorHttp,'listening');const va=vendorHttp.address();assert(va&&typeof va!=='string');
 const lease:VoiceLease={id,epoch:1,provider:'openai',snapshot:current,instructions:'Discuss the current robot picture.',initialCue:'Which part gave you that idea?',remainingMs:900000,
  ...(labTool?{labCompletedSpeech:true,labAudioGate:(reason:string)=>{withheldAudioReasons.push(reason);},pageEntryCue:()=> 'Welcome to the new page. Ready to mark its own words?'}:{}),
  heartbeat:async()=>({snapshot:current,instructions:'Discuss the current robot picture.',teachingGuidance:`Teach page ${current.course.steps[current.stepIndex].pageId}.`}),transcript:async event=>{transcripts.push(event);},
  tool:async (...args)=>{tools++;const result=await labTool?.(...args);return{snapshot:current,output:result?.output??{status:'unavailable'}};},
  point:async request=>{points.push(request);current={...current,revision:current.revision+1};return{accepted:true,snapshot:current};},closed:async()=>{}};
 const owner=attachClassroomSockets(app,{origin:'http://localhost:8080',open:async()=>lease,config:()=>({key:'non-production-fixture',model:'gpt-live-1',voice:'gleam',childDataReady:true}),connect:()=>new WebSocket(`ws://127.0.0.1:${va.port}`),heartbeatMs:60000,connectionProbeMs:60000,startupMs:2000,closeMs:20,gptOutputQuietMs:80});
 app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert(address&&typeof address!=='string');
 const client=new WebSocket(`ws://127.0.0.1:${address.port}/ws/classrooms/${id}`,{headers:{Origin:'http://localhost:8080',Cookie:`teeko_session=${'g'.repeat(43)}`}});
 client.on('error',()=>{});client.on('message',raw=>received.push(JSON.parse(raw.toString()) as WireEvent));await once(client,'open');await waitFor(()=>received.some(event=>event.type==='ready')&&sent.some(event=>event.type==='session.commentary.append'),'The synthetic GPT greeting did not start.');
 const send=(event:unknown)=>{assert(peer);peer.send(JSON.stringify(event));};
 const upstreamBarrier=async()=>{assert(peer);const pong=once(peer,'pong');peer.ping('gpt-point-provider-barrier');await pong;};
 const clientBarrier=async()=>{const pong=once(client,'pong');client.ping('gpt-point-client-barrier');await pong;};
 return{sent,received,points,transcripts,withheldAudioReasons,get tools(){return tools;},client,send,upstreamBarrier,clientBarrier,
  point(){const captured=captureClassroomToolState(current);assert(captured.ok);const event={type:'interaction.point',eventId:randomUUID(),context:captured.snapshot.context,objectId:'wings'};client.send(JSON.stringify(event));return event;},
  async navigate(stepIndex:number){current={...current,stepIndex,revision:current.revision+1};await refreshClassroom(id);},
  voicedInput(){for(let index=0;index<2;index++)client.send(JSON.stringify({type:'audio',audio:pcm(4800,VOICE_AMPLITUDE)}));},
  quietInput(){for(let index=0;index<12;index++)client.send(JSON.stringify({type:'audio',audio:pcm(4800)}));},
  quietOutput(){send({type:'session.output_audio.delta',delta:pcm(3840)});},
  async close(){client.terminate();await owner.close();for(const socket of vendor.clients)socket.terminate();await new Promise<void>(resolve=>vendor.close(()=>resolve()));await new Promise<void>(resolve=>vendorHttp.close(()=>resolve()));await new Promise<void>(resolve=>app.close(()=>resolve()));}
 };
}

test('GPT point waits for its own context acknowledgement and measured silence before one original cue and audible output',async()=>{
 const f=await fixture();
 try{
  const start=f.sent.length,point=f.point();await waitFor(()=>f.received.some(event=>event.type==='point.result'&&event.eventId===point.eventId),'The pointer persistence receipt did not arrive.');
  assert.equal(f.received.find(event=>event.type==='point.result')?.status,'accepted');await f.upstreamBarrier();
  assert.equal(f.sent.slice(start).filter(event=>event.type==='session.commentary.append').length,0,'Point commentary was sent while the previous output was still gated.');
  const context=f.sent.slice(start).find(event=>event.type==='session.thinking.append'&&event.content?.includes('learnerPoint'));assert(context?.event_id);
  f.send({type:'session.thinking.appended',client_event_id:context.event_id});await f.upstreamBarrier();assert(!f.sent.slice(start).some(isPointCue),'An acknowledgement alone cannot prove input/output silence.');
  f.quietInput();await f.clientBarrier();assert(!f.sent.slice(start).some(isPointCue),'Input silence alone cannot prove the old output drained.');
  f.quietOutput();await waitFor(()=>f.sent.slice(start).some(isPointCue),'The current pointer cue was lost when the GPT output gate reopened.');
  const cues=f.sent.slice(start).filter(event=>event.type==='session.commentary.append');assert.equal(cues.length,1);assert(isPointCue(cues[0]));assert(cues[0].content?.includes('wings'));assert(!cues[0].content?.includes('Current objective:'));
  const audio=pcm(2400,VOICE_AMPLITUDE);f.send({type:'session.output_audio.delta',delta:audio});await waitFor(()=>f.received.some(event=>event.type==='audio'&&event.audio===audio),'The point response audio remained gated after its cue.');
  f.quietOutput();await f.upstreamBarrier();assert.equal(f.sent.slice(start).filter(isPointCue).length,1);assert.equal(f.points.length,1);assert.deepEqual(f.transcripts,[]);assert.equal(f.tools,0);assert(!f.received.some(event=>event.type==='error'));
 }finally{await f.close();}
});

test('GPT lab records each reason once when voiced provider audio is discarded by the same gate',async()=>{
 const f=await fixture(async()=>({snapshot:teacherSnapshot(),output:{status:'conversation'}}));
 try{
  const start=f.sent.length;
  const sendVoice=()=>f.send({type:'session.output_audio.delta',delta:pcm(2400,VOICE_AMPLITUDE)});
  f.voicedInput();await f.clientBarrier();
  await waitFor(()=>f.sent.slice(start).some(event=>event.type==='session.thinking.append'&&event.content?.includes('learner is speaking now')),'Speech did not open the interruption gate.');
  const speech=f.sent.slice(start).find(event=>event.type==='session.thinking.append'&&event.content?.includes('learner is speaking now'));
  assert(speech?.event_id);
  f.quietOutput();await f.upstreamBarrier();
  assert.deepEqual(f.withheldAudioReasons,[],'A discarded silent frame must not be reported as withheld speech.');
  sendVoice();sendVoice();await f.upstreamBarrier();
  assert.deepEqual(f.withheldAudioReasons,['learner_audio']);
  f.quietInput();await f.clientBarrier();
  sendVoice();sendVoice();await f.upstreamBarrier();
  assert.deepEqual(f.withheldAudioReasons,['learner_audio','context_ack']);
  f.send({type:'session.thinking.appended',client_event_id:speech.event_id});
  sendVoice();sendVoice();await f.upstreamBarrier();
  assert.deepEqual(f.withheldAudioReasons,['learner_audio','context_ack','previous_output']);
  assert(!f.received.some(event=>event.type==='audio'),'Withheld voiced frames are not forwarded.');
  f.quietOutput();
  await waitFor(()=>f.sent.slice(start).some(event=>event.type==='session.commentary.append'),'The app should still speak after the gate settles.');
  sendVoice();
  await waitFor(()=>f.received.some(event=>event.type==='audio'&&event.audio===pcm(2400,VOICE_AMPLITUDE)),'The new reply audio should reach the browser.');
  assert.deepEqual(f.withheldAudioReasons,['learner_audio','context_ack','previous_output']);
 }finally{await f.close();}
});

test('GPT lab finishes an ordinary spoken turn with intermittent broadband background noise',async()=>{
 const f=await fixture(async()=>({snapshot:teacherSnapshot(),output:{status:'conversation'}}));
 let capture:ReturnType<typeof setInterval>|undefined;
 try{
  const start=f.sent.length;
  f.voicedInput();await f.clientBarrier();
  await waitFor(()=>f.sent.slice(start).some(event=>event.type==='session.thinking.append'&&event.content?.includes('learner is speaking now')),'The clean learner speech did not open the interruption gate.');
  const speech=f.sent.slice(start).find(event=>event.type==='session.thinking.append'&&event.content?.includes('learner is speaking now'));
  assert(speech?.event_id);
  f.send({type:'session.thinking.appended',client_event_id:speech.event_id});
  f.send({type:'session.input_transcript.delta',delta:'Why can this robot swim?'});
  f.send({type:'session.output_audio.delta',delta:pcm(2400,VOICE_AMPLITUDE)});
  await f.upstreamBarrier();
  assert.deepEqual(f.withheldAudioReasons,['learner_audio']);
  assert(!f.received.some(event=>hasPcmSample(event,VOICE_AMPLITUDE)),'The old reply was forwarded during genuine learner speech.');
  const noise=broadbandNoise(),quiet=pcm(4800);
  let frame=0;
  capture=setInterval(()=>{
   f.client.send(JSON.stringify({type:'audio',audio:frame++%6<3?noise:quiet}));
   f.quietOutput();
  },100);
  await waitFor(()=>f.sent.slice(start).some(event=>event.type==='session.thinking.append'&&event.content?.includes('verifiedApplicationResult')),'Intermittent noise prevented the ordinary spoken question from completing.');
  assert.equal(f.transcripts.length,1);
  const result=f.sent.slice(start).find(event=>event.type==='session.thinking.append'&&event.content?.includes('verifiedApplicationResult'));
  assert(result?.event_id);
  assert(!f.sent.slice(start).some(event=>event.type==='session.commentary.append'),'The application must still wait for the latest acknowledgement.');
  f.send({type:'session.thinking.appended',client_event_id:result.event_id});
  await waitFor(()=>f.sent.slice(start).some(event=>event.type==='session.commentary.append'&&event.content?.includes('Respond naturally')),'Background noise prevented the current reply request.');
  f.send({type:'session.output_audio.delta',delta:pcm(2400,2400)});
  await waitFor(()=>f.received.some(event=>hasPcmSample(event,2400)),'The current reply did not reach the browser.');
  assert(!f.received.some(event=>hasPcmSample(event,VOICE_AMPLITUDE)),'The old reply must never be replayed.');
  assert(!f.received.some(event=>event.type==='error'));
 }finally{if(capture)clearInterval(capture);await f.close();}
});

test('new GPT learner audio revokes a saved pointer cue before its gate reopens',async()=>{
 const f=await fixture();
 try{
  const start=f.sent.length,point=f.point();await waitFor(()=>f.received.some(event=>event.type==='point.result'&&event.eventId===point.eventId),'The pointer persistence receipt did not arrive.');await f.upstreamBarrier();
  assert(!f.sent.slice(start).some(isPointCue),'The point cue must be held while output is gated.');
  const pointContext=f.sent.slice(start).find(event=>event.type==='session.thinking.append'&&event.content?.includes('learnerPoint'));assert(pointContext?.event_id);
  f.client.send(JSON.stringify({type:'audio',audio:pcm(4800,VOICE_AMPLITUDE)}));await f.clientBarrier();await waitFor(()=>f.sent.slice(start).some(event=>event.type==='session.thinking.append'&&event.content?.includes('learner is speaking now')),'The new learner audio did not invalidate the old output.');
  const speech=f.sent.findLast(event=>event.type==='session.thinking.append'&&event.content?.includes('learner is speaking now'));assert(speech?.event_id);
  f.send({type:'session.thinking.appended',client_event_id:pointContext.event_id});f.send({type:'session.thinking.appended',client_event_id:speech.event_id});f.quietInput();await f.clientBarrier();f.quietOutput();
  await waitFor(()=>f.sent.slice(start).some(event=>event.type==='session.commentary.append'),'The current voice reply did not resume after measured silence.');
  assert.equal(f.sent.slice(start).filter(isPointCue).length,0);assert.equal(f.points.length,1);assert.equal(f.tools,0);assert.equal(f.client.readyState,WebSocket.OPEN);assert(!f.received.some(event=>event.type==='error'));
 }finally{await f.close();}
});

test('a GPT point discards unfinished earlier transcript and settle timer without grading it or losing the point cue',async()=>{
 const f=await fixture();
 try{
  f.voicedInput();await f.clientBarrier();
  f.send({type:'session.input_transcript.delta',delta:'The old unfinished answer.'});f.send({type:'session.delegation.created',delegation:{id:'unfinished-before-point',target:'client'}});await f.upstreamBarrier();
  f.quietInput();await f.clientBarrier();assert.deepEqual(f.transcripts,[]);const start=f.sent.length,point=f.point();
  await waitFor(()=>f.received.some(event=>event.type==='point.result'&&event.eventId===point.eventId),'The new point did not replace the unfinished old speech.');assert.equal(f.received.find(event=>event.type==='point.result')?.status,'accepted');
  await new Promise(resolve=>setTimeout(resolve,425));
  assert.deepEqual(f.transcripts,[],'The pre-point settle timer promoted an old partial to a new final transcript.');assert.equal(f.tools,0,'The old pending delegation graded speech after the point superseded it.');
  const context=f.sent.slice(start).find(event=>event.type==='session.thinking.append'&&event.content?.includes('learnerPoint'));assert(context?.event_id);
  f.send({type:'session.thinking.appended',client_event_id:context.event_id});f.client.send(JSON.stringify({type:'audio',audio:pcm(4800)}));await f.clientBarrier();f.quietOutput();
  await waitFor(()=>f.sent.slice(start).some(isPointCue),'Discarding the old speech also discarded the new pointer cue.');assert.equal(f.sent.slice(start).filter(isPointCue).length,1);
  assert.deepEqual(f.transcripts,[]);assert.equal(f.tools,0);assert.equal(f.client.readyState,WebSocket.OPEN);assert(!f.received.some(event=>event.type==='error'));
 }finally{await f.close();}
});


test('GPT lab marks one completed utterance and waits for the application display result before speaking',async()=>{
 let finish:()=>void=()=>{},stillCurrent:(()=>boolean)|undefined;
 const display=new Promise<void>(resolve=>{finish=resolve;});
 const f=await fixture(async (name,_args,_id,request,isCurrent)=>{
  assert.equal(name,'delegate');assert.equal(request?.source,'application');stillCurrent=isCurrent;
  await display;
  return {snapshot:teacherSnapshot(),output:{status:'confirmed',english:'The word transition is now underlined.'}};
 });
 try{
  const start=f.sent.length;
  f.voicedInput();await f.clientBarrier();
  f.send({type:'session.input_transcript.delta',delta:'Please underline transition.'});await f.upstreamBarrier();
  const speech=f.sent.findLast(e=>e.type==='session.thinking.append'&&e.content?.includes('learner is speaking now'));assert(speech?.event_id);
  f.send({type:'session.thinking.appended',client_event_id:speech.event_id});f.quietOutput();f.quietInput();
  await waitFor(()=>f.tools===1,'The lab should check completed spoken annotation without waiting for native delegation.');
  assert(stillCurrent?.());assert.equal(f.transcripts.length,1);
  assert.equal(f.sent.slice(start).filter(e=>e.type==='session.commentary.append').length,0,'Speech must wait for the display acknowledgment.');
  f.client.send(JSON.stringify({type:'audio',audio:pcm(4800)}));await f.clientBarrier();
  f.send({type:'session.output_audio.delta',delta:pcm(2400,VOICE_AMPLITUDE)});await f.upstreamBarrier();
  assert.deepEqual(f.withheldAudioReasons,['annotation_result']);
  f.send({type:'session.delegation.created',delegation:{id:'late-lab-native',target:'client'}});await f.upstreamBarrier();
  finish();
  await waitFor(()=>f.sent.some(e=>e.type==='session.thinking.append'&&e.content?.includes('now underlined')),'The confirmed result did not reach the provider.');
  const result=f.sent.findLast(e=>e.type==='session.thinking.append'&&e.content?.includes('now underlined'));assert(result?.event_id);
  f.send({type:'session.thinking.appended',client_event_id:result.event_id});
  f.client.send(JSON.stringify({type:'audio',audio:pcm(4800)}));await f.clientBarrier();f.quietOutput();
  await waitFor(()=>f.sent.some(e=>e.type==='session.commentary.append'&&e.content?.includes('now underlined')),'The current display result was not spoken.');
  assert.equal(f.tools,1);
  assert.equal(f.sent.slice(start).filter(e=>e.type==='session.commentary.append').length,1);
 }finally{finish();await f.close();}
});

test('GPT lab page cues wait for new page context and a quiet playback boundary',async()=>{
 const f=await fixture(async()=>({snapshot:teacherSnapshot(),output:{status:'conversation'}}));
 try{
  const start=f.sent.length;await f.navigate(2);await f.upstreamBarrier();
  const updated=f.sent.slice(start).find(e=>e.type==='session.thinking.append'&&e.content?.includes('Teach page robot-read.'));assert(updated?.event_id);
  assert(!f.sent.slice(start).some(e=>e.type==='session.commentary.append'),'Page greeting must wait for acknowledged context.');
  f.send({type:'session.thinking.appended',client_event_id:updated.event_id});f.quietInput();await f.clientBarrier();f.quietOutput();
  await waitFor(()=>f.sent.some(e=>e.type==='session.commentary.append'&&e.content?.includes('Welcome to the new page')),'The new page cue did not speak.');
  assert.equal(f.sent.slice(start).filter(e=>e.type==='session.commentary.append').length,1);
 }finally{await f.close();}
});

test('GPT lab fresh audio revokes the older mark while its display receipt is pending',async()=>{
 let finish:()=>void=()=>{},stillCurrent:(()=>boolean)|undefined;
 const display=new Promise<void>(resolve=>{finish=resolve;});
 const f=await fixture(async (_name,_args,_id,_request,isCurrent)=>{
  stillCurrent=isCurrent;
  await display;
  return {snapshot:teacherSnapshot(),output:{status:'confirmed',english:'The obsolete mark is now displayed.'}};
 });
 try{
  f.voicedInput();await f.clientBarrier();
  f.send({type:'session.input_transcript.delta',delta:'Please circle the tail.'});await f.upstreamBarrier();
  f.quietInput();
  await waitFor(()=>f.tools===1,'The first mark reached the application.');
  assert(stillCurrent?.());
  f.voicedInput();await f.clientBarrier();
  assert.equal(stillCurrent?.(),false);
  finish();await f.upstreamBarrier();
  assert(!f.sent.some(e=>e.content?.includes('The obsolete mark')));
  assert.equal(f.client.readyState,WebSocket.OPEN);
 }finally{finish();await f.close();}
});
