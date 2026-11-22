import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import test, {type TestContext} from 'node:test';
import WebSocket,{WebSocketServer} from 'ws';
import type {ClassroomSnapshot} from '../lib/classroom-contract';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import type {LabEvent,LabEventBatch,LabSession} from '../lib/interaction-lab';
import {startInteractionLabServer} from '../scripts/interaction-lab/server';

type Message = {type:string; status?:string; eventId?:string; classroom?:ClassroomSnapshot; audio?:string; session?:{instructions?:string};response?:{instructions?:string}};
const config={key:'synthetic-lab-fixture-key',model:'qwen3.8-omni-flash-realtime',voice:'Tina',region:'cn-beijing',workspaceId:'synthetic-fixture'};
const pointCue='The learner made a pointer gesture';
const recallCue='Verified pointer recall:';
const delay=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function applicationCue(instructions:string|undefined){
 try{const value:unknown=JSON.parse(instructions?.split('\n').at(-1)??'');return typeof value==='string'?value:'';}catch{return '';}
}
const waitFor=async (description:string,check:()=>boolean|Promise<boolean>)=>{
 const stop=performance.now()+2200;
 while(!await check()){if(performance.now()>=stop)assert.fail(description);await delay(10);}
};

async function fixture(t:TestContext,holdPointAck:boolean){
 const fake=createServer(),vendor=new WebSocketServer({server:fake});
 fake.listen(0,'127.0.0.1');await once(fake,'listening');
 const address=fake.address();assert(address&&typeof address==='object');
 const lab=await startInteractionLabServer({port:0,configuration:async()=>config,connect:(_endpoint,headers)=>new WebSocket('ws://127.0.0.1:'+address.port,{headers})});
 let closeBrowser=()=>{},remote:WebSocket|undefined;
 t.after(async()=>{
  closeBrowser();await lab.close();
  for(const socket of vendor.clients)socket.terminate();
  await new Promise<void>(resolve=>vendor.close(()=>resolve()));
  fake.closeAllConnections();
  await new Promise<void>(resolve=>fake.close(()=>resolve()));
 });
 let pendingPointAck=false,activeNative:string|null=null,replies=0;
 const sent:Message[]=[],received:Message[]=[];
 let autoVoiceReplies=0;
 const fromVendor=(message:unknown)=>{assert(remote&&remote.readyState===WebSocket.OPEN);remote.send(JSON.stringify(message));};
 vendor.on('connection',socket=>{
  remote=socket;fromVendor({type:'session.created',session:{id:'lab-recall-fixture'}});
  socket.on('message',raw=>{
   const message=JSON.parse(raw.toString()) as Message;sent.push(message);
   if(message.type==='session.update'){
    if(holdPointAck&&message.session?.instructions?.includes(pointCue)){pendingPointAck=true;return;}
    fromVendor({type:'session.updated'});return;
   }
   if(message.type==='response.cancel'&&activeNative){
    fromVendor({type:'response.done',response:{id:activeNative,status:'cancelled'}});
    activeNative=null;return;
   }
   if(message.type==='response.create'){
    const id='app-reply-'+(++replies),cue=applicationCue(message.response?.instructions),recall=cue.startsWith(recallCue);
    fromVendor({type:'response.created',response:{id}});
    fromVendor({type:'response.audio.delta',response_id:id,delta:Buffer.alloc(2400,recall?0x33:0x19).toString('base64')});
    const object=/\b(wings|tail)\b/i.exec(cue)?.[1];
    if(recall)fromVendor({type:'response.audio_transcript.done',response_id:id,item_id:'recall-teacher-'+replies,transcript:object?`You pointed to the ${object}.`:'Please point to a part again.'});
    fromVendor({type:'response.done',response:{id,status:'completed'}});return;
   }
  });
 });
 const response=await fetch(lab.origin+'/lab/session',{method:'POST',headers:{Origin:lab.origin}});
 assert.equal(response.status,201);const cookie=response.headers.get('set-cookie')?.split(';')[0];assert(cookie);
 const session=await response.json() as LabSession;
 const browser=new WebSocket(lab.origin.replace(/^http/,'ws')+'/ws/classrooms/'+session.id,{headers:{Origin:lab.origin,Cookie:cookie}});
 closeBrowser=()=>browser.terminate();
 browser.on('message',raw=>received.push(JSON.parse(raw.toString()) as Message));
 await once(browser,'open');
 const trace=async()=>{
  const response=await fetch(lab.origin+'/lab/events/'+session.id+'?after=0',{headers:{Cookie:cookie}});
  assert.equal(response.status,200);return (await response.json() as LabEventBatch).events;
 };
 await waitFor('greeting should finish before the test starts',async()=>received.some(message=>message.type==='ready')&&(await trace()).some(event=>event.layer==='provider'&&event.data?.event==='response.done'));
 const send=(message:unknown)=>{assert(browser?.readyState===WebSocket.OPEN);browser.send(JSON.stringify(message));};
 return {
  received,sent,trace,
  async point(objectId:string){
   const snapshot=received.findLast(message=>message.type==='snapshot')?.classroom??session.snapshot;
   const state=captureClassroomToolState(snapshot);assert(state.ok);
   const eventId=randomUUID();send({type:'interaction.point',eventId,objectId,context:state.snapshot.context});
   await waitFor('point should be accepted and acknowledged to the browser',()=>received.some(message=>message.type==='point.result'&&message.eventId===eventId&&message.status==='accepted'));
   return eventId;
  },
  async beginVoice(itemId:string){
   fromVendor({type:'input_audio_buffer.speech_started',item_id:itemId});
   await waitFor('speech_started should cross the real adapter',async()=>(await trace()).some(event=>event.data?.event==='input_audio_buffer.speech_started'));
  },
  finishVoice(itemId:string,transcript:string){
   fromVendor({type:'input_audio_buffer.speech_stopped',item_id:itemId});
   fromVendor({type:'conversation.item.input_audio_transcription.completed',item_id:itemId,transcript});
   activeNative='vendor-vad-'+(++autoVoiceReplies);
   fromVendor({type:'response.created',response:{id:activeNative}});
  },
  async releasePointAck(){
   await waitFor('point response should be waiting for the provider session.updated',()=>pendingPointAck);
   pendingPointAck=false;fromVendor({type:'session.updated'});
  },
 };
}
const isRecall=(event:LabEvent)=>event.layer==='server'&&event.label==='已请求老师回答刚才的点选';
const replyRequests=(sent:Message[])=>sent.filter(message=>message.type==='response.create');
const recalls=(sent:Message[])=>replyRequests(sent).filter(message=>applicationCue(message.response?.instructions).startsWith(recallCue));
const noSideEffects=(received:Message[])=>{
 const snapshots=received.flatMap(message=>message.classroom?[message.classroom]:[]);
 assert(snapshots.length>0);
 for(const snapshot of snapshots){assert.equal(snapshot.stepIndex,0);assert.deepEqual(snapshot.outcomes,[]);assert.deepEqual(snapshot.teacherObjectIds,[]);}
 assert(!received.some(message=>message.type==='error'));
};

