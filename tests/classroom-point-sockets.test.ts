import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws';
import {attachClassroomSockets,type VoiceLease} from '../lib/server/classroom-sockets';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import {teacherSnapshot} from './teacher-runtime-fixture';
import {ROBOT_READING_COURSE} from '../lib/server/robot-reading-course';
import type {ClassroomPointRequest} from '../lib/classroom-point';
import type {ClassroomJournalEntry} from '../lib/classroom-journal';
import {refreshClassroom} from '../lib/server/classroom-events';
const waitFor=async(check:()=>boolean)=>{const end=Date.now()+2500;while(!check()){if(Date.now()>end)throw Error('Expected point interaction event did not arrive');await new Promise(resolve=>setTimeout(resolve,5));}};
type Event={type:string;status?:string;eventId?:string;session?:{instructions?:string};[key:string]:unknown};
async function fixture(delayed=false,pointMs=5000,provider:'qwen'|'grok'='qwen',revisionRace:false|true|'task'|'repeat'=false,audible:false|true|'silent'=false,holdReply=false,pointReplyDelayMs?:number,labGuide?:VoiceLease['labGuide']){
 const id=randomUUID(),app=createServer(),vendorHttp=createServer(),vendor=new WebSocketServer({server:vendorHttp});
 let current=teacherSnapshot({id,course:ROBOT_READING_COURSE,stepIndex:1}),peer:WebSocket|undefined,release:(()=>void)|undefined;
 const journal:ClassroomJournalEntry[]=[];const sent:Event[]=[],received:Event[]=[],points:ClassroomPointRequest[]=[],transcripts:unknown[]=[];let tools=0;const currentChecks:boolean[]=[];
 vendor.on('connection',socket=>{peer=socket;socket.on('message',raw=>{const e=JSON.parse(raw.toString());sent.push(e);if(e.type==='session.update')socket.send(JSON.stringify({type:'session.updated'}));if(e.type==='response.create'){const rid=`reply-${sent.length}`;socket.send(JSON.stringify({type:'response.created',response:{id:rid}}));if(audible){const audio=Buffer.alloc(2400);if(audible===true)for(let i=0;i<audio.length;i+=2)audio.writeInt16LE(i%4?1800:-1800,i);socket.send(JSON.stringify({type:'response.audio.delta',response_id:rid,delta:audio.toString('base64')}));}if(!holdReply||sent.filter(event=>event.type==='response.create').length===1)socket.send(JSON.stringify({type:'response.done',response:{id:rid}}));}});socket.send(JSON.stringify({type:'session.created',session:{id:'synthetic-point'}}));});
 vendorHttp.listen(0,'127.0.0.1');await once(vendorHttp,'listening');const va=vendorHttp.address();assert(va&&typeof va!=='string');
 const lease:VoiceLease={id,epoch:1,provider,labGuide,nativeApplicationInputs:true,...(pointReplyDelayMs?{pointRecall:true as const}:{}),snapshot:current,instructions:'Discuss the current robot picture.',initialCue:'Which part gave you that idea?',remainingMs:900000,
  journal:async entry=>{journal.push(entry);},heartbeat:async()=>({snapshot:current,instructions:'Discuss the current robot picture.'}),transcript:async e=>{transcripts.push(e);},tool:async()=>{tools++;return{snapshot:current,output:{status:'unavailable'}};},
  point:async(request,isCurrent)=>{points.push(request);if(delayed)await new Promise<void>(resolve=>{release=resolve;});currentChecks.push(isCurrent());if(!isCurrent())return{accepted:false,snapshot:current};if(revisionRace&&(points.length===1||revisionRace==='repeat')){current={...current,revision:current.revision+1,...(revisionRace==='task'?{stepIndex:2}:{})};return{accepted:false,snapshot:current};}assert.equal(request.context.stateRevision,current.revision);current={...current,revision:current.revision+1};return{accepted:true,snapshot:current};},closed:async()=>{}};
 const owner=attachClassroomSockets(app,{origin:'http://localhost:8080',open:async()=>lease,config:()=>({key:'synthetic',workspaceId:'synthetic',model:provider==='grok'?'grok-voice-3.0':'qwen3.8-omni-flash-realtime',voice:provider==='grok'?'eve':'Tina',region:'cn-beijing'}),connect:()=>new WebSocket(`ws://127.0.0.1:${va.port}`),pointMs,pointReplyDelayMs,heartbeatMs:60000,connectionProbeMs:60000,startupMs:2000,closeMs:20});
 app.listen(0,'127.0.0.1');await once(app,'listening');const a=app.address();assert(a&&typeof a!=='string');
 const client=new WebSocket(`ws://127.0.0.1:${a.port}/ws/classrooms/${id}`,{headers:{Origin:'http://localhost:8080',Cookie:`teeko_session=${'p'.repeat(43)}`}});client.on('error',()=>{});client.on('message',raw=>received.push(JSON.parse(raw.toString())));
 await once(client,'open');await waitFor(()=>sent.some(e=>e.type==='response.create'));await new Promise(resolve=>setTimeout(resolve,15));
 return{client,sent,received,points,journal,transcripts,currentChecks,get tools(){return tools;},point(extra={}){const c=captureClassroomToolState(current);assert(c.ok);const e={type:'interaction.point',eventId:randomUUID(),context:c.snapshot.context,objectId:'wings',...extra};client.send(JSON.stringify(e));return e;},provider(event:unknown){peer!.send(JSON.stringify(event));},speech(){peer!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'new-speech'}));},async changeTask(){current={...current,revision:current.revision+1,stepIndex:2};await refreshClassroom(id);},release(){release?.();},async close(){release?.();client.terminate();await owner.close();for(const s of vendor.clients)s.terminate();await new Promise<void>(r=>vendor.close(()=>r()));await new Promise<void>(r=>vendorHttp.close(()=>r()));await new Promise<void>(r=>app.close(()=>r()));}};
}
test('a reading pointer gesture reaches the teacher without becoming a transcript, answer or extra grading tool',async()=>{
 const f=await fixture();try{const before=f.sent.filter(e=>e.type==='response.create').length,e=f.point();await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));assert.equal(f.received.find(x=>x.type==='point.result')?.status,'accepted');await waitFor(()=>f.sent.filter(x=>x.type==='response.create').length===before+1);assert(f.sent.some(x=>x.type==='session.update'&&x.session?.instructions?.includes('wings')&&x.session.instructions.includes('pointer')));assert.equal(f.points.length,1);assert.deepEqual(f.transcripts,[]);assert.equal(f.tools,0);assert(!f.received.some(x=>x.type==='error'));}finally{await f.close();}
});
test('unknown textbook objects are refused without breaking a live voice connection',async()=>{
 const f=await fixture();try{const e=f.point({objectId:'outside-object'});await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));assert.equal(f.received.find(x=>x.type==='point.result')?.status,'unavailable');assert.equal(f.points.length,0);assert.equal(f.client.readyState,WebSocket.OPEN);assert(!f.received.some(x=>x.type==='error'));}finally{await f.close();}
});
test('new speech while pointer persistence is pending cancels its delayed teaching cue',async()=>{
 const f=await fixture(true);try{const before=f.sent.filter(e=>e.type==='response.create').length,e=f.point();await waitFor(()=>f.points.length===1);f.speech();await new Promise(r=>setTimeout(r,15));f.release();await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));assert.equal(f.received.find(x=>x.type==='point.result')?.status,'unavailable');assert.equal(f.sent.filter(x=>x.type==='response.create').length,before);assert.equal(f.tools,0);}finally{await f.close();}
});

