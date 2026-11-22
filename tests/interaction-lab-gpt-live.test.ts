import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws';
import type {LabEvent,LabEventBatch,LabSession} from '../lib/interaction-lab';
import type {ClassroomSnapshot} from '../lib/classroom-contract';
import {InteractionLabMarkRequest} from '../lib/interaction-lab-mark';
import {ROBOT_READING_COURSE} from '../lib/server/robot-reading-course';
import {startInteractionLabServer} from '../scripts/interaction-lab/server';

type Wire={type:string;event_id?:string;content?:string;classroom?:ClassroomSnapshot};
const waitFor=async<T>(read:()=>T|undefined|false|Promise<T|undefined|false>,label:string):Promise<T>=>{
 const deadline=Date.now()+5000;
 for(;;){const value=await read();if(value)return value;if(Date.now()>=deadline)throw Error(label);await new Promise(resolve=>setTimeout(resolve,15));}
};
const pcm=(voiced:boolean)=>{
 const data=Buffer.alloc(4800);
 if(voiced)for(let offset=0;offset<data.length;offset+=2)data.writeInt16LE(Math.floor(offset/80)%2?2400:-2400,offset);
 return data.toString('base64');
};

test('page-two whole-sentence requests target the reading block while explicit word requests retain word granularity',()=>{
 const resolver=new InteractionLabMarkRequest();
 resolver.setPage(ROBOT_READING_COURSE.pages[0]);
 const predict=resolver.accept('请给正文第一句加下划线。',undefined,1000,'speech');
 assert.equal(predict?.state==='applied'&&predict.mark.targetId,'passage-first');
 resolver.setPage(ROBOT_READING_COURSE.pages[1]);
 for(const phrase of ['Please underline the sentence.','给整句正文画下划线。']){
  const result=resolver.accept(phrase,undefined,1000,'speech','read-title-word-2');
  assert.equal(result?.state==='applied'&&result.mark.targetId,'read-passage');
 }
 const word=resolver.accept('Please underline the word sentence.',undefined,1000,'speech');
 assert.equal(word?.state==='applied'&&word.mark.targetId,'read-title-word-2');
});

