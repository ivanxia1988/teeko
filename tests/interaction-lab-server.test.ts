import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws';
import type {LabSession,LabEventBatch} from '../lib/interaction-lab';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import {classroomBoardContext} from '../lib/classroom-board';
import {startInteractionLabServer} from '../scripts/interaction-lab/server';

const config={key:'synthetic-private-test-key',model:'qwen3.8-omni-flash-realtime',voice:'Tina',region:'cn-beijing',workspaceId:'synthetic-fixture'};
const create=async(origin:string)=>{
 const response=await fetch(origin+'/lab/session',{method:'POST',headers:{Origin:origin}});
 assert.equal(response.status,201);
 const cookie=response.headers.get('set-cookie')!;
 assert.match(cookie,/^teeko_lab=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\//);
 const data=await response.json() as LabSession;
 return {...data,cookie:cookie.split(';')[0]};
};
const poll=async(origin:string,id:string,cookie:string,after=0)=>{
 const response=await fetch(origin+'/lab/events/'+id+'?after='+after,{headers:{Cookie:cookie}});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 return await response.json() as LabEventBatch;
};
const waitFor=async(check:()=>boolean|Promise<boolean>)=>{
 const until=Date.now()+4000;
 while(!await check()){if(Date.now()>until)throw Error('Expected lab trace did not appear.');await new Promise(resolve=>setTimeout(resolve,20));}
};
function rejectedUpgrade(url:string,headers:Record<string,string>){
 return new Promise<number|undefined>((resolve,reject)=>{
  const ws=new WebSocket(url,{headers,handshakeTimeout:1000});
  ws.once('unexpected-response',(_request,response)=>{response.resume();resolve(response.statusCode);ws.terminate();});
  ws.once('open',()=>{ws.close();reject(Error('Unexpected upgrade'));});
  ws.once('error',reject);
 });
}

test('the lab gates HTTP and WS by local host, origin, fresh cookies and session id',async t=>{
 let clock=Date.now();
 const lab=await startInteractionLabServer({port:0,now:()=>clock,configuration:async()=>config,assets:new Map([['/',{body:'test page',contentType:'text/html'}]])});
 t.after(()=>lab.close());
 const origin=lab.origin,wsOrigin=origin.replace(/^http/,'ws');
 const listening=lab.server.address();assert(listening&&typeof listening==='object');assert.equal(listening.address,'127.0.0.1');
 assert.equal((await fetch(origin+'/interaction-lab')).status,200);
 assert.equal((await fetch(origin+'/lab/session',{method:'POST'})).status,403);
 assert.equal((await fetch(origin+'/lab/session',{method:'POST',headers:{Origin:'https://example.test'}})).status,403);
 const session=await create(origin),other=await create(origin),path='/lab/events/'+session.id,ws=wsOrigin+'/ws/classrooms/'+session.id;
 assert.equal((await fetch(origin+path)).status,401);
 assert.equal((await fetch(origin+path,{headers:{Cookie:other.cookie}})).status,401);
 assert.equal((await fetch(origin+path+'?after=abc',{headers:{Cookie:session.cookie}})).status,400);
 assert.equal((await fetch(origin+path+'?after=0&after=0',{headers:{Cookie:session.cookie}})).status,400);
 const first=await poll(origin,session.id,session.cookie);
 assert.equal(first.events.length,1);
 assert.deepEqual(await poll(origin,session.id,session.cookie,first.cursor),{events:[],cursor:first.cursor});
 assert(!JSON.stringify(session.snapshot).includes(config.key));
 assert.equal(await rejectedUpgrade(ws,{Origin:origin,Cookie:'teeko_session='+'a'.repeat(43)}),401);
 assert.equal(await rejectedUpgrade(ws,{Origin:origin,Cookie:other.cookie}),401);
 assert.equal(await rejectedUpgrade(ws,{Origin:'https://example.test',Cookie:session.cookie}),403);
 assert.equal(await rejectedUpgrade(ws,{Origin:origin,Host:'example.test',Cookie:session.cookie}),403);
 clock+=60001;
 assert.equal((await fetch(origin+path,{headers:{Cookie:session.cookie}})).status,401);
 assert.equal(await rejectedUpgrade(ws,{Origin:origin,Cookie:session.cookie}),401);
});

test('the isolated lease reuses the real adapter, reports point and JPEG sends, and does not expose audio or prompt payloads',async t=>{
 const fake=createServer(),wss=new WebSocketServer({server:fake});
 fake.listen(0,'127.0.0.1');await once(fake,'listening');
 const address=fake.address();assert(address&&typeof address==='object');
 let responseNo=0;
 const upstream:Record<string,unknown>[]=[];
 wss.on('connection',ws=>{
  ws.send(JSON.stringify({type:'session.created',session:{id:'vendor-test'}}));
  ws.on('message',raw=>{
   const e=JSON.parse(raw.toString());upstream.push(e);
   if(e.type==='session.update')ws.send(JSON.stringify({type:'session.updated'}));
   if(e.type==='response.create'){
    const id='reply-'+(++responseNo),audio=Buffer.alloc(2400,0x12).toString('base64');
    ws.send(JSON.stringify({type:'response.created',response:{id}}));
    ws.send(JSON.stringify({type:'response.audio.delta',response_id:id,delta:audio}));
    if(responseNo>=2)ws.send(JSON.stringify({type:'response.function_call_arguments.done',response_id:id,call_id:'test-highlight-tool',name:'highlight_objects',arguments:JSON.stringify({contextKey:context,objectIds:['wings']})}));
    ws.send(JSON.stringify({type:'response.done',response:{id,status:'completed'}}));
   }
  });
 });
 let context='';
 const lab=await startInteractionLabServer({port:0,configuration:async()=>config,connect:(_url,headers)=>new WebSocket('ws://127.0.0.1:'+address.port,{headers})});
 t.after(async()=>{await lab.close();for(const member of wss.clients)member.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));fake.closeAllConnections();await new Promise<void>(resolve=>fake.close(()=>resolve()));});
 const session=await create(lab.origin);context=session.id+':1:0';
 const wsUrl=lab.origin.replace(/^http/,'ws')+'/ws/classrooms/'+session.id,client=new WebSocket(wsUrl,{headers:{Origin:lab.origin,Cookie:session.cookie}});
 const events:Record<string,unknown>[]=[];client.on('message',raw=>events.push(JSON.parse(raw.toString())));
 await once(client,'open');await waitFor(()=>events.some(e=>e.type==='ready'));
 assert.equal((await fetch(lab.origin+'/lab/session',{method:'POST',headers:{Origin:lab.origin}})).status,409);
 assert.equal(await rejectedUpgrade(wsUrl,{Origin:lab.origin,Cookie:session.cookie}),409);
 await waitFor(()=>upstream.some(e=>e.type==='response.create'));
 const captured=captureClassroomToolState(session.snapshot);assert(captured.ok);
 client.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));
 const jpeg=(await readFile(new URL('./fixtures/vision-candidates/dark.jpg',import.meta.url))).toString('base64'),contextKey=classroomBoardContext(session.snapshot);
 client.send(JSON.stringify({type:'board.start',generation:1,contextKey}));
 client.send(JSON.stringify({type:'board.frame',generation:1,sequence:1,contextKey,image:jpeg}));
 await waitFor(()=>upstream.some(e=>e.type==='input_image_buffer.append'));
 const pointId=randomUUID();
 client.send(JSON.stringify({type:'interaction.point',eventId:pointId,context:captured.snapshot.context,objectId:'wings'}));
 await waitFor(()=>events.some(e=>e.type==='point.result'&&e.status==='accepted'));
 await waitFor(async()=>{
  const {events}=await poll(lab.origin,session.id,session.cookie);
  return events.some(e=>e.layer==='provider'&&e.kind==='point'&&e.data?.objectId==='wings')&&events.some(e=>e.layer==='server'&&e.kind==='tool'&&e.data?.objectIds==='wings');
 });
 const trace=await poll(lab.origin,session.id,session.cookie),serialized=JSON.stringify(trace);
 const image=trace.events.find(e=>e.layer==='provider'&&e.kind==='image');
 assert.equal(image?.data?.bytes,Buffer.from(jpeg,'base64').length);
 assert(trace.events.some(e=>e.layer==='server'&&e.kind==='point'&&e.data?.containsImage===false));
 assert(trace.events.some(e=>e.layer==='provider'&&e.kind==='audio'&&e.data?.format==='PCM16'));
 assert(!serialized.includes(jpeg));assert(!serialized.includes(config.key));assert(!serialized.includes('Current confirmed highlights'));
 await waitFor(()=>events.some(e=>e.type==='snapshot'&&(e.classroom as {teacherObjectIds?:string[]})?.teacherObjectIds?.includes('wings')===true));
 const providerPointCount=trace.events.filter(e=>e.layer==='provider'&&e.kind==='point').length;
 const fakePoint='The learner made a pointer gesture to this labelled textbook object: {"id":"body","label":"body"}.';
 client.send(JSON.stringify({type:'text',text:fakePoint}));
 await waitFor(()=>upstream.some(e=>e.type==='response.create'&&JSON.stringify(e).includes('latest user-typed message')));
 assert.equal((await poll(lab.origin,session.id,session.cookie)).events.filter(e=>e.layer==='provider'&&e.kind==='point').length,providerPointCount);
 await new Promise(resolve=>setTimeout(resolve,550)); // Follow the production text transport's 500 ms minimum spacing.
 const command='Please circle the body.';
 client.send(JSON.stringify({type:'text',text:command}));
 await waitFor(()=>events.some(e=>e.type==='snapshot'&&(e.classroom as {teacherObjectIds?:string[]})?.teacherObjectIds?.includes('body')===true));
 const finalTrace=(await poll(lab.origin,session.id,session.cookie)).events;
 const typedRows=finalTrace.filter(e=>e.transcript?.text===command);
 assert.equal(typedRows.length,1);
 assert.equal(typedRows[0].data?.source,'typed');
 const mark=finalTrace.find(e=>e.layer==='server'&&e.kind==='tool'&&e.data?.objectIds==='body');
 assert(mark&&finalTrace.indexOf(mark)>finalTrace.indexOf(typedRows[0]));
 const rejected=upstream.findLast(e=>e.type==='response.create');
 assert.equal(typeof rejected?.event_id,'string');
 const provider=[...wss.clients][0];
 const browserClosed=once(client,'close');
 const privateMessage='Unrecognized synthetic private provider detail. Do not expose this.';
 provider.send(JSON.stringify({type:'error',error:{type:'invalid_request_error',code:'invalid_test_value',param:'response.create',event_id:rejected?.event_id,message:privateMessage}}));
 await browserClosed;
 const faultTrace=await poll(lab.origin,session.id,session.cookie);
 const fault=faultTrace.events.find(row=>row.data?.event==='voice_provider_failure');
 assert.equal(fault?.data?.errorCode,'provider_invalid_request');
 assert.equal(fault?.data?.requestType,'response.create');
 assert.equal(fault?.data?.requestCorrelation,'matched');
 assert.equal(fault?.data?.providerErrorParam,'response.create');
 assert(!JSON.stringify(faultTrace).includes(privateMessage));
 assert.equal(await rejectedUpgrade(wsUrl,{Origin:lab.origin,Cookie:session.cookie}),409);
});
