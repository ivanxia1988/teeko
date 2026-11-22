import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import test,{type TestContext} from 'node:test';
import WebSocket,{WebSocketServer} from 'ws';
import type {LabEventBatch,LabSession} from '../lib/interaction-lab';
import {labVisualContext} from '../lib/interaction-lab-visual';
import {startInteractionLabServer} from '../scripts/interaction-lab/server';

const config={key:'synthetic-lab-visual-key',model:'qwen3.8-omni-flash-realtime',voice:'Tina',region:'cn-beijing',workspaceId:'synthetic-fixture'};
const jpeg=(await readFile(new URL('./fixtures/vision-candidates/dark.jpg',import.meta.url))).toString('base64');
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async(description:string,check:()=>boolean|Promise<boolean>)=>{
 const until=performance.now()+2300;
 while(!await check()){if(performance.now()>=until)assert.fail(description);await delay(10);}
};

async function fixture(t:TestContext){
 const fake=createServer(),vendor=new WebSocketServer({server:fake});
 fake.listen(0,'127.0.0.1');await once(fake,'listening');
 const address=fake.address();assert(address&&typeof address==='object');
 const lab=await startInteractionLabServer({port:0,configuration:async()=>config,connect:(_url,headers)=>new WebSocket('ws://127.0.0.1:'+address.port,{headers})});
 let remote:WebSocket|undefined,closeClient=()=>{},responseCount=0;
 const sent:Record<string,unknown>[]=[],received:Record<string,unknown>[]=[];
 t.after(async()=>{closeClient();await lab.close();for(const socket of vendor.clients)socket.terminate();await new Promise<void>(resolve=>vendor.close(()=>resolve()));fake.closeAllConnections();await new Promise<void>(resolve=>fake.close(()=>resolve()));});
 const fromVendor=(message:unknown)=>{assert(remote&&remote.readyState===WebSocket.OPEN);remote.send(JSON.stringify(message));};
 vendor.on('connection',socket=>{
  remote=socket;fromVendor({type:'session.created',session:{id:'lab-visual-fixture'}});
  socket.on('message',raw=>{
   const event=JSON.parse(raw.toString()) as Record<string,unknown>;sent.push(event);
   if(event.type==='session.update'){fromVendor({type:'session.updated'});return;}
   if(event.type==='response.create'){
    const id='fixture-reply-'+(++responseCount);
    fromVendor({type:'response.created',response:{id}});
    fromVendor({type:'response.done',response:{id,status:'completed'}});
   }
  });
 });
 const response=await fetch(lab.origin+'/lab/session',{method:'POST',headers:{Origin:lab.origin}});
 assert.equal(response.status,201);const cookie=response.headers.get('set-cookie')?.split(';')[0];assert(cookie);
 const session=await response.json() as LabSession;
 const contextKey=labVisualContext(session.snapshot),client=new WebSocket(lab.origin.replace(/^http/,'ws')+'/ws/classrooms/'+session.id,{headers:{Origin:lab.origin,Cookie:cookie}});
 closeClient=()=>client.terminate();
 client.on('message',raw=>received.push(JSON.parse(raw.toString()) as Record<string,unknown>));
 await once(client,'open');
 const send=(message:unknown)=>client.send(JSON.stringify(message));
 const trace=async()=>{
  const response=await fetch(lab.origin+'/lab/events/'+session.id+'?after=0',{headers:{Cookie:cookie}});
  assert.equal(response.status,200);return (await response.json() as LabEventBatch).events;
 };
 await wait('greeting must finish',async()=>received.some(message=>message.type==='ready')&&(await trace()).some(event=>event.layer==='provider'&&event.data?.event==='response.done'));
 send({type:'audio',audio:Buffer.alloc(3200,0x19).toString('base64')});
 await wait('one actual PCM frame must be forwarded before an image',()=>sent.some(event=>event.type==='input_audio_buffer.append'));
 return {
  sent,received,send,trace,contextKey,
  stage(kind:'region'|'board',point?:{x:number;y:number},textId?:string){
   const id=randomUUID();send({type:'lab.visual.stage',id,contextKey,kind,...(point?{point}:{}),...(textId?{textId}:{})});return id;
  },
  ready(id:string,image=jpeg){send({type:'lab.visual.ready',id,contextKey,image});},
  speech(started:boolean,id:string){fromVendor({type:'input_audio_buffer.speech_'+(started?'started':'stopped'),item_id:id});},
  imageSends:()=>sent.filter(event=>event.type==='input_image_buffer.append'),
  responseCount:()=>sent.filter(event=>event.type==='response.create').length,
 };
}