test('GPT Live lab supports page-scoped speech annotations and confirms real display before spoken success',async t=>{
 const vendorHttp=createServer(),vendor=new WebSocketServer({server:vendorHttp});
 let peer:WebSocket|undefined,endpoint:string|undefined;
 const upstream:Wire[]=[],downstream:Wire[]=[];
 vendor.on('connection',socket=>{peer=socket;socket.on('message',raw=>{
  const event=JSON.parse(raw.toString()) as Wire;
  upstream.push(event);
  if(event.type==='session.start')socket.send(JSON.stringify({type:'session.started',session:{id:'synthetic-live-lab'}}));
  if(event.type==='session.thinking.append')socket.send(JSON.stringify({type:'session.thinking.appended',client_event_id:event.event_id}));
  if(event.type==='session.close')socket.send(JSON.stringify({type:'session.closed'}));
 });});
 vendorHttp.listen(0,'127.0.0.1');await once(vendorHttp,'listening');
 const address=vendorHttp.address();assert(address&&typeof address!=='string');
 const lab=await startInteractionLabServer({port:0,configuration:async()=>({key:'mock-configuration',model:'gpt-live-1',voice:'gleam',childDataReady:true}),connect:url=>{
  endpoint=url;return new WebSocket(`ws://127.0.0.1:${address.port}`);
 }});
 t.after(async()=>{
  await lab.close();
  for(const socket of vendor.clients)socket.terminate();
  await new Promise<void>(resolve=>vendor.close(()=>resolve()));
  await new Promise<void>(resolve=>vendorHttp.close(()=>resolve()));
 });
 const sessionResult=await fetch(lab.origin+'/lab/session?mode=guided&provider=openai',{method:'POST',headers:{Origin:lab.origin}});
 assert.equal(sessionResult.status,201);
 const cookie=sessionResult.headers.get('set-cookie')!.split(';')[0];
 const {id,snapshot}=await sessionResult.json() as LabSession;
 assert.equal(snapshot.preferences.provider,'openai');assert.equal(snapshot.course.pages.length,2);
 const headers={Origin:lab.origin,Cookie:cookie};
 const client=new WebSocket(lab.origin.replace('http','ws')+'/ws/classrooms/'+id,{headers});
 client.on('error',()=>{});client.on('message',raw=>downstream.push(JSON.parse(raw.toString()) as Wire));
 await once(client,'open');await waitFor(()=>downstream.some(event=>event.type==='ready'),'Live never connected');
 assert.equal(endpoint,'wss://api.openai.com/v1/live/sessions');
 const socket=client;
 const batch=async()=>{
  const read=await fetch(lab.origin+'/lab/events/'+id,{headers});
  assert.equal(read.status,200);return (await read.json() as LabEventBatch).events;
 };
 const guide=(query:string)=>fetch(lab.origin+'/lab/guide/'+id+'?'+query,{headers,method:'POST'});
 const sendProvider=(event:unknown)=>{assert(peer);peer.send(JSON.stringify(event));};
 const barrier=async()=>{assert(peer);const pong=once(peer,'pong');peer.ping();await pong;};
 async function speak(text:string){
  socket.send(JSON.stringify({type:'audio',audio:pcm(true)}));
  socket.send(JSON.stringify({type:'audio',audio:pcm(true)}));
  await waitFor(()=>upstream.some(event=>event.type==='session.input_audio.append'),'Missing upstream input audio');
  const pong=once(socket,'pong');socket.ping();await pong;
  sendProvider({type:'session.input_transcript.delta',delta:text});await barrier();
  for(let frame=0;frame<12;frame++){
   await new Promise(resolve=>setTimeout(resolve,90));
   socket.send(JSON.stringify({type:'audio',audio:pcm(false)}));
  }
 }
 async function mark(text:string,targetId:string,shape:string){
  const seen=new Set((await batch()).map(({id})=>id));
  const start=upstream.length;
  await speak(text);
  const action=await waitFor(async()=>(await batch()).find(item=>!seen.has(item.id)&&item.data?.event==='teacher.mark'),`Missing ${shape} for ${targetId}`);
  assert.equal(action.data?.targetId,targetId);assert.equal(action.data?.shape,shape);
  assert.equal(action.data?.awaitDisplay,true);
  assert(!upstream.slice(start).some(e=>e.type==='session.commentary.append'&&e.content?.includes('The page confirms')));
  assert.equal((await guide('mark='+randomUUID())).status,409);
  assert.equal((await guide('mark='+action.data!.actionId)).status,204);
  await waitFor(async()=>(await batch()).some(e=>e.data?.event==='teacher.mark.displayed'&&e.data.actionId===action.data!.actionId),'No display receipt');
  // Live keeps the input and output timelines moving while both sides are quiet.
  const silence=setInterval(()=>{
   sendProvider({type:'session.output_audio.delta',delta:pcm(false)});
   socket.send(JSON.stringify({type:'audio',audio:pcm(false)}));
  },100);
  try{
   await waitFor(()=>upstream.slice(start).some(e=>e.type==='session.commentary.append'&&e.content?.includes('The page confirms')),'No post-display spoken cue');
  }finally{clearInterval(silence);}
  return action;
 }
 const first=await mark('Please underline the word machine in the first sentence.','passage-machine','underline');
 assert.equal(first.data?.pageId,'robot-predict');
 const tail=await mark('请把尾巴圈出来。','tail','circle');
 assert.equal(tail.data?.pageId,'robot-predict');
 const revision=downstream.findLast(event=>event.type==='snapshot')?.classroom?.revision;assert.equal(typeof revision,'number');
 const navigation=await guide(`step=1&revision=${revision}`);assert.equal(navigation.status,204);
 const page=await waitFor(()=>downstream.findLast(event=>event.type==='snapshot'&&event.classroom?.stepIndex===1)?.classroom,'Live snapshot did not advance');
 assert.equal((await guide('mark='+first.data!.actionId)).status,409);
 assert.equal((await guide(`select=passage-machine&revision=${page.revision}`)).status,400);
 assert.equal((await guide(`select=read-transition&revision=${page.revision-1}`)).status,409);
 assert.equal((await guide(`select=read-transition&revision=${page.revision}`)).status,204);
 assert(!upstream.some(e=>e.type==='input_image_buffer.append'));
 const action=await mark('Please highlight this word.','read-transition','highlight');
 assert.equal(action.data?.pageId,'robot-read');
 const illustrated=await mark('Please circle the wings in the picture.','wings','circle');
 assert.equal(illustrated.data?.pageId,'robot-read');
 const start=upstream.length;
 await speak('请给单词 transition 加下划线。');
 const pending=await waitFor(async()=>(await batch()).find(item=>item.data?.event==='teacher.mark'&&item.data?.targetId==='read-transition'&&item.data?.shape==='underline'),'No pending page-two mark');
 assert.equal((await guide(`step=0&revision=${page.revision}`)).status,204);
 assert.equal((await guide('mark='+pending.data!.actionId)).status,409);
 await waitFor(async()=>(await batch()).some(item=>item.data?.event==='teacher.mark.cancelled'&&item.data.actionId===pending.data!.actionId),'Changing the page did not cancel the old mark');
 assert(!upstream.slice(start).some(event=>event.type==='session.commentary.append'&&event.content?.includes('The page confirms')));
 const visible=(await batch()).filter((event:LabEvent)=>event.data?.event==='teacher.mark.displayed');
 assert.deepEqual(visible.map(event=>event.data?.targetId),['passage-machine','tail','read-transition','wings']);
 assert(!downstream.some(event=>event.type==='error'));
 client.terminate();
});
