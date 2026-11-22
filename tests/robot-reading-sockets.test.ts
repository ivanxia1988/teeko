import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws';
import {attachClassroomSockets,type VoiceLease} from '../lib/server/classroom-sockets';
import {refreshClassroom} from '../lib/server/classroom-events';
import {ROBOT_READING_COURSE} from '../lib/server/robot-reading-course';
import {TOPIC_ROBOT_COURSE} from '../lib/server/topic-courses';
import {gptRobotHighlightCue,GPT_ROBOT_HIGHLIGHT_MODEL} from '../lib/classroom-cues';
import {buildTeacherInstructions,buildTeacherGuidance,readTeachingState} from '../lib/teacher-instructions';
import {teacherConfig,teacherSnapshot} from './teacher-runtime-fixture';
import type {ClassroomSnapshot,ClassroomPreferences} from '../lib/classroom-contract';

type WireEvent={type?:string;session?:{id?:string;instructions?:string;delegation?:{type:string;responses?:{tools:Array<{name:string}>}}};content?:string;event_id?:string;classroom?:ClassroomSnapshot;item?:{call_id:string;output:string}};
const waitFor=async(check:()=>boolean)=>{const until=Date.now()+3000;while(!check()){if(Date.now()>=until)throw Error('Synthetic reading context did not arrive.');await new Promise(resolve=>setTimeout(resolve,5));}};
async function fixture(provider:ClassroomPreferences['provider'], proactive=false){
 const id=randomUUID(),vendorHttp=createServer(),vendor=new WebSocketServer({server:vendorHttp}),app=createServer();
 const sent:WireEvent[]=[],downstream:WireEvent[]=[];let peer:WebSocket|undefined;
 const initial=teacherSnapshot({id,course:proactive?TOPIC_ROBOT_COURSE:ROBOT_READING_COURSE,stepIndex:0,profile:{name:'Synthetic learner',ageRange:'12–13',level:'sentences'},preferences:{provider,language:'bilingual',style:'gentle',voice:'female',soundEffects:false},remainingSeconds:1200,maxSeconds:1200});
 let current=initial;
 const reference=()=>{const state=readTeachingState({},current.profile.level);return{snapshot:current,instructions:buildTeacherInstructions(current,teacherConfig,state),teachingGuidance:buildTeacherGuidance(current,teacherConfig,state)};};
 vendor.on('connection',socket=>{peer=socket;socket.on('message',raw=>{
  const event=JSON.parse(raw.toString()) as WireEvent;sent.push(event);
  if(provider==='openai'&&event.type==='session.start')socket.send(JSON.stringify({type:'session.started',session:{id:'synthetic-reading-session'}}));
  if(provider!=='openai'&&event.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));
  if(provider!=='openai'&&event.type==='response.create'){socket.send(JSON.stringify({type:'response.created'}));socket.send(JSON.stringify({type:'response.done'}));}
  if(event.type==='session.close')socket.send(JSON.stringify({type:'session.closed'}));
 });if(provider!=='openai')socket.send(JSON.stringify({type:'session.created',session:{id:'synthetic-reading-session'}}));});
 vendorHttp.listen(0,'127.0.0.1');await once(vendorHttp,'listening');const vendorAddress=vendorHttp.address();assert(vendorAddress&&typeof vendorAddress!=='string');
 const lease:VoiceLease={id,epoch:1,provider,...reference(),remainingMs:1200000,initialCue:proactive?gptRobotHighlightCue(initial.course.steps[0].id)!:initial.course.steps[0].english,heartbeat:async()=>reference(),transcript:async()=>{},tool:async()=>({snapshot:current,output:{status:'unavailable'}}),closed:async()=>{},
  ...(proactive?{gptRobotHighlight:{model:GPT_ROBOT_HIGHLIGHT_MODEL,apply:async(scope:ClassroomSnapshot,_call:string,objectId:string,isCurrent:()=>boolean)=>{
   assert.equal(scope.stepIndex,0);assert.equal(objectId,'wings');assert.equal(isCurrent(),true);
   current={...current,revision:current.revision+1,teacherObjectIds:[objectId]};await refreshClassroom(id);return true;
  }}}:{}),
 };
 const owner=attachClassroomSockets(app,{origin:'http://localhost:8080',open:async()=>lease,config:()=>({key:'non-production-fixture',model:provider==='qwen'?'qwen3.8-omni-flash-realtime':provider==='grok'?'grok-voice-3.0':'gpt-live-1',voice:provider==='grok'?'eve':provider==='openai'?'gleam':'Tina',workspaceId:'synthetic',region:'cn-beijing',childDataReady:true}),connect:()=>new WebSocket(`ws://127.0.0.1:${vendorAddress.port}`),heartbeatMs:60000,startupMs:2000,closeMs:30});
 app.listen(0,'127.0.0.1');await once(app,'listening');const address=app.address();assert(address&&typeof address!=='string');
 const client=new WebSocket(`ws://127.0.0.1:${address.port}/ws/classrooms/${id}`,{headers:{Origin:'http://localhost:8080',Cookie:`teeko_session=${'t'.repeat(43)}`}});
 client.on('error',()=>{});client.on('message',raw=>downstream.push(JSON.parse(raw.toString()) as WireEvent));
 return{sent,downstream,initial,client,upstream(event:object){peer!.send(JSON.stringify(event));},async settle(){await once(client,'open');await waitFor(()=>downstream.some(event=>event.type==='ready'));if(provider!=='openai'){await waitFor(()=>sent.some(event=>event.type==='response.create'));assert(peer);const pong=once(peer,'pong');peer.ping('reading-ready');await pong;}},async turnPage(){current={...current,stepIndex:2,revision:current.revision+1,outcomes:[{stepId:'predict',status:'unassessed'},{stepId:'prediction-clue',status:'unassessed'}]};await refreshClassroom(id);await waitFor(()=>downstream.some(event=>event.type==='snapshot'&&event.classroom?.revision===2));},async close(){client.terminate();await owner.close();for(const socket of vendor.clients)socket.terminate();await new Promise<void>(resolve=>vendor.close(()=>resolve()));await new Promise<void>(resolve=>vendorHttp.close(()=>resolve()));await new Promise<void>(resolve=>app.close(()=>resolve()));}};
}

