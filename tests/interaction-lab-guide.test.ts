import assert from 'node:assert/strict';
import {once} from 'node:events';
import test from 'node:test';
import WebSocket,{WebSocketServer} from 'ws';
import type {ClassroomSnapshot} from '../lib/classroom-contract';
import type {LabEventBatch,LabSession} from '../lib/interaction-lab';
import {startInteractionLabServer} from '../scripts/interaction-lab/server';

async function until<T>(find:()=>T|undefined){
 const deadline=Date.now()+4000;
 for(;;){const found=find();if(found!==undefined)return found;if(Date.now()>=deadline)throw Error('Expected guided reading event');await new Promise(resolve=>setTimeout(resolve,15));}
}

test('guided pages replace the live instructions and confirm only the displayed current target',async t=>{
 const fake=new WebSocketServer({host:'127.0.0.1',port:0});
 await once(fake,'listening');
 const address=fake.address();assert(address&&typeof address==='object');
 const sent:Record<string,unknown>[]=[];
 let provider!:WebSocket;
 fake.on('connection',ws=>{
  provider=ws;ws.send(JSON.stringify({type:'session.created',session:{id:'guided-fixture'}}));
  ws.on('message',raw=>{
   const event=JSON.parse(raw.toString());sent.push(event);
   if(event.type==='session.update')ws.send(JSON.stringify({type:'session.updated'}));
   if(event.type==='response.cancel')ws.send(JSON.stringify({type:'response.done',response:{id:'opening-0',status:'cancelled'}}));
  });
 });
 const lab=await startInteractionLabServer({port:0,configuration:async()=>({key:'synthetic',model:'qwen3.8-omni-flash-realtime',voice:'Tina',region:'cn-beijing',workspaceId:'fixture'}),connect:()=>new WebSocket('ws://127.0.0.1:'+address.port)});
 t.after(async()=>{await lab.close();for(const ws of fake.clients)ws.terminate();await new Promise<void>(resolve=>fake.close(()=>resolve()));});
 const headers={Origin:lab.origin};
 const started=await fetch(`${lab.origin}/lab/session?mode=guided`,{method:'POST',headers});
 assert.equal(started.status,201);
 const cookie=started.headers.get('set-cookie')!.split(';')[0],session=await started.json() as LabSession;
 assert.deepEqual(session.snapshot.course.pages.map(page=>page.id),['robot-predict','robot-read']);
 const client=new WebSocket(lab.origin.replace('http:','ws:')+'/ws/classrooms/'+session.id,{headers:{...headers,Cookie:cookie}});
 const received:{type:string;classroom?:ClassroomSnapshot}[]=[];
 client.on('message',raw=>received.push(JSON.parse(raw.toString())));
 const responseFor=(page:string)=>sent.find(e=>e.type==='response.create'&&JSON.stringify(e).includes(`Current page teaching plan (${page})`));
 const mark=(callId:string,contextKey:string,targetId:string,responseId:string)=>provider.send(JSON.stringify({type:'response.function_call_arguments.done',response_id:responseId,name:'highlight_objects',call_id:callId,arguments:JSON.stringify({contextKey,objectIds:[targetId]})}));
 const onGuide=(query:string,auth=cookie)=>fetch(`${lab.origin}/lab/guide/${session.id}?${query}`,{method:'POST',headers:{...headers,Cookie:auth}});
 const toolOutput=(callId:string)=>sent.find(e=>e.type==='conversation.item.create'&&(e.item as {call_id:string}).call_id===callId)?.item as {output:string}|undefined;
 const reply=(type:'created'|'done',id:string)=>provider.send(JSON.stringify({type:`response.${type}`,response:{id,...(type==='done'?{status:'completed'}:{})}}));
 const first=await until(()=>received.find(e=>e.type==='snapshot'&&e.classroom?.teacherObjectIds[0]==='passage-machine')?.classroom);
 assert.equal(sent.some(e=>e.type==='response.create'),false);
 assert.equal((await onGuide(`display=${first.revision}`,'teeko_lab='+'x'.repeat(43))).status,401);
 assert.equal((await onGuide(`display=${first.revision-1}`)).status,409);
 assert.equal((await onGuide(`display=${first.revision}`)).status,204);
 const firstCue=JSON.stringify(await until(()=>responseFor('robot-predict')));
 assert.match(firstCue,/Teach the word machine in the body text/);
 assert.doesNotMatch(firstCue,/45 to 60 seconds|four teaching points/);
 reply('created','spoken-0');reply('done','spoken-0');

 assert.equal((await onGuide(`step=1&revision=${first.revision}`)).status,204);
 const second=await until(()=>received.find(e=>e.type==='snapshot'&&e.classroom?.stepIndex===1)?.classroom);
 assert.deepEqual(second.teacherObjectIds,[]);
 const opening=await until(()=>responseFor('robot-read'));
 assert(!JSON.stringify(opening).includes('Current page teaching plan (robot-predict)'));
 assert.equal((await onGuide(`step=0&revision=${first.revision}`)).status,409);
 reply('created','opening-1');
 mark('old-target',session.id+':1:1','passage-machine','opening-1');
 reply('done','opening-1');
 assert.equal(JSON.parse((await until(()=>toolOutput('old-target'))).output).status,'unavailable');
 assert(!received.some(e=>e.classroom?.stepIndex===1&&e.classroom.teacherObjectIds.includes('passage-machine')));
 await until(()=>sent.filter(row=>row.type==='response.create').length>=3||undefined);
 reply('created','reading-focus');
 mark('pending-wings',session.id+':1:1','wings','reading-focus');
 reply('done','reading-focus');
 const pending=await until(()=>received.find(e=>e.classroom?.stepIndex===1&&e.classroom.teacherObjectIds[0]==='wings')?.classroom);
 assert.equal((await onGuide(`step=0&revision=${pending.revision}`)).status,204);
 assert.equal((await onGuide(`display=${pending.revision}`)).status,409);
 const returned=await until(()=>received.find(e=>e.classroom?.stepIndex===0&&e.classroom.revision>pending.revision&&e.classroom.teacherObjectIds.includes('passage-machine'))?.classroom);
 assert.equal((await onGuide(`display=${returned.revision}`)).status,204);
 await until(()=>sent.filter(e=>e.type==='response.create'&&JSON.stringify(e).includes('Current page teaching plan (robot-predict)')).length===2||undefined);
 reply('created','opening-return');reply('done','opening-return');
 const cancelled=JSON.parse((await until(()=>toolOutput('pending-wings'))).output);
 assert.equal(cancelled.status,'unavailable');
 const trace=await (await fetch(`${lab.origin}/lab/events/${session.id}`,{headers:{Cookie:cookie}})).json() as LabEventBatch;
 assert.deepEqual(trace.events.filter(e=>e.data?.event==='guide.plan.sent').map(e=>e.data?.pageId),['robot-predict','robot-read','robot-predict']);
 assert(!JSON.stringify(trace).includes('Current page teaching plan ('));
 assert.deepEqual(trace.events.filter(e=>e.data?.event==='guide.highlight.requested').map(e=>e.data?.source),['lesson','provider','lesson']);
});
