import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
import {attachClassroomSockets,type VoiceLease} from '../lib/server/classroom-sockets';
import {ClassroomVoiceClient} from '../lib/classroom-voice-client';
import type {PcmVoiceAudioOptions} from '../lib/voice-audio';
import type {ClassroomSnapshot} from '../lib/classroom-contract';
import type {ClassroomJournalEntry} from '../lib/classroom-journal';

const id='90000000-0000-4000-8000-000000000001';
const snapshot={id,revision:1,stepIndex:0,connectionEpoch:1,status:'active',profile:{name:'Fixture',ageRange:'10–11',level:'starter'},preferences:{provider:'qwen',voice:'female',language:'english',style:'gentle',soundEffects:false},teacherObjectIds:[],feedback:null,outcomes:[],remainingSeconds:60,elapsedSeconds:0,course:{id:'picnic',version:'1',title:'Picnic',pages:[{id:'p1',objects:[{id:'apple',label:'apple'}]}],steps:[{id:'s1',kind:'speak',pageId:'p1',english:'Say apple.'}]}} as unknown as ClassroomSnapshot;
const wait=async(check:()=>boolean)=>{const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw Error('Expected fixture latency evidence was not recorded.');await new Promise(resolve=>setTimeout(resolve,5));}};

test('actual voice client and socket exchange one approved same-browser latency receipt',async()=>{
 const vendorHttp=createServer(),vendor=new WebSocketServer({server:vendorHttp}),http=createServer();
 let upstream:WebSocket|undefined,options:PcmVoiceAudioOptions|undefined,now=0,spoken=false,replied=false,tagged=0,inputSamples=0;
 const journal:ClassroomJournalEntry[]=[],errors:string[]=[];
 vendor.on('connection',socket=>{upstream=socket;socket.on('message',raw=>{
  const e=JSON.parse(raw.toString());
  if(e.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));
  if(e.type==='response.create'){socket.send(JSON.stringify({type:'response.created',response:{id:'greeting'}}));socket.send(JSON.stringify({type:'response.done',response:{id:'greeting',status:'completed'}}));}
  if(e.type==='input_audio_buffer.append'){
   const pcm=Buffer.from(e.audio,'base64'),audioStartMs=inputSamples/16000*1000;inputSamples+=pcm.length/2;
   const voice=pcm.some(value=>value!==0);
   if(voice&&!spoken){spoken=true;socket.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'fixture-input',audio_start_ms:audioStartMs}));}
   if(!voice&&spoken&&!replied){replied=true;socket.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'fixture-input',audio_end_ms:audioStartMs}));socket.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'fixture-input',transcript:'An apple.'}));socket.send(JSON.stringify({type:'response.created',response:{id:'fixture-reply'}}));socket.send(JSON.stringify({type:'response.audio.delta',response_id:'fixture-reply',delta:Buffer.alloc(2400,0x11).toString('base64')}));socket.send(JSON.stringify({type:'response.done',response:{id:'fixture-reply',status:'completed'}}));}
  }
 });socket.send(JSON.stringify({type:'session.created',session:{id:'fixture-session'}}));});
 vendorHttp.listen(0,'127.0.0.1');await once(vendorHttp,'listening');const vendorAddress=vendorHttp.address();assert(vendorAddress&&typeof vendorAddress!=='string');
 const lease:VoiceLease={id,epoch:1,provider:'qwen',instructions:'Synthetic fixture.',initialCue:'Hello.',remainingMs:60000,snapshot,heartbeat:async()=>({snapshot,instructions:'Synthetic fixture.'}),transcript:async()=>{},tool:async()=>({snapshot,output:{status:'conversation'}}),closed:async()=>{},journal:async entry=>{journal.push(entry);}};
 const owner=attachClassroomSockets(http,{origin:'http://localhost:8080',open:async()=>lease,config:()=>({key:'non-production-fixture',model:'qwen3.8-omni-flash-realtime',voice:'Tina',workspaceId:'fixture',region:'cn-beijing'}),connect:()=>new WebSocket(`ws://127.0.0.1:${vendorAddress.port}`),heartbeatMs:60000,closeMs:30});
 http.listen(0,'127.0.0.1');await once(http,'listening');const address=http.address();assert(address&&typeof address!=='string');
 const track={enabled:true,stop(){}};const stream={getTracks:()=>[track]} as unknown as MediaStream;
 const client=new ClassroomVoiceClient({classroomId:id,provider:'qwen',onState(){},onSnapshot(){},onLevel(){},onError:error=>errors.push(error)}, {origin:()=> 'http://localhost:8080',media:async()=>stream,socket:()=>new WebSocket(`ws://127.0.0.1:${address.port}/ws/classrooms/${id}`,{headers:{Origin:'http://localhost:8080',Cookie:`teeko_session=${'t'.repeat(43)}`}}) as unknown as globalThis.WebSocket,now:()=>now,startupMs:2000,closeMs:100,audio:value=>{options=value;return{startCapture:async()=>{},playChunk:(_audio,_rate,_diagnostic,measurement)=>{if(measurement){tagged++;now=350;value.onAudiblePlayback?.({measurementId:measurement,atMs:350});}},cancelPlayback(){},mute(){},resume:async()=>{},close(){}};}});
 try{
  await client.start();await wait(()=>journal.some(e=>e.name==='diagnostic_phase'&&e.details?.phase==='response_completed'));
  const capture=(atMs:number,voiced:boolean)=>{now=atMs;options!.onFrame(Buffer.alloc(3200,voiced?0x11:0).toString('base64'),{atMs,frameMs:100,level:voiced?.1:0});};
  capture(100,true);await wait(()=>spoken);capture(200,true);await new Promise(resolve=>setTimeout(resolve,5));capture(300,false);
  await wait(()=>journal.some(e=>e.name==='latency_stage'&&e.details?.latencyStage==='playback_started')).catch(()=>{throw Error(JSON.stringify({tagged,errors,latency:journal.filter(e=>e.name==='latency_stage').map(e=>e.details)}));});
  const measured=journal.find(e=>e.name==='latency_stage'&&e.details?.latencyStage==='playback_started')!;
  assert.equal(measured.details?.waitMs,150);assert.equal(measured.details?.playbackMs,50);assert.equal(measured.details?.clock,'client');assert.equal(tagged,1);assert.deepEqual(errors,[]);
 }finally{await client.stop();await owner.close();upstream?.terminate();for(const peer of vendor.clients)peer.terminate();await new Promise<void>(resolve=>vendor.close(()=>resolve()));await new Promise<void>(resolve=>vendorHttp.close(()=>resolve()));await new Promise<void>(resolve=>http.close(()=>resolve()));}
});
