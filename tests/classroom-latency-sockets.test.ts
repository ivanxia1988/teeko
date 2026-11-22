import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws';
import {attachClassroomSockets,type VoiceLease} from '../lib/server/classroom-sockets';
import type {ClassroomJournalEntry} from '../lib/classroom-journal';
import {teacherSnapshot} from './teacher-runtime-fixture';

type WireEvent=Record<string,unknown>;
const waitFor=async(check:()=>boolean,message:string)=>{const until=Date.now()+3000;while(!check()){if(Date.now()>=until)throw Error(message);await new Promise(resolve=>setTimeout(resolve,5));}};
const pcm=(bytes:number,audible:boolean)=>{const buffer=Buffer.alloc(bytes);if(audible)for(let offset=0;offset<bytes;offset+=2)buffer.writeInt16LE(offset%4?1800:-1800,offset);return buffer.toString('base64');};
const firstInput='10000000-0000-4000-8000-000000000091',realInput='10000000-0000-4000-8000-000000000092';

async function fixture(){
 const id=randomUUID(),snapshot=teacherSnapshot({id}),vendorHttp=createServer(),vendor=new WebSocketServer({server:vendorHttp}),app=createServer();
 const sent:WireEvent[]=[],downstream:WireEvent[]=[],journal:ClassroomJournalEntry[]=[];
 let peer:WebSocket|undefined,released=0;
 vendor.on('connection',socket=>{peer=socket;socket.on('message',raw=>{const event=JSON.parse(raw.toString()) as WireEvent;sent.push(event);if(event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));});socket.send(JSON.stringify({type:'session.created',session:{id:'synthetic-latency'}}));});
 vendorHttp.listen(0,'127.0.0.1');await once(vendorHttp,'listening');const vendorAddress=vendorHttp.address();assert(vendorAddress&&typeof vendorAddress!=='string');
 const lease:VoiceLease={id,epoch:1,provider:'qwen',snapshot,instructions:'Current verified task: discuss a robot.',initialCue:'What could a robot do?',remainingMs:900000,
  heartbeat:async()=>({snapshot,instructions:'Current verified task: discuss a robot.'}),transcript:async()=>{},tool:async()=>assert.fail('This latency fixture does not request tools.'),closed:async()=>{released++;},journal:async entry=>{journal.push(entry);}};
 const owner=attachClassroomSockets(app,{origin:'http://localhost:8080',open:async()=>lease,config:()=>({key:'non-production-fixture',model:'qwen3.8-omni-flash-realtime',voice:'Tina',workspaceId:'synthetic',region:'cn-beijing'}),connect:()=>new WebSocket(`ws://127.0.0.1:${vendorAddress.port}`),heartbeatMs:60000,startupMs:2000,closeMs:30,connectionProbeMs:60000,silencePromptMs:60000});
 app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert(address&&typeof address!=='string');
 const client=new WebSocket(`ws://127.0.0.1:${address.port}/ws/classrooms/${id}`,{headers:{Origin:'http://localhost:8080',Cookie:`teeko_session=${'l'.repeat(43)}`}});
 client.on('error',()=>{});client.on('message',raw=>downstream.push(JSON.parse(raw.toString()) as WireEvent));
 const send=(event:unknown)=>{assert(peer);peer.send(JSON.stringify(event));};
 const barrier=async(nonce:string)=>{const pong=once(client,'pong');client.ping(nonce);const [observed]=await pong;assert.equal(observed.toString(),nonce);};
 return{client,sent,downstream,journal,get released(){return released;},send,barrier,
  async start(){await once(client,'open');await waitFor(()=>downstream.some(event=>event.type==='ready')&&sent.some(event=>event.type==='response.create'),'Synthetic Qwen configuration did not finish.');send({type:'response.created',response:{id:'greeting'}});send({type:'response.audio.delta',response_id:'greeting',delta:pcm(2400,true)});await waitFor(()=>downstream.some(event=>event.type==='audio'),'Synthetic greeting audio did not reach the browser.');},
  async capture(inputId:string,sequence:number){client.send(JSON.stringify({type:'audio',audio:pcm(3200,true),latencyInputId:inputId,audioSequence:sequence}));client.send(JSON.stringify({type:'audio',audio:pcm(3200,false),latencyInputId:inputId,audioSequence:sequence+1}));client.send(JSON.stringify({type:'diagnostic.input',inputId,firstSequence:sequence,lastVoiceSequence:sequence,phase:'stopped',silenceMs:100}));await barrier(`capture-${sequence}`);},
  async close(){client.terminate();await owner.close();for(const socket of vendor.clients)socket.terminate();await new Promise<void>(resolve=>vendor.close(()=>resolve()));await new Promise<void>(resolve=>vendorHttp.close(()=>resolve()));await new Promise<void>(resolve=>app.close(()=>resolve()));}
 };
}