test('an expired point cannot persist later after its timeout was reported',async()=>{
 const f=await fixture(true,40);try{const e=f.point();await waitFor(()=>f.points.length===1);await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));assert.equal(f.received.find(x=>x.type==='point.result')?.status,'unavailable');f.release();await waitFor(()=>f.currentChecks.length===1);assert.deepEqual(f.currentChecks,[false]);assert.equal(f.sent.filter(x=>x.type==='response.create').length,1);}finally{await f.close();}
});

test('Grok can respond to a verified pointer reference without an image or cross-provider request',async()=>{
 const f=await fixture(false,5000,'grok');try{const count=f.sent.filter(e=>e.type==='response.create').length,e=f.point();await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));assert.equal(f.received.find(x=>x.type==='point.result')?.status,'accepted');await waitFor(()=>f.sent.filter(x=>x.type==='response.create').length===count+1);assert(f.sent.some(x=>x.type==='session.update'&&x.session?.instructions?.includes('wings')));assert.equal(f.tools,0);assert.deepEqual(f.transcripts,[]);assert(!f.received.some(x=>x.type==='error'));}finally{await f.close();}
});

test('an unfinished native speech item before the point stays historical instead of scoring after the point',async()=>{
 const f=await fixture();try{f.provider({type:'input_audio_buffer.speech_started',item_id:'old-unfinished'});await new Promise(r=>setTimeout(r,15));const e=f.point();await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));f.provider({type:'conversation.item.input_audio_transcription.completed',item_id:'old-unfinished',transcript:'It can fly.'});await new Promise(r=>setTimeout(r,30));assert.deepEqual(f.transcripts,[]);assert.equal(f.tools,0);assert.equal(f.received.find(x=>x.type==='point.result')?.status,'accepted');}finally{await f.close();}
});