test('speech can cancel the old point reply and still ask about the confirmed point in a new audible reply',async t=>{
 const f=await fixture(t,true),pointId=await f.point('wings');
 await waitFor('the outgoing point configuration is intentionally unacknowledged',()=>f.sent.some(message=>message.type==='session.update'&&message.session?.instructions?.includes(pointCue)===true));
 assert.equal(replyRequests(f.sent).length,1);
 await f.beginVoice('learner-recall');
 await f.releasePointAck();
 f.finishVoice('learner-recall','What did I point to?');
 await waitFor('latest explicit voice question should request a verified point recall',()=>recalls(f.sent).length===1);
 const cue=applicationCue(recalls(f.sent)[0].response?.instructions);
 assert.match(cue,/\bwings\b/i);
 assert(!replyRequests(f.sent).some(message=>message.response?.instructions?.includes(pointCue)));
 await waitFor('audible PCM from the NEW recall should reach the browser',()=>f.received.some(message=>message.type==='audio'&&message.audio&&Buffer.from(message.audio,'base64')[0]===0x33));
 const recall=(await f.trace()).find(isRecall);
 assert.equal(recall?.data?.pointId,pointId);assert.equal(recall?.data?.objectId,'wings');assert.equal(recall?.data?.state,'confirmed_point');
 assert((await f.trace()).some(event=>event.transcript?.role==='teacher'&&event.transcript.text==='You pointed to the wings.'));
 await delay(725); // The ordinary overlapping-VAD fallback must not request a duplicate reply.
 assert.equal(recalls(f.sent).length,1);assert.equal(replyRequests(f.sent).length,2);noSideEffects(f.received);
});

test('a point recall without any accepted point asks again instead of guessing a textbook part',async t=>{
 const f=await fixture(t,false);
 await f.beginVoice('learner-without-point');
 f.finishVoice('learner-without-point','What did I point to?');
 await waitFor('no-point voice question should request an honest re-point prompt',()=>recalls(f.sent).length===1);
 const recall=(await f.trace()).find(isRecall);
 assert.equal(recall?.data?.state,'no_recent_point');assert.equal(recall?.data?.objectId,undefined);assert.equal(recall?.data?.pointId,undefined);
 await waitFor('re-point prompt should reach the browser as audio',()=>f.received.some(message=>message.type==='audio'&&message.audio&&Buffer.from(message.audio,'base64')[0]===0x33));
 assert((await f.trace()).some(event=>event.transcript?.role==='teacher'&&event.transcript.text==='Please point to a part again.'));
 assert.equal(recalls(f.sent).length,1);noSideEffects(f.received);
});

test('the latest confirmed point wins even when both earlier acknowledgements were sent',async t=>{
 const f=await fixture(t,false),first=await f.point('wings');
 await waitFor('first point reply should finish',async()=>(await f.trace()).filter(event=>event.layer==='provider'&&event.data?.event==='response.done').length===2);
 await delay(500); // Existing pointer throttle is independent of the recall window.
 const last=await f.point('tail');
 assert.notEqual(last,first);
 await waitFor('second point reply should finish',async()=>(await f.trace()).filter(event=>event.layer==='provider'&&event.data?.event==='response.done').length===3);
 await f.beginVoice('learner-latest-point');f.finishVoice('learner-latest-point','What did I point to?');
 await waitFor('the follow-up should query the latest point',()=>recalls(f.sent).length===1);
 const cue=applicationCue(recalls(f.sent)[0].response?.instructions);assert.match(cue,/\btail\b/i);assert.doesNotMatch(cue,/\bwings\b/i);
 const trace=(await f.trace()).find(isRecall);
 assert.equal(trace?.data?.pointId,last);assert.equal(trace?.data?.objectId,'tail');assert.equal(trace?.data?.state,'confirmed_point');
 noSideEffects(f.received);
});