test('robot GPT Live opens the registered wings tool without a learner turn and returns its result',async()=>{
 const f=await fixture('openai',true);
 try{
  await f.settle();await waitFor(()=>f.sent.some(event=>event.type==='response.create'));
  const delegation=f.sent.find(event=>event.type==='session.start')?.session?.delegation;
  assert.equal(delegation?.type,'responses');assert.deepEqual(delegation.responses?.tools.map(t=>t.name),['highlight_objects']);
  f.upstream({type:'session.delegation.created',delegation:{target:'responses',id:'opening-delegation',response_id:'opening-response'}});
  const response=(event:object)=>f.upstream({type:'response.event',delegation_id:'opening-delegation',event});
  response({type:'response.created',response:{id:'opening-response'}});
  response({type:'response.output_item.done',response_id:'opening-response',item:{type:'function_call',name:'highlight_objects',call_id:'mark-wings',arguments:'{"objectId":"wings"}'}});
  response({type:'response.completed',response:{id:'opening-response'}});
  await waitFor(()=>f.downstream.some(event=>event.classroom?.teacherObjectIds.includes('wings')));
  await waitFor(()=>f.sent.filter(event=>event.type==='response.create').length===2);
  const result=f.sent.find(event=>event.type==='response.item.create')?.item;
  assert.equal(result?.call_id,'mark-wings');assert.deepEqual(JSON.parse(result.output),{status:'confirmed',highlighted:['wings']});
  assert(!f.downstream.some(event=>event.type==='error'));
 }finally{await f.close();}
});

for(const provider of ['qwen','openai','grok'] as const)test(`${provider} socket updates to the current robot reading page without stale passage or truncated guidance`,async()=>{
 const f=await fixture(provider);
 try{
  await f.settle();const previous=ROBOT_READING_COURSE.steps[0].reading!,next=ROBOT_READING_COURSE.steps[2].reading!;
  const greeting=f.sent.find(event=>event.type===(provider==='openai'?'session.start':'session.update'));assert(greeting?.session?.instructions?.includes(previous.passage));
  const start=f.sent.length;await f.turnPage();
  if(provider==='openai'){
   await waitFor(()=>f.sent.slice(start).some(event=>event.type==='session.thinking.append'&&event.content?.includes('teachingGuidance')));
   const parts=f.sent.slice(start).filter(event=>event.type==='session.thinking.append');assert(parts.length>1);
   assert(parts.every(event=>Buffer.byteLength(event.content??'','utf8')<=480));
   const envelope=JSON.parse(parts.map(event=>event.content).join('')) as {task:{id:string};teachingGuidance:string};
   assert.equal(envelope.task.id,'read-capabilities');assert(envelope.teachingGuidance.length<=2400);
   const guidance=JSON.parse(envelope.teachingGuidance) as {reading:{passage:string;goal:string}};
   assert.equal(guidance.reading.passage,next.passage);assert.equal(guidance.reading.goal,next.goal);assert(!envelope.teachingGuidance.includes(previous.passage));
  }else{
   await waitFor(()=>f.sent.slice(start).some(event=>event.type==='session.update'&&event.session?.instructions?.includes(next.passage)));
   const updates=f.sent.slice(start).filter(event=>event.type==='session.update');assert(updates.length>0);
   assert(updates.every(event=>event.session?.instructions?.includes(next.passage)&&event.session.instructions.includes(next.goal)&&!event.session.instructions.includes(previous.passage)));
  }
  assert(!f.downstream.some(event=>event.type==='error'));
 }finally{await f.close();}
});
