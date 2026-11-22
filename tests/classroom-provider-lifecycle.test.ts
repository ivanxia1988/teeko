import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws';
import {attachClassroomSockets,type VoiceLease} from '../lib/server/classroom-sockets';
import {refreshClassroom} from '../lib/server/classroom-events';
import {teacherSnapshot} from './teacher-runtime-fixture';

type WireEvent={type?:string;session?:{instructions?:string};classroom?:{revision?:number};code?:string;[key:string]:unknown};
const waitFor=async(check:()=>boolean)=>{const until=Date.now()+2500;while(!check()){if(Date.now()>=until)throw new Error('Expected provider lifecycle event did not arrive.');await new Promise(resolve=>setTimeout(resolve,5));}};
async function fixture(responseProgressMs=2000){
 const id=randomUUID(),vendorHttp=createServer(),vendor=new WebSocketServer({server:vendorHttp}),app=createServer();
 const sent:WireEvent[]=[],downstream:WireEvent[]=[];let peer:WebSocket|undefined,released=0,holdUpdates=false;
 let current=teacherSnapshot({id});
 vendor.on('connection',socket=>{peer=socket;socket.on('message',raw=>{
  const event=JSON.parse(raw.toString()) as WireEvent;sent.push(event);
  if(event.type==='session.update'&&!holdUpdates)socket.send(JSON.stringify({type:'session.updated'}));
 });socket.send(JSON.stringify({type:'session.created',session:{id:'synthetic-lifecycle-session'}}));});
 vendorHttp.listen(0,'127.0.0.1');await once(vendorHttp,'listening');const vendorAddress=vendorHttp.address();assert(vendorAddress&&typeof vendorAddress!=='string');
 const lease:VoiceLease={id,epoch:1,provider:'qwen',snapshot:current,instructions:'Current verified task: find an apple.',initialCue:'Can you find an apple?',remainingMs:900000,
  heartbeat:async()=>({snapshot:current,instructions:current.feedback?.message??'Current verified task: find an apple.'}),transcript:async()=>{},tool:async()=>({snapshot:current,output:{status:'unavailable'}}),closed:async()=>{released++;}};
 const owner=attachClassroomSockets(app,{origin:'http://localhost:8080',open:async()=>lease,config:()=>({key:'non-production-fixture',model:'qwen3.8-omni-flash-realtime',voice:'Tina',workspaceId:'synthetic',region:'cn-beijing'}),connect:()=>new WebSocket(`ws://127.0.0.1:${vendorAddress.port}`),heartbeatMs:60000,startupMs:2000,responseAckMs:2000,responseProgressMs,closeMs:30});
 app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert(address&&typeof address!=='string');
 const client=new WebSocket(`ws://127.0.0.1:${address.port}/ws/classrooms/${id}`,{headers:{Origin:'http://localhost:8080',Cookie:`teeko_session=${'t'.repeat(43)}`}});
 client.on('error',()=>{});client.on('message',raw=>downstream.push(JSON.parse(raw.toString()) as WireEvent));
 const barrier=async()=>{assert(peer);const pong=once(peer,'pong');peer.ping(randomUUID());await pong;};
 return {sent,downstream,get released(){return released;},client,
  async start(){await once(client,'open');await waitFor(()=>sent.some(event=>event.type==='response.create'));await barrier();},
  async provider(event:Record<string,unknown>){assert(peer);peer.send(JSON.stringify(event));await barrier();},
  emit(event:Record<string,unknown>){assert(peer);peer.send(JSON.stringify(event));},
  holdConfiguration(){holdUpdates=true;},
  async refreshNoop(){await refreshClassroom(id,'explicit_navigation');await barrier();},
  async feedback(){current={...current,revision:current.revision+1,feedback:{id:randomUUID(),kind:'retry',message:'Please use the current picture.'}};await refreshClassroom(id);await waitFor(()=>downstream.some(event=>event.type==='snapshot'&&event.classroom?.revision===current.revision));},
  async close(){client.terminate();await owner.close();for(const socket of vendor.clients)socket.terminate();await new Promise<void>(resolve=>vendor.close(()=>resolve()));await new Promise<void>(resolve=>vendorHttp.close(()=>resolve()));await new Promise<void>(resolve=>app.close(()=>resolve()));},
 };
}

test('old response.done cannot release a newer native reply and allow overlapping response.create',async()=>{
 const f=await fixture();
 try{
  await f.start();await f.provider({type:'response.created',response:{id:'response-A'}});
  await f.provider({type:'input_audio_buffer.speech_started',item_id:'new-turn'});
  await waitFor(()=>f.sent.some(event=>event.type==='response.cancel'));
  await f.provider({type:'input_audio_buffer.speech_stopped',item_id:'new-turn'});
  await f.provider({type:'response.created',response:{id:'response-B'}});
  await f.provider({type:'response.done',response:{id:'response-A',status:'cancelled'}});
  await f.feedback();await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(f.sent.filter(event=>event.type==='response.create').length,1,'old A completion must not release active B');
  await f.provider({type:'response.done',response:{id:'response-B',status:'completed'}});
  await waitFor(()=>f.sent.filter(event=>event.type==='response.create').length===2);
  assert.equal(f.released,0);assert(!f.downstream.some(event=>event.type==='error'));
 }finally{await f.close();}
});