test('a failed old native item cannot withdraw the new point while its persistence is pending',async()=>{
 const f=await fixture(true);try{f.provider({type:'input_audio_buffer.speech_started',item_id:'old-failed'});await new Promise(r=>setTimeout(r,10));const e=f.point();await waitFor(()=>f.points.length===1);f.provider({type:'conversation.item.input_audio_transcription.failed',item_id:'old-failed'});await new Promise(r=>setTimeout(r,10));f.release();await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));assert.equal(f.received.find(x=>x.type==='point.result')?.status,'accepted');assert.deepEqual(f.transcripts,[]);assert.equal(f.tools,0);}finally{await f.close();}
});

test('point trace records server rejection as a visible reason without relying on a successful point',async()=>{
 const f=await fixture();try{const e=f.point({objectId:'unknown'});await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));await waitFor(()=>f.journal.some(x=>x.details?.pointStage==='server_rejected'));const rows=f.journal.filter(x=>x.details?.pointId===e.eventId);assert(rows.some(x=>x.details?.pointStage==='server_received'));assert(rows.some(x=>x.details?.pointStage==='server_rejected'&&x.details?.pointReason==='invalid_request'));assert.equal(f.points.length,0);assert(!f.received.some(x=>x.type==='error'));}finally{await f.close();}
});

test('point trace distinguishes teacher queue, real request and start from media delivery',async()=>{
 const f=await fixture();try{const e=f.point();await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));await waitFor(()=>f.journal.some(x=>x.details?.pointStage==='reply_started'));const stages=f.journal.filter(x=>x.details?.pointId===e.eventId).map(x=>x.details?.pointStage);for(const stage of ['server_received','accepted','reply_queued','reply_requested','reply_started'] as const)assert(stages.includes(stage));assert(!stages.includes('audio_sent'));assert(!stages.includes('playback_started'));}finally{await f.close();}
});

test('same-task revision competition is revalidated once and produces one teacher reply for the original point',async()=>{
 const f=await fixture(false,5000,'qwen',true);try{const before=f.sent.filter(e=>e.type==='response.create').length,e=f.point();await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));assert.equal(f.received.find(x=>x.type==='point.result')?.status,'accepted');await waitFor(()=>f.sent.filter(x=>x.type==='response.create').length===before+1);assert.equal(f.points.length,2);assert.equal(f.points[0].eventId,e.eventId);assert.equal(f.points[1].eventId,e.eventId);assert.equal(f.points[1].context.stateRevision,f.points[0].context.stateRevision+1);assert.deepEqual(f.transcripts,[]);assert.equal(f.tools,0);assert(!f.received.some(x=>x.type==='error'));}finally{await f.close();}
});

test('pointer competition never follows a new task or retries revision conflicts more than once',async()=>{
 for(const race of ['task','repeat'] as const){const f=await fixture(false,5000,'qwen',race);try{const before=f.sent.filter(e=>e.type==='response.create').length,e=f.point();await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));assert.equal(f.received.find(x=>x.type==='point.result')?.status,'unavailable');assert.equal(f.points.length,race==='task'?1:2);assert.equal(f.sent.filter(x=>x.type==='response.create').length,before);assert(!f.received.some(x=>x.type==='error'));}finally{await f.close();}}
});

test('late pointer cancellation keeps the old task context instead of appearing on the new task',async()=>{
 const f=await fixture(true);try{const e=f.point(),scope=`${e.context.logicalSessionId}:${e.context.connectionEpoch}:1`;await waitFor(()=>f.points.length===1);await f.changeTask();f.release();await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));const rows=f.journal.filter(x=>x.details?.pointId===e.eventId);assert(rows.some(x=>x.details?.pointStage==='cancelled'));assert(rows.every(x=>x.details?.contextKey===scope));assert(!rows.some(x=>x.details?.pointStage==='reply_requested'));}finally{await f.close();}
});