test('only the latest explicitly prepared visual follows native speech without being consumed by text',async t=>{
 const f=await fixture(t),previous=f.stage('board');
 f.ready(previous);
 await wait('board frame before replacement should be ready',async()=>(await f.trace()).some(event=>event.data?.visualId===previous&&event.data?.state==='ready'));
 const point={x:.248,y:.678},id=f.stage('region',point,'passage-machine');
 f.ready(previous);f.ready(id);
 await wait('selected region should be ready',async()=>(await f.trace()).some(event=>event.data?.visualId===id&&event.data?.state==='ready'));
 f.send({type:'text',text:'This is an unrelated typed question.'});
 await wait('the typed turn should finish without an image',()=>f.responseCount()===2);
 assert.equal(f.imageSends().length,0);
 f.speech(true,'visual-question');
 await wait('the matching native speech should forward the current JPEG',()=>f.imageSends().length===1);
 assert.equal(f.imageSends()[0].image,jpeg);
 const sends=(await f.trace()).filter(event=>event.kind==='image'&&event.layer==='provider');
 assert.equal(sends.length,1);
 const [outgoing]=sends;
 assert.equal(outgoing.label,'已向通义转发本轮教材图');
 assert.equal(outgoing?.layer,'provider');assert.equal(outgoing?.data?.visualId,id);assert.equal(outgoing?.data?.itemId,'visual-question');
 assert.equal(outgoing?.data?.kind,'region');assert.equal(outgoing?.data?.x,point.x);assert.equal(outgoing?.data?.y,point.y);
 assert.equal(outgoing?.data?.textId,'passage-machine');
 assert.equal(outgoing?.data?.bytes,Buffer.from(jpeg,'base64').length);
 assert(!(await f.trace()).some(event=>event.label==='已关联到本轮语音'));
 f.speech(false,'old-fragment');
 await wait('unrelated native stop should be visible',async()=>(await f.trace()).some(event=>event.data?.event==='input_audio_buffer.speech_stopped'));
 assert(!(await f.trace()).some(event=>event.label==='已关联到本轮语音'));
 f.speech(false,'visual-question');
 await wait('receipt follows the exact matching native end',async()=>(await f.trace()).some(event=>event.label==='已关联到本轮语音'));
 const trace=await f.trace(),association=trace.filter(event=>event.label==='已关联到本轮语音');
 assert.equal(association.length,1);assert.equal(association[0].data?.itemId,'visual-question');assert.equal(association[0].data?.visualId,id);assert.equal(association[0].data?.understandingConfirmed,false);
 assert.equal(association[0].data?.textId,'passage-machine');
 assert(!JSON.stringify(trace).includes(jpeg));assert.equal(f.responseCount(),2);
 assert(!f.received.some(event=>event.type==='error'));
});

test('late bytes cannot leak onto a newer speech item, but bytes ready before its own end can be attached',async t=>{
 const f=await fixture(t),late=f.stage('board');
 await wait('the first preparation should be staged',async()=>(await f.trace()).some(event=>event.data?.visualId===late&&event.data?.state==='staged'));
 f.speech(true,'too-early');f.speech(false,'too-early');
 await wait('a not-ready JPEG should be discarded at native end',async()=>(await f.trace()).some(event=>event.data?.visualId===late&&event.data?.state==='speech_ended_before_send'));
 f.ready(late);
 const next=f.stage('board');
 await wait('the new preparation should be staged',async()=>(await f.trace()).some(event=>event.data?.visualId===next&&event.data?.state==='staged'));
 f.speech(true,'current-speech');
 await wait('both native begins should be observed',async()=>(await f.trace()).filter(event=>event.data?.event==='input_audio_buffer.speech_started').length===2);
 assert.equal(f.imageSends().length,0);
 f.ready(next);
 await wait('ready bytes should be sent into the open item',()=>f.imageSends().length===1);
 f.speech(false,'current-speech');
 await wait('the open item should own the association',async()=>(await f.trace()).some(event=>event.label==='已关联到本轮语音'&&event.data?.visualId===next&&event.data?.itemId==='current-speech'));
 assert.equal(f.responseCount(),1);
});

test('invalid JPEG, explicit discard, and microphone mute drop prepared visuals without dropping the voice connection',async t=>{
 const f=await fixture(t),bad=f.stage('board');f.ready(bad,'AA==');
 await wait('the payload must independently pass JPEG header validation',async()=>(await f.trace()).some(event=>event.data?.visualId===bad&&event.data?.state==='invalid_jpeg'));
 const cancelled=f.stage('region',{x:0,y:1});f.ready(cancelled);
 await wait('the frame should be prepared',async()=>(await f.trace()).some(event=>event.data?.visualId===cancelled&&event.data?.state==='ready'));
 f.send({type:'lab.visual.clear',id:cancelled,contextKey:f.contextKey});
 await wait('the explicit matching discard should take effect',async()=>(await f.trace()).some(event=>event.data?.visualId===cancelled&&event.data?.state==='cleared'));
 const muted=f.stage('board');f.ready(muted);
 await wait('the next frame should be prepared',async()=>(await f.trace()).some(event=>event.data?.visualId===muted&&event.data?.state==='ready'));
 f.send({type:'mute',muted:true});
 await wait('muting should remove the pending attachment',async()=>(await f.trace()).some(event=>event.data?.visualId===muted&&event.data?.state==='muted'));
 f.send({type:'mute',muted:false});
 f.speech(true,'empty-attachment');f.speech(false,'empty-attachment');
 await wait('the unmuted voice event should still work',async()=>(await f.trace()).some(event=>event.data?.event==='input_audio_buffer.speech_stopped'));
 assert.equal(f.imageSends().length,0);assert(!f.received.some(event=>event.type==='error'));
});