for(const withOffset of [true,false])test(`native socket latency recovers after an unbound greeting candidate only with an exact provider offset: ${withOffset}`,async()=>{
 const f=await fixture();
 try{
  await f.start();
  // Uninstrumented leading silence still occupies 100 ms in Qwen's input clock.
  f.client.send(JSON.stringify({type:'audio',audio:pcm(3200,false)}));await f.capture(firstInput,0);
  const greetingChunks=f.downstream.filter(event=>event.type==='audio').length;
  f.send({type:'response.audio.delta',response_id:'greeting',delta:pcm(2400,true)});
  await waitFor(()=>f.downstream.filter(event=>event.type==='audio').length>greetingChunks,'The greeting tail did not play over the unconfirmed capture.');
  assert(!f.downstream.some(event=>event.type==='diagnostic.latency'&&event.state==='bound'));
  f.send({type:'response.done',response:{id:'greeting',status:'completed'}});
  await f.capture(realInput,2);await waitFor(()=>f.sent.filter(event=>event.type==='input_audio_buffer.append').length===5,'The five PCM frames did not reach the local provider.');
  f.send({type:'input_audio_buffer.speech_started',item_id:'real-input',...(withOffset?{audio_start_ms:320}:{})});
  f.send({type:'input_audio_buffer.speech_stopped',item_id:'real-input',audio_end_ms:400});
  f.send({type:'conversation.item.input_audio_transcription.completed',item_id:'real-input',transcript:'Tell me about robots.'});
  f.send({type:'response.created',response:{id:'real-response'}});
  f.send({type:'response.audio.delta',response_id:'real-response',delta:pcm(2400,true)});
  f.send({type:'response.done',response:{id:'real-response',status:'completed'}});
  await waitFor(()=>f.downstream.filter(event=>event.type==='audio').length>greetingChunks+1,'The actual learner reply did not reach the browser.');
  const bindings=f.downstream.filter(event=>event.type==='diagnostic.latency'&&event.state==='bound');
  assert.equal(bindings.length,withOffset?1:0);assert.equal(f.released,0);assert(!f.downstream.some(event=>event.type==='error'));
  if(withOffset){
   const bound=bindings[0];assert.equal(bound.inputId,realInput);assert.equal(bound.lastVoiceSequence,2);assert.equal(bound.basis,'provider_turn');
   assert(f.downstream.some(event=>event.type==='audio'&&event.latencyMeasurementId===bound.measurementId));
   assert(f.journal.some(event=>event.details?.latencyStage==='input_final'&&event.details.measurementId===bound.measurementId));
   f.client.send(JSON.stringify({type:'diagnostic.latency',measurementId:bound.measurementId,phase:'playback_started',waitMs:875,playbackMs:35}));
   await waitFor(()=>f.journal.some(event=>event.details?.latencyStage==='playback_started'),'The browser audible receipt did not reach the journal.');
   const observed=f.journal.find(event=>event.details?.latencyStage==='playback_started')!;
   assert.equal(observed.details?.measurementId,bound.measurementId);assert.equal(observed.details?.latencyInputId,realInput);assert.equal(observed.details?.clock,'client');assert.equal(observed.details?.waitMs,875);assert.equal(observed.details?.playbackMs,35);
  }else{
   assert(f.downstream.filter(event=>event.type==='audio').every(event=>event.latencyMeasurementId===null));
   assert(!f.journal.some(event=>event.details?.latencyStage==='playback_started'));
  }
 }finally{await f.close();}
});