test('pointer delivery and validated browser playback carry the same point and span IDs',async()=>{
 const f=await fixture(false,5000,'qwen',false,true);try{const e=f.point();await waitFor(()=>f.journal.some(x=>x.details?.pointId===e.eventId&&x.details?.pointStage==='audio_sent'));const audio=f.journal.find(x=>x.details?.pointId===e.eventId&&x.details?.pointStage==='audio_sent')!;assert(audio.details?.spanId&&audio.details.turnId);const wire={type:'diagnostic.playback',turnId:audio.details.turnId,spanId:audio.details.spanId,phase:'playback_started',elapsedMs:10,queueMs:50};f.client.send(JSON.stringify({...wire,turnId:randomUUID()}));await new Promise(r=>setTimeout(r,10));assert(!f.journal.some(x=>x.details?.pointStage==='playback_started'));f.client.send(JSON.stringify(wire));await waitFor(()=>f.journal.some(x=>x.details?.pointStage==='playback_started'));const played=f.journal.find(x=>x.details?.pointStage==='playback_started')!;assert.equal(played.details?.pointId,e.eventId);assert.equal(played.details?.spanId,audio.details.spanId);assert.equal(played.details?.turnId,audio.details.turnId);assert.equal(played.details?.source,'client');assert.equal(played.details?.clock,'client');}finally{await f.close();}
});

test('silent playback buffers are not reported as point reply audio playback',async()=>{
 const f=await fixture(false,5000,'qwen',false,'silent');try{const e=f.point();await waitFor(()=>f.received.some(x=>x.type==='point.result'&&x.eventId===e.eventId));await waitFor(()=>f.received.some(x=>x.type==='diagnostic.response'&&x.state==='started'));const span=f.received.findLast(x=>x.type==='diagnostic.response'&&x.state==='started')!;f.client.send(JSON.stringify({type:'diagnostic.playback',turnId:span.turnId,spanId:span.spanId,phase:'playback_started',elapsedMs:10,queueMs:50}));await new Promise(r=>setTimeout(r,15));const rows=f.journal.filter(x=>x.details?.pointId===e.eventId);assert(!rows.some(x=>x.details?.pointStage==='audio_sent'));assert(!rows.some(x=>x.details?.pointStage==='playback_started'));}finally{await f.close();}
});


test('new speech records cancellation for a point reply that has already started',async()=>{
 const f=await fixture(false,5000,'qwen',false,false,true);try{const e=f.point();await waitFor(()=>f.journal.some(x=>x.details?.pointId===e.eventId&&x.details?.pointStage==='reply_started'));f.speech();await waitFor(()=>f.journal.some(x=>x.details?.pointId===e.eventId&&x.details?.pointStage==='cancelled'));assert(f.journal.some(x=>x.details?.pointId===e.eventId&&x.details?.pointStage==='cancelled'&&x.details?.pointReason==='superseded'));}finally{await f.close();}
});

test('audible speech during the optional pointer guard drops only the autonomous cue',async()=>{
 const f=await fixture(false,5000,'qwen',false,false,false,500);
 const replyCount=()=>f.sent.filter(e=>e.type==='response.create').length;
 const pointCue='The learner made a pointer gesture';
 const before=replyCount();
 try{
  const point=f.point();
  await waitFor(()=>f.received.some(e=>e.type==='point.result'&&e.eventId===point.eventId&&e.status==='accepted'));
  assert.equal(replyCount(),before);
  await new Promise(resolve=>setTimeout(resolve,390));
  const pcm=Buffer.alloc(3200);
  for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(1800,i);
  f.client.send(JSON.stringify({type:'audio',audio:pcm.toString('base64')}));
  await waitFor(()=>f.sent.some(e=>e.type==='input_audio_buffer.append'));
  await waitFor(()=>f.journal.some(e=>e.details?.pointId===point.eventId&&e.details.pointStage==='cancelled'));
  assert.equal(replyCount(),before);
  assert(!f.sent.some(e=>e.type==='session.update'&&e.session?.instructions?.includes(pointCue)));
  const itemId='current-speech';
  f.provider({type:'input_audio_buffer.speech_started',item_id:itemId});
  f.provider({type:'input_audio_buffer.speech_stopped',item_id:itemId});
  f.provider({type:'conversation.item.input_audio_transcription.completed',item_id:itemId,transcript:'What did I point to?'});
  await waitFor(()=>f.transcripts.length===1);
  f.provider({type:'response.created',response:{id:'native-followup'}});
  await waitFor(()=>f.sent.some(e=>e.type==='response.cancel'));
  f.provider({type:'response.done',response:{id:'native-followup',status:'cancelled'}});
  await waitFor(()=>f.journal.some(e=>e.name==='point_recall_reply'&&e.details?.pointId===point.eventId));
  await waitFor(()=>replyCount()===before+1);
  assert.equal(f.client.readyState,WebSocket.OPEN);
  assert(!f.received.some(e=>e.type==='error'));
  const fresh=f.point();
  await waitFor(()=>f.received.some(e=>e.type==='point.result'&&e.eventId===fresh.eventId&&e.status==='accepted'));
  await waitFor(()=>f.journal.some(e=>e.details?.pointId===fresh.eventId&&e.details.pointStage==='reply_started'));
  assert.equal(replyCount(),before+2);
 }finally{await f.close();}
});