test('an idempotent navigation refresh does not cancel an unchanged current reply or its next audio',async()=>{
 const f=await fixture();
 try{
  await f.start();await f.provider({type:'response.created',response:{id:'unchanged-reply'}});
  const interrupts=f.downstream.filter(event=>event.type==='interrupt').length;
  await f.refreshNoop();
  assert.equal(f.sent.filter(event=>event.type==='response.cancel').length,0);
  assert.equal(f.downstream.filter(event=>event.type==='interrupt').length,interrupts);
  await f.provider({type:'response.audio.delta',response_id:'unchanged-reply',delta:Buffer.alloc(4800,0x11).toString('base64')});
  await f.provider({type:'response.done',response:{id:'unchanged-reply',status:'completed'}});
  await waitFor(()=>f.downstream.some(event=>event.type==='audio'));
  assert.equal(f.released,0);assert(!f.downstream.some(event=>event.type==='error'));
 }finally{await f.close();}
});

const controlRejection=(error:Record<string,unknown>={})=>({type:'error',error:{type:'invalid_request_error',code:'invalid_value',param:'response.create',...error}});
async function settleGreeting(f:Awaited<ReturnType<typeof fixture>>){
 await f.start();await f.provider({type:'response.created',response:{id:'completed-greeting'}});
 await f.provider({type:'response.done',response:{id:'completed-greeting',status:'completed'}});
}

test('a narrowly classified late control rejection retains confirmed idle media and accepts the next input',async()=>{
 const f=await fixture();
 try{
  await settleGreeting(f);await f.provider(controlRejection());
  assert.equal(f.released,0);assert(!f.downstream.some(event=>event.type==='error'));
  f.client.send(JSON.stringify({type:'text',text:'What is an apple?'}));
  await waitFor(()=>f.sent.filter(event=>event.type==='response.create').length===2);
  assert.equal(f.released,0);
 }finally{await f.close();}
});

for(const mode of ['pending_response','pending_configuration','new_audio'] as const)test(`control rejection remains fatal after ${mode}`,async()=>{
 const f=await fixture();
 try{
  if(mode==='pending_response')await f.start();
  else{
   await settleGreeting(f);
   if(mode==='pending_configuration'){f.holdConfiguration();await f.feedback();}
   else{f.client.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>f.sent.some(event=>event.type==='input_audio_buffer.append'));}
  }
  f.emit(controlRejection());await waitFor(()=>f.released===1&&f.downstream.some(event=>event.type==='error'));
  assert.equal(f.downstream.find(event=>event.type==='error')?.code,'provider_error');
 }finally{await f.close();}
});

for(const error of [{code:'unknown-error'},{code:'invalid_api_key'},{code:'insufficient_quota'},{type:'server_error'},{param:'session.modalities'},{param:'input_audio_buffer.append'},{param:null},{event_id:'unknown-request'}])test(`confirmed idle never swallows ${JSON.stringify(error)}`,async()=>{
 const f=await fixture();
 try{
  await settleGreeting(f);f.emit(controlRejection(error));
  await waitFor(()=>f.released===1&&f.downstream.some(event=>event.type==='error'));
  assert.equal(f.downstream.find(event=>event.type==='error')?.code,'provider_error');
 }finally{await f.close();}
});

test('confirmed idle recovery closes on the third control rejection instead of looping',async()=>{
 const f=await fixture();
 try{
  await settleGreeting(f);await f.provider(controlRejection());await f.provider(controlRejection());
  assert.equal(f.released,0);
  f.emit(controlRejection());await waitFor(()=>f.released===1&&f.downstream.some(event=>event.type==='error'));
  assert.equal(f.downstream.find(event=>event.type==='error')?.code,'provider_error');
 }finally{await f.close();}
});

test('old response.done cannot clear the watchdog of a newer response with no output',async()=>{
 const f=await fixture(100);
 try{
  await f.start();await f.provider({type:'response.created',response:{id:'response-A'}});
  await f.provider({type:'response.done',response:{id:'response-A',status:'completed'}});
  await f.provider({type:'response.created',response:{id:'response-B'}});
  await f.provider({type:'response.done',response:{id:'response-A',status:'completed'}});
  await waitFor(()=>f.released===1&&f.downstream.some(event=>event.type==='error'));
  assert.equal(f.downstream.find(event=>event.type==='error')?.code,'response_timeout');
 }finally{await f.close();}
});
