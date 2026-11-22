import test from 'node:test';
import assert from 'node:assert/strict';
import {ClassroomPointDiagnosticsClient} from '../lib/classroom-point-diagnostics-client';

const classroomId='10000000-0000-4000-8000-000000000001',pointId='20000000-0000-4000-8000-000000000001';
const context={logicalSessionId:classroomId,courseVersion:'reading:1',connectionEpoch:2,stateRevision:4,pageId:'robot',activityId:'clue'};

test('HTTP diagnostics keep one point identity, bounded batches and a captured full context without a voice socket',async()=>{
 const calls:{url:string;body:{events:{id:string;pointId:string;context:typeof context;stage:string}[]}}[]=[];
 const queue=new ClassroomPointDiagnosticsClient(classroomId,{fetch:async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init?.body))});return Response.json({ok:true});}});
 assert(queue.record({pointId,context,objectId:'wings',stage:'clicked'}));
 for(let i=0;i<12;i++)assert(queue.record({pointId,stage:'send_failed',reason:'not_ready'}));
 await queue.flush();assert.equal(calls.length,2);assert(calls.every(call=>call.url==='/api/v1/classrooms/'+classroomId+'/diagnostics'&&call.body.events.length<=10));
 const events=calls.flatMap(call=>call.body.events);assert.equal(events.length,13);assert(events.every(event=>event.pointId===pointId&&event.context.activityId==='clue'));assert.equal(new Set(events.map(event=>event.id)).size,13);
 queue.close();
});
test('malformed, foreign or unbound observations never become diagnostic requests, and the queue is bounded',async()=>{
 const bodies:{events:unknown[]}[]=[];const queue=new ClassroomPointDiagnosticsClient(classroomId,{fetch:async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));return Response.json({ok:true});}});
 assert.equal(queue.record({pointId,stage:'sent'}),false);
 assert.equal(queue.record({pointId,context:{...context,logicalSessionId:'another'},stage:'clicked'}),false);
 assert.equal(queue.record({pointId,context,stage:'send_failed',reason:'PRIVATE_PROVIDER_BODY' as 'unknown'}),false);
 assert.equal(queue.record({...{pointId,context,stage:'clicked' as const},secret:'never send this'} as never),false);
 for(let i=0;i<100;i++)queue.record({pointId,context,objectId:'wings',stage:'clicked'});
 await queue.flush();assert.equal(bodies.flatMap(body=>body.events).length,40);queue.close();
});
test('a failed or stalled HTTP report never retries itself and later observations remain independent',async()=>{
 let calls=0;const queue=new ClassroomPointDiagnosticsClient(classroomId,{timeoutMs:5,fetch:async()=>{calls++;if(calls===1)throw Error('private transport failure');return new Promise<Response>(()=>{});}});
 queue.record({pointId,context,stage:'clicked'});await queue.flush();await queue.flush();assert.equal(calls,1);
 queue.record({pointId,stage:'timeout',reason:'ack_timeout'});await queue.flush();assert.equal(calls,2);
 await queue.flush();assert.equal(calls,2);queue.close();
});
test('observations arriving as the previous HTTP drain settles still flush without another click or manual retry',async()=>{
 await Promise.all(Array.from({length:12},async(_,turns)=>{
  let calls=0;const queue=new ClassroomPointDiagnosticsClient(classroomId,{fetch:async()=>{calls++;return Response.json({ok:true});}});
  try{
   queue.record({pointId,context,stage:'clicked'});const first=queue.flush();
   for(let i=0;i<turns;i++)await Promise.resolve();
   queue.record({pointId,stage:'send_failed',reason:'not_ready'});await first;
   await new Promise(resolve=>setTimeout(resolve,130));
   assert.equal(calls,2,'Observation was stranded after '+turns+' microtask turns.');
  }finally{queue.close();}
 }));
});