test('a guided spoken beat advances once, only after audible playback drains in this browser',async()=>{
 let completed=0,interruptions=0;
 const labGuide:NonNullable<VoiceLease['labGuide']>={
  active:()=>true,speechStarted:()=>{interruptions++;},speechCue:async()=>undefined,
  afterPlayback:async()=>{completed++;return completed===1?'Discuss the robot body now.':undefined;},
  pointCue:(_snapshot,id)=>`Discuss selection ${id}.`,
 };
 const f=await fixture(false,5000,'qwen',false,true,false,undefined,labGuide);
 try{
  const probe=()=>f.received.findLast(e=>e.type==='playback.probe')?.id;
  const acknowledge=(id:unknown,pending:boolean)=>f.client.send(JSON.stringify({type:'playback.state',probeId:id,playbackId:f.received.findLast(e=>e.type==='audio')?.playbackId,running:true,audiblePending:pending}));
  await waitFor(()=>!!probe());const first=probe();acknowledge(first,true);
  await waitFor(()=>probe()!==first);assert.equal(completed,0);
  const second=probe();acknowledge(second,false);acknowledge(second,false);
  await waitFor(()=>f.sent.some(e=>e.session?.instructions?.includes('Discuss the robot body now.')));
  assert.equal(completed,1);
  await waitFor(()=>probe()!==second);const interrupted=probe();f.speech();await waitFor(()=>interruptions===1);
  acknowledge(interrupted,false);await new Promise(resolve=>setTimeout(resolve,40));assert.equal(completed,1);
  const point=f.point({objectId:'tail'});await waitFor(()=>f.received.some(e=>e.eventId===point.eventId&&e.status==='accepted'));
  await waitFor(()=>f.sent.some(e=>e.session?.instructions?.includes('Discuss selection tail.')));
 }finally{await f.close();}
});

test('guided barge-in suppresses speculative native audio while the learner’s current question gets a page acknowledgement',async()=>{
 let heard:string|undefined,continueAnswer:(()=>void)|undefined;
 const labGuide:NonNullable<VoiceLease['labGuide']>={
  active:()=>true,speechStarted:()=>{},pointCue:()=>undefined,afterPlayback:async()=>undefined,
  speechCue:async(_snapshot,text)=>{heard=text;await new Promise<void>(resolve=>{continueAnswer=resolve;});return 'Explain the displayed clue, then pause.';},
 };
 const f=await fixture(false,5000,'qwen',false,false,false,undefined,labGuide);
 try{
  const itemId='side-question',question='What does clue mean?',native='native-auto';
  f.provider({type:'input_audio_buffer.speech_started',item_id:itemId});
  f.provider({type:'input_audio_buffer.speech_stopped',item_id:itemId});
  f.provider({type:'response.created',response:{id:native}});
  const pcm=Buffer.alloc(2400);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(2200,i);
  f.provider({type:'response.audio.delta',response_id:native,delta:pcm.toString('base64')});
  f.provider({type:'conversation.item.input_audio_transcription.completed',item_id:itemId,transcript:question});
  await waitFor(()=>heard===question&&f.sent.some(e=>e.type==='response.cancel'));
  f.provider({type:'response.done',response:{id:native,status:'cancelled'}});
  await new Promise(resolve=>setTimeout(resolve,60));
  assert(!f.received.some(e=>e.type==='audio'));
  assert.equal(f.sent.filter(e=>e.type==='response.create').length,1);
  continueAnswer!();
  await waitFor(()=>f.sent.some(e=>e.session?.instructions?.includes('Explain the displayed clue')));
  await waitFor(()=>f.sent.filter(e=>e.type==='response.create').length===2);
  assert(!f.received.some(e=>e.type==='error'));
 }finally{continueAnswer?.();await f.close();}
});
