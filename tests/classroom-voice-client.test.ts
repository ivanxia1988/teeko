import assert from 'node:assert/strict';
import test from 'node:test';
import { ClassroomVoiceClient, type ClassroomVoiceClientDependencies } from '../lib/classroom-voice-client';
import type { ClassroomSnapshot } from '../lib/classroom-contract';
import type { PcmVoiceAudioOptions } from '../lib/voice-audio';
import {teacherSnapshot} from './teacher-runtime-fixture';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import type {ClassroomPointObservation} from '../lib/classroom-point-diagnostics-client';
import type {AudioContinuityStats} from '../lib/classroom-audio-diagnostics';

function harness(classroomId='classroom-1') {
  const pointObservations:ClassroomPointObservation[]=[];
  let now=0;const latencyTags:(string|undefined)[]=[];const playedTags:(string|undefined)[]=[];const chalk:(import('../lib/domain/classroom-chalk').ClassroomChalkWriting|null)[]=[];const connections:import('../lib/classroom-connection').ClassroomConnectionUpdate[]=[];
  const sent: Record<string, unknown>[] = [], states: string[] = [], snapshots: ClassroomSnapshot[] = [], errors: string[] = [], failures: unknown[] = [], queues: number[] = [], order: string[] = [], vision:import('../lib/classroom-vision').ClassroomVisionState[]=[];
  let frameCallback:((image:string)=>void)|undefined,framesStarted=0,framesStopped=0;
  let tracksStopped = 0, audioClosed = 0, captures = 0, playback = 0, interrupted = 0, audioOptions: PcmVoiceAudioOptions | undefined;
  let pendingAudioStats:AudioContinuityStats|undefined;
  const track = { enabled: true, stop() { tracksStopped++; } };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  class Socket {
    readyState = 1; bufferedAmount = 0;
    onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null;
    send(data: string) { sent.push(JSON.parse(data)); if (JSON.parse(data).type === 'close') queueMicrotask(() => this.close()); }
    close() { this.readyState = 3; this.onclose?.(); }
    emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
  }
  const socket = new Socket(); let microphone: (() => Promise<MediaStream>) = async () => { order.push('microphone'); return stream; };
  const dependencies: ClassroomVoiceClientDependencies = {
    media: () => microphone(),
    socket: url => { assert.equal(url, `ws://127.0.0.1:8080/ws/classrooms/${classroomId}`); order.push('socket'); return socket as unknown as WebSocket; },
    origin: () => 'http://127.0.0.1:8080',
    audio: options => { audioOptions = options; order.push('audio-gesture'); return { startCapture: async () => { captures++; }, playChunk: (_audio,_rate,tag,latencyTag) => { playback++;playedTags.push(tag);latencyTags.push(latencyTag); }, cancelPlayback: () => { interrupted++; }, flushAudioDiagnostics:()=>{const stats=pendingAudioStats;pendingAudioStats=undefined;if(stats)options.onAudioDiagnostics?.(stats);}, mute() {}, resume: async () => {}, close: () => { audioClosed++; } }; },
    startupMs: 200, closeMs: 10, now:()=>now,chalkNow:()=>1000000+now,pointDiagnostics:event=>{pointObservations.push(structuredClone(event));},
    frames:()=>({start:(_stream,onFrame)=>{framesStarted++;frameCallback=onFrame;},stop:()=>{framesStopped++;}}),
  };
  const client = new ClassroomVoiceClient({ classroomId, provider: 'qwen', onState: state => states.push(state), onSnapshot: snapshot => snapshots.push(snapshot), onLevel() {}, onError: error => errors.push(error), onFailure: failure => failures.push(failure), onPlaybackQueue: ms => queues.push(ms),onVisionState:value=>vision.push(value),onConnectionQuality:value=>connections.push(value),onChalk:value=>chalk.push(value) }, dependencies);
  return { client, socket, pointObservations,playedTags,latencyTags,sent, states, snapshots, chalk, errors, failures, queues, order, track, dependencies,vision,connections,advance:(ms:number)=>{now+=ms;},frame:(image:string)=>frameCallback?.(image),queueAudioStats:(stats:AudioContinuityStats)=>{pendingAudioStats=stats;},get framesStarted(){return framesStarted;},get framesStopped(){return framesStopped;},setMicrophone: (media: () => Promise<MediaStream>) => { microphone = media; }, get options() { return audioOptions!; }, get tracksStopped() { return tracksStopped; }, get audioClosed() { return audioClosed; }, get captures() { return captures; }, get playback() { return playback; }, get interrupted() { return interrupted; }, stream };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const audioStats:AudioContinuityStats={boundary:'browser',windowMs:5000,chunkCount:100,audioMs:5000,audibleChunkCount:50,maxArrivalGapMs:90,playbackGapCount:1,playbackGapMs:40,maxPlaybackGapMs:40,minQueueMs:0,maxQueueMs:115,suspendedMs:0};
test('audio continuity reports bind to the sampled classroom context and flush before page changes or stop',async()=>{
 const snapshot=teacherSnapshot(),h=harness(snapshot.id),starting=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await starting;
 h.options.onAudioDiagnostics?.(audioStats);assert.equal(h.sent.filter(e=>e.type==='diagnostic.audio').length,0,'no snapshot means no claimed scope');
 h.socket.emit({type:'snapshot',classroom:snapshot});h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,playbackId:7});
 h.queueAudioStats(audioStats);h.socket.emit({type:'snapshot',classroom:{...snapshot,revision:2}});assert.equal(h.sent.filter(e=>e.type==='diagnostic.audio').length,0,'same task refresh does not flush');
 h.socket.emit({type:'snapshot',classroom:{...snapshot,revision:3,stepIndex:2}});
 const first=h.sent.find(e=>e.type==='diagnostic.audio');assert.deepEqual(first,{type:'diagnostic.audio',contextKey:`${snapshot.id}:1:1`,playbackId:7,sequence:1,audioStats});assert.equal(h.interrupted,0,'diagnostic scope reset must not clear audio');
 h.queueAudioStats(audioStats);await h.client.stop();const reports=h.sent.filter(e=>e.type==='diagnostic.audio');assert.equal(reports.length,2);assert.equal(reports[1].contextKey,`${snapshot.id}:1:2`);assert.equal(reports[1].sequence,2);h.options.onAudioDiagnostics?.(audioStats);assert.equal(h.sent.filter(e=>e.type==='diagnostic.audio').length,2);
});
test('audio continuity ignores malformed statistics, paused contexts and congested transport without stopping voice',async()=>{
 const snapshot=teacherSnapshot(),h=harness(snapshot.id),starting=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await starting;h.socket.emit({type:'snapshot',classroom:snapshot});
 for(const bad of [{...audioStats,audio:'PRIVATE_PCM'},{...audioStats,maxArrivalGapMs:-1},{...audioStats,boundary:'upstream'},{...audioStats,chunkCount:0}])h.options.onAudioDiagnostics?.(bad as AudioContinuityStats);
 assert.equal(h.sent.filter(e=>e.type==='diagnostic.audio').length,0);h.socket.bufferedAmount=64001;h.options.onAudioDiagnostics?.(audioStats);assert.equal(h.states.at(-1),'connected');h.socket.bufferedAmount=0;
 h.socket.emit({type:'snapshot',classroom:{...snapshot,revision:2,status:'paused'}});h.options.onAudioDiagnostics?.(audioStats);assert.equal(h.sent.filter(e=>e.type==='diagnostic.audio').length,0);h.client.dispose();
});
test('camera sharing is explicit, generation scoped and never claims understanding before server state',async()=>{
 const h=harness();assert.equal(h.client.startVision(h.stream),false);const pending=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await pending;
 assert.equal(h.framesStarted,0);assert.equal(h.client.startVision(h.stream),true);assert.equal(h.vision.at(-1)?.status,'starting');
 const generation=h.sent.find(event=>event.type==='vision.start')!.generation;h.frame('/9j/4A==');assert.equal(h.vision.at(-1)?.status,'starting');
 assert.deepEqual(h.sent.find(event=>event.type==='vision.frame'),{type:'vision.frame',generation,sequence:1,image:'/9j/4A=='});
 h.socket.emit({type:'vision.state',generation,status:'sharing'});assert.equal(h.vision.at(-1)?.status,'sharing');
 h.client.stopVision();h.frame('/9j/4A==');assert.equal(h.vision.at(-1)?.status,'off');h.socket.emit({type:'vision.state',generation,status:'sharing'});assert.equal(h.vision.at(-1)?.status,'off');
 h.client.startVision(h.stream);h.socket.emit({type:'vision.state',generation,status:'sharing'});assert.equal(h.vision.at(-1)?.status,'starting');await h.client.stop();assert.equal(h.vision.at(-1)?.status,'off');assert.equal(h.audioClosed,1);
});
test('visual backpressure and unsafe server error stop only images, preserving voice',async()=>{
 const h=harness(),pending=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await pending;
 h.client.startVision(h.stream);h.socket.bufferedAmount=9000;h.frame('/9j/4A==');assert(!h.sent.some(event=>event.type==='vision.frame'));assert.equal(h.audioClosed,0);assert.equal(h.states.at(-1),'connected');
 h.socket.bufferedAmount=0;h.client.stopVision();h.client.startVision(h.stream);const generation=h.sent.filter(event=>event.type==='vision.start').at(-1)!.generation;
 h.socket.emit({type:'vision.state',generation,status:'error',message:'PRIVATE_UPSTREAM_ERROR'});assert.equal(h.vision.at(-1)?.status,'error');assert(!JSON.stringify(h.vision).includes('PRIVATE'));assert.equal(h.client.sendText('still talking'),true);h.client.dispose();
});
test('missing visual acknowledgement times out without closing the voice connection',async t=>{
 const h=harness();t.mock.timers.enable({apis:['setTimeout','setInterval']});
 try{const pending=h.client.start();await Promise.resolve();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await pending;h.client.startVision(h.stream);t.mock.timers.tick(15000);assert.equal(h.vision.at(-1)?.status,'error');assert.equal(h.audioClosed,0);assert.equal(h.client.sendText('voice continues'),true);}finally{h.client.dispose();t.mock.timers.reset();}
});

test('microphone PCM starts only after server-ready and actual audio drives playback', async () => {
  const h = harness(), starting = h.client.start(); await tick();
  assert.deepEqual(h.order, ['audio-gesture', 'microphone', 'socket']); assert.equal(h.captures, 0);
  h.options.onFrame('AAAA'); assert.equal(h.sent.length, 0);
  h.socket.emit({ type: 'ready', inputSampleRate: 16000, outputSampleRate: 24000 }); await starting;
  assert.equal(h.captures, 1); assert.equal(h.states.at(-1), 'connected');
  h.options.onFrame('AAAA'); assert.equal(h.sent.at(-1)?.type, 'audio');
  h.socket.emit({ type: 'audio', audio: 'AAAA', sampleRate: 24000 }); assert.equal(h.playback, 1);
  h.socket.emit({ type: 'interrupt' }); assert.equal(h.interrupted, 1);
  await h.client.stop(); assert.equal(h.audioClosed, 1); assert.equal(h.tracksStopped, 1);
});

test('stop during a pending microphone request stops the late stream without connecting', async () => {
  const h = harness(); let resolve: ((stream: MediaStream) => void) | undefined;
  h.setMicrophone(() => new Promise<MediaStream>(done => { resolve = done; }));
  const starting = h.client.start(); await h.client.stop(); resolve!(h.stream); await starting;
  assert.equal(h.tracksStopped, 1); assert.equal(h.audioClosed, 1); assert(!h.order.includes('socket')); assert.equal(h.errors.length, 0);
});

test('denied microphone and startup timeout release local audio and never claim connected', async () => {
  const denied = harness(); denied.setMicrophone(async () => { throw new Error('permission denied'); });
  await assert.rejects(denied.client.start()); assert.equal(denied.audioClosed, 1); assert(!denied.states.includes('connected'));
  const h = harness(); const starting = h.client.start(); await assert.rejects(starting); assert.equal(h.tracksStopped, 1); assert.equal(h.audioClosed, 1); assert(!h.states.includes('connected'));
});

test('wrong-rate ready and backpressure fail rather than playing or buffering unbounded audio', async () => {
  const wrong = harness(); const starting = wrong.client.start(); await tick(); wrong.socket.emit({ type: 'ready', inputSampleRate: 24000, outputSampleRate: 24000 }); await assert.rejects(starting); assert.equal(wrong.captures, 0);
  const h = harness(), ready = h.client.start(); await tick(); h.socket.emit({ type: 'ready', inputSampleRate: 16000, outputSampleRate: 24000 }); await ready;
  h.socket.bufferedAmount = 300000; h.options.onFrame('AAAA'); assert.equal(h.states.at(-1), 'error'); assert.equal(h.tracksStopped, 1);
});

test('same-class server snapshots apply; late events after stop cannot restart playback', async () => {
  const h = harness(), ready = h.client.start(); await tick(); h.socket.emit({ type: 'ready', inputSampleRate: 16000, outputSampleRate: 24000 }); await ready;
  h.socket.emit({ type: 'snapshot', classroom: { id: 'classroom-1', revision: 2 } });
  h.socket.emit({ type: 'snapshot', classroom: { id: 'another', revision: 3 } }); assert.equal(h.snapshots.length, 1);
  h.client.setMuted(true); assert.equal(h.track.enabled, false);
  await h.client.stop(); h.socket.emit({ type: 'audio', audio: 'AAAA', sampleRate: 24000 }); assert.equal(h.playback, 0);
  assert.equal(h.client.sendText('late'), false);
});

test('server failure codes reach the UI safely and cannot expose arbitrary upstream text', async () => {
  const h = harness(), starting = h.client.start(); await tick(); h.socket.emit({ type: 'ready', inputSampleRate: 16000, outputSampleRate: 24000 }); await starting;
  h.socket.emit({ type: 'error', code: 'response_timeout', message: 'PRIVATE_UPSTREAM_DETAIL' });
  assert.equal(h.states.at(-1), 'error'); assert.equal((h.failures[0] as { code: string }).code, 'response_timeout');
  assert(!JSON.stringify(h.failures).includes('PRIVATE_UPSTREAM_DETAIL')); assert(!JSON.stringify(h.errors).includes('PRIVATE_UPSTREAM_DETAIL'));
  assert.equal(h.audioClosed, 1); assert.equal(h.tracksStopped, 1);
});

test('actual playback queue is forwarded and is reset on release without claiming a network packet was speech', async () => {
  const h = harness(), starting = h.client.start(); await tick(); h.socket.emit({ type: 'ready', inputSampleRate: 16000, outputSampleRate: 24000 }); await starting;
  h.socket.emit({ type: 'audio', audio: 'AAAA', sampleRate: 24000 }); assert.deepEqual(h.queues, []);
  h.options.onQueue?.(230); assert.equal(h.queues.at(-1), 230);
  await h.client.stop(); assert.equal(h.queues.at(-1), 0);
  h.options.onQueue?.(500); assert.equal(h.queues.at(-1), 0);
});


test('browser connection quality uses matching ping RTT and teacher measurements remain a separate link',async()=>{
 const h=harness(),starting=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await starting;
 const ping=h.sent.find(event=>event.type==='ping');assert(ping&&typeof ping.nonce==='string');
 h.advance(480);h.socket.emit({type:'pong',nonce:'stale'});assert.equal(h.connections.filter(item=>item.link==='device').at(-1)?.quality.status,'checking');
 h.socket.emit({type:'pong',nonce:ping.nonce});assert.deepEqual(h.connections.at(-1),{link:'device',quality:{status:'fair',rttMs:480}});
 h.socket.emit({type:'connection.quality',link:'teacher',quality:{status:'good',rttMs:30}});assert.deepEqual(h.connections.at(-1),{link:'teacher',quality:{status:'good',rttMs:30}});
 const before=h.connections.length;h.socket.emit({type:'connection.quality',link:'device',quality:{status:'good',rttMs:1}});h.socket.emit({type:'connection.quality',link:'teacher',quality:{status:'good',rttMs:-4}});assert.equal(h.connections.length,before);
 h.client.dispose();assert.deepEqual(h.connections.slice(-2),[{link:'device',quality:{status:'unavailable',rttMs:null}},{link:'teacher',quality:{status:'unavailable',rttMs:null}}]);
 h.socket.emit({type:'connection.quality',link:'teacher',quality:{status:'good',rttMs:1}});assert.equal(h.connections.at(-1)?.quality.status,'unavailable');
});
test('connection probe timeout reports poor without stopping voice and disposal clears probe timers',async t=>{
 const h=harness();t.mock.timers.enable({apis:['setTimeout','setInterval']});
 try{
  const starting=h.client.start();await Promise.resolve();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await starting;
  h.advance(8000);t.mock.timers.tick(8000);assert.deepEqual(h.connections.filter(item=>item.link==='device').at(-1)?.quality,{status:'poor',rttMs:null});
  assert.equal(h.states.at(-1),'connected');assert.equal(h.client.sendText('still talking'),true);
  h.client.dispose();const count=h.sent.length;t.mock.timers.tick(20000);assert.equal(h.sent.length,count);
 }finally{h.client.dispose();t.mock.timers.reset();}
});


test('camera frames tolerate a small audio backlog while keeping a separate bounded image budget',async()=>{
 const h=harness(),pending=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await pending;
 h.client.startVision(h.stream);h.socket.bufferedAmount=1024;h.frame('/9j/4A==');assert(h.sent.some(event=>event.type==='vision.frame'));h.client.dispose();
});
test('textbook frames have an independent generation, context and camera lifecycle',async()=>{
 const h=harness(),input={contextKey:'class:epoch:revision:page',image:'/9j/4A=='};
 assert.equal(h.client.sendBoard(input),false);const pending=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await pending;
 assert.equal(h.client.sendBoard(input),true);assert.equal(h.framesStarted,0);
 assert(h.sent.some(event=>event.type==='board.start'&&event.contextKey===input.contextKey));assert(h.sent.some(event=>event.type==='board.frame'&&event.image===input.image));
 h.client.stopVision();h.advance(3000);assert.equal(h.client.sendBoard(input),true);
 h.socket.bufferedAmount=9000;h.advance(3000);assert.equal(h.client.sendBoard(input),false);
 h.client.dispose();assert.equal(h.client.sendBoard(input),false);
});


test('annotation metadata is sent only on a live client and never serializes unknown media fields',async()=>{
 const h=harness();const input={contextKey:'classroom-1:1:0',action:'draw' as const,strokeCount:1,pointCount:12};
 assert.equal(h.client.sendInteraction(input),false);const pending=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await pending;
 assert.equal(h.client.sendInteraction({...input,image:'PRIVATE_IMAGE'} as typeof input),true);const event=h.sent.find(e=>e.type==='interaction')!;assert.equal(event.action,'draw');assert.equal(event.pointCount,12);assert.equal(event.image,undefined);assert.match(String(event.eventId),/^[0-9a-f-]{36}$/);
 assert.equal(h.client.sendInteraction({...input,pointCount:601}),false);assert.equal(h.client.sendInteraction({...input,strokeCount:-1}),false);await h.client.stop();assert.equal(h.client.sendInteraction(input),false);
});

const pointSnapshot=()=>teacherSnapshot({id:'classroom-1',stepIndex:1});
const pointInput=(snapshot:ClassroomSnapshot)=>({contextKey:`${snapshot.id}:${snapshot.connectionEpoch}:${snapshot.stepIndex}`,objectId:snapshot.course.pages.find(page=>page.id===snapshot.course.steps[snapshot.stepIndex].pageId)!.objects[0].id});
async function pointReady(h:ReturnType<typeof harness>,snapshot=pointSnapshot()){
 const pending=h.client.start();await Promise.resolve();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await pending;h.socket.emit({type:'snapshot',classroom:snapshot});
}
test('point sends only a current known non-select object with full server snapshot context and one pending ID',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const snapshot=pointSnapshot(),input=pointInput(snapshot);
 assert.equal(h.client.sendPoint(input),false);const pending=h.client.start();await Promise.resolve();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await pending;
 assert.equal(h.client.sendPoint(input),false);h.socket.emit({type:'snapshot',classroom:snapshot});
 const before=h.sent.length;assert(h.client.sendPoint({...input,text:'Do not forge speech.',image:'PRIVATE_IMAGE'} as typeof input));
 const point=h.sent.at(-1)!;assert.deepEqual(Object.keys(point).sort(),['context','eventId','objectId','type']);assert.equal(point.type,'interaction.point');assert.equal(point.objectId,input.objectId);assert.match(String(point.eventId),/^[0-9a-f-]{36}$/);
 const captured=captureClassroomToolState(snapshot);assert(captured.ok);assert.deepEqual(point.context,captured.snapshot.context);assert.equal(h.sent.length,before+1);assert.equal(h.client.sendPoint(input),false);assert.equal(h.playback,0);
 h.socket.emit({type:'snapshot',classroom:{...snapshot,revision:2}});assert.equal(h.client.sendPoint(input),false,'The point remains pending across a same-activity revision.');h.socket.emit({type:'point.result',eventId:point.eventId,status:'accepted'});
 assert(h.client.sendPoint(input),'A same-activity revision update before the acknowledgement must preserve the pending point.');assert.notEqual(h.sent.at(-1)?.eventId,point.eventId);assert.equal(h.playback,0);assert.deepEqual(h.errors,[]);
});
test('point refuses foreign objects, contexts, paused or ended snapshots and select answers without changing media',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const snapshot=pointSnapshot(),input=pointInput(snapshot);await pointReady(h,snapshot);
 for(const candidate of [{...input,contextKey:'another:1:1'},{...input,objectId:'not-on-this-page'},{...input,objectId:'x'.repeat(129)},{...input,objectId:''}])assert.equal(h.client.sendPoint(candidate),false);
 let revision=2;for(const status of ['preflight','paused','ended']as const){h.socket.emit({type:'snapshot',classroom:{...snapshot,status,revision:revision++}});assert.equal(h.client.sendPoint(input),false);}
 const selected={...snapshot,revision:revision++,stepIndex:snapshot.course.steps.findIndex(step=>step.kind==='select')};assert(selected.stepIndex>=0);h.socket.emit({type:'snapshot',classroom:selected});assert.equal(h.client.sendPoint(pointInput(selected)),false);
 const foreignPage={...snapshot.course.pages[0],id:'foreign-page',objects:[{...snapshot.course.pages[0].objects[0],id:'foreign-object'}]};
 h.socket.emit({type:'snapshot',classroom:{...snapshot,revision:revision++,course:{...snapshot.course,pages:[...snapshot.course.pages,foreignPage]}}});assert.equal(h.client.sendPoint({...input,objectId:'foreign-object'}),false);
 assert(!h.sent.some(event=>event.type==='interaction.point'));assert.equal(h.audioClosed,0);assert.equal(h.states.at(-1),'connected');
});
test('point results accept only this pending ID and fixed status, with unavailable affecting only the point',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const snapshot=pointSnapshot();await pointReady(h,snapshot);assert(h.client.sendPoint(pointInput(snapshot)));const point=h.sent.at(-1)!;
 for(const result of [{type:'point.result',eventId:'00000000-0000-4000-8000-000000000001',status:'unavailable'},{type:'point.result',eventId:point.eventId,status:'failed'},{type:'point.result',eventId:point.eventId,status:'unavailable',message:'PRIVATE_PROVIDER_BODY'}])h.socket.emit(result);
 assert.deepEqual(h.errors,[]);assert.equal(h.client.sendPoint(pointInput(snapshot)),false);
 h.socket.emit({type:'point.result',eventId:point.eventId,status:'unavailable'});assert.deepEqual(h.errors,['刚才的点选没有送达，请再点一次。']);
 h.socket.emit({type:'point.result',eventId:point.eventId,status:'unavailable'});assert.equal(h.errors.length,1);assert.equal(h.audioClosed,0);assert.deepEqual(h.failures,[]);assert.equal(h.states.at(-1),'connected');assert(h.client.sendText('Still talking.'));assert(h.client.sendPoint(pointInput(snapshot)));
});
test('changed point activity, page, course, epoch or status discards old acknowledgements without poisoning the next point',async()=>{
 for(const mode of ['activity','page','course','epoch','pause','ended','invalid']as const){const h=harness();try{
  const snapshot=pointSnapshot();await pointReady(h,snapshot);assert(h.client.sendPoint(pointInput(snapshot)));const old=h.sent.at(-1)!;
  let next={...snapshot,revision:2};
  if(mode==='activity')next={...next,stepIndex:snapshot.course.steps.findIndex((step,index)=>index!==snapshot.stepIndex&&step.kind!=='select')};
  if(mode==='page'){const pageId='point-other-page';next={...next,course:{...snapshot.course,pages:[...snapshot.course.pages,{...snapshot.course.pages[0],id:pageId}],steps:snapshot.course.steps.map((step,index)=>index===snapshot.stepIndex?{...step,pageId}:step)}};}
  if(mode==='course')next={...next,course:{...snapshot.course,version:'new-point-version'}};
  if(mode==='epoch')next={...next,connectionEpoch:2};if(mode==='pause')next={...next,status:'paused'};if(mode==='ended')next={...next,status:'ended'};if(mode==='invalid')next={...next,stepIndex:999};
  h.socket.emit({type:'snapshot',classroom:next});h.socket.emit({type:'point.result',eventId:old.eventId,status:'unavailable'});assert.deepEqual(h.errors,[],mode);
  const resumed={...snapshot,revision:3};h.socket.emit({type:'snapshot',classroom:resumed});assert(h.client.sendPoint(pointInput(resumed)),mode);const current=h.sent.at(-1)!;
  h.socket.emit({type:'point.result',eventId:old.eventId,status:'unavailable'});assert.deepEqual(h.errors,[],mode);assert.equal(h.client.sendPoint(pointInput(resumed)),false);
  h.socket.emit({type:'point.result',eventId:current.eventId,status:'accepted'});assert(h.client.sendPoint(pointInput(resumed)),mode);
 }finally{h.client.dispose();}}
});
test('point timeout explains the undelivered gesture once and disposal cancels its pending timer',async t=>{
 const h=harness();t.mock.timers.enable({apis:['setTimeout','setInterval']});
 try{const snapshot=pointSnapshot();await pointReady(h,snapshot);assert(h.client.sendPoint(pointInput(snapshot)));const old=h.sent.at(-1)!;h.advance(10000);t.mock.timers.tick(10000);
  assert.deepEqual(h.errors,['刚才的点选没有送达，请再点一次。']);assert.equal(h.audioClosed,0);assert.equal(h.states.at(-1),'connected');h.socket.emit({type:'point.result',eventId:old.eventId,status:'unavailable'});assert.equal(h.errors.length,1);
  assert(h.client.sendPoint(pointInput(snapshot)));const current=h.sent.at(-1)!;h.client.dispose();h.socket.emit({type:'point.result',eventId:current.eventId,status:'unavailable'});t.mock.timers.tick(20000);assert.equal(h.errors.length,1);assert.equal(h.client.sendPoint(pointInput(snapshot)),false);
 }finally{h.client.dispose();t.mock.timers.reset();}
});
test('point send failure keeps media connected and does not leave a pending request behind',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const snapshot=pointSnapshot();await pointReady(h,snapshot);h.socket.bufferedAmount=65000;assert.equal(h.client.sendPoint(pointInput(snapshot)),false);h.socket.bufferedAmount=0;
 assert(h.client.sendPoint(pointInput(snapshot)));assert.equal(h.audioClosed,0);assert.equal(h.states.at(-1),'connected');assert.deepEqual(h.failures,[]);
});
test('point diagnostics preserve the UI ID through local refusal, wire send and explicit server rejection',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const snapshot=pointSnapshot(),input=pointInput(snapshot),pointId='20000000-0000-4000-8000-000000000009';
 assert.equal(h.client.sendPoint(input,pointId),false);assert.equal(h.pointObservations.at(-1)?.reason,'not_ready');
 await pointReady(h,snapshot);assert.deepEqual(h.sent.filter(event=>event.type==='client.capabilities'),[{type:'client.capabilities',diagnosticsVersion:1,pointVersion:1}]);
 assert(h.client.sendPoint(input,pointId));assert.equal(h.sent.at(-1)?.eventId,pointId);assert.equal(h.pointObservations.at(-1)?.stage,'sent');assert.equal(h.pointObservations.at(-1)?.pointId,pointId);
 const captured=captureClassroomToolState(snapshot);assert(captured.ok);assert.deepEqual(h.pointObservations.at(-1)?.context,captured.snapshot.context);
 assert.equal(h.client.sendPoint(input),false);assert.equal(h.pointObservations.at(-1)?.reason,'busy');
 h.socket.emit({type:'point.result',eventId:pointId,status:'unavailable',reason:'stale_context'});assert.equal(h.pointObservations.at(-1)?.stage,'unavailable');assert.equal(h.pointObservations.at(-1)?.reason,'stale_context');
 h.socket.bufferedAmount=65000;assert.equal(h.client.sendPoint(input),false);assert.equal(h.pointObservations.at(-1)?.reason,'send_backpressure');assert.equal(h.states.at(-1),'connected');
});
test('point timeout and superseding snapshots remain diagnosable after the voice path stops owning the point',async t=>{
 const h=harness();t.mock.timers.enable({apis:['setTimeout','setInterval']});
 try{
  const snapshot=pointSnapshot();await pointReady(h,snapshot);assert(h.client.sendPoint(pointInput(snapshot)));t.mock.timers.tick(10000);
  assert.equal(h.pointObservations.at(-1)?.stage,'timeout');assert.equal(h.pointObservations.at(-1)?.reason,'ack_timeout');
  assert(h.client.sendPoint(pointInput(snapshot)));h.socket.emit({type:'snapshot',classroom:{...snapshot,revision:2,connectionEpoch:snapshot.connectionEpoch+1}});
  assert.equal(h.pointObservations.at(-1)?.stage,'unavailable');assert.equal(h.pointObservations.at(-1)?.reason,'superseded');assert.equal(h.audioClosed,0);
 }finally{h.client.dispose();t.mock.timers.reset();}
});
test('a finite server recovery shows waiting, refuses point gestures with a reason, and preserves the existing media',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const snapshot=pointSnapshot();await pointReady(h,snapshot);
 h.socket.emit({type:'voice.recovery',state:'checking'});assert.equal(h.errors.at(-1),'语音连接正在恢复，请稍等片刻，再继续说话。');
 assert.equal(h.client.sendPoint(pointInput(snapshot)),false);assert.equal(h.pointObservations.at(-1)?.reason,'busy');assert.equal(h.states.at(-1),'connected');
 const captures=h.captures;h.options.onFrame('AAAA');assert.equal(h.sent.at(-1)?.type,'audio');assert.equal(h.audioClosed,0);assert.equal(h.captures,captures);
 h.socket.emit({type:'voice.recovery',state:'recovered'});assert.equal(h.errors.at(-1),'');assert(h.client.sendPoint(pointInput(snapshot)));assert.equal(h.captures,captures);assert.equal(h.states.at(-1),'connected');
});
test('recovery completion clears only its own notice and keeps a later point failure visible',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const snapshot=pointSnapshot();await pointReady(h,snapshot);assert(h.client.sendPoint(pointInput(snapshot)));const id=h.sent.at(-1)?.eventId;
 h.socket.emit({type:'voice.recovery',state:'checking'});assert.equal(h.errors.at(-1),'语音连接正在恢复，请稍等片刻，再继续说话。');h.socket.emit({type:'point.result',eventId:id,status:'unavailable',reason:'server_rejected'});
 const last=h.errors.at(-1);assert.equal(last,'刚才的点选没有送达，请再点一次。');h.socket.emit({type:'voice.recovery',state:'recovered'});assert.equal(h.errors.at(-1),last);
});
test('recovery notices ignore unready, malformed and stopped messages without accepting provider text',async()=>{
 const h=harness(),starting=h.client.start();await tick();h.socket.emit({type:'voice.recovery',state:'checking'});assert.deepEqual(h.errors,[]);
 h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await starting;
 for(const event of [{type:'voice.recovery',state:'broken'},{type:'voice.recovery',state:'checking',message:'PRIVATE_PROVIDER_BODY'},{type:'voice.recovery',state:'recovered'}])h.socket.emit(event);
 assert.deepEqual(h.errors,[]);h.client.dispose();h.socket.emit({type:'voice.recovery',state:'checking'});assert.deepEqual(h.errors,[]);
});
test('a new point gesture cancels an older voice latency wait without inventing a transcript or spoken response',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const snapshot=pointSnapshot();await pointReady(h,snapshot);const input=latencyInput(h);
 h.socket.emit({type:'diagnostic.latency',...latencyIds,...input,basis:'provider_turn',state:'bound'});h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,latencyMeasurementId:latencyIds.measurementId});const tag=h.latencyTags.at(-1);assert(tag);
 const count=h.sent.length;assert(h.client.sendPoint(pointInput(snapshot)));assert.equal(h.sent.length,count+1);assert.equal(h.sent.at(-1)?.type,'interaction.point');h.options.onAudiblePlayback?.({measurementId:tag,atMs:200});assert(!h.sent.some(event=>event.type==='diagnostic.latency'));assert.equal(h.playback,1);
});

test('playback probes wait for observed running and quiet WebAudio, then report the current output sequence once',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const start=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await start;
 h.socket.emit({type:'playback.probe',id:'probe-1'});assert.equal(h.sent.filter(e=>e.type==='playback.state').length,0);
 h.options.onPlaybackState?.({running:false,audiblePending:false});assert.equal(h.sent.filter(e=>e.type==='playback.state').length,0);
 h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,playbackId:2});h.options.onPlaybackState?.({running:true,audiblePending:true});
 assert.equal(h.sent.filter(e=>e.type==='playback.state').length,0);h.options.onPlaybackState?.({running:true,audiblePending:false});
 assert.deepEqual(h.sent.find(e=>e.type==='playback.state'),{type:'playback.state',probeId:'probe-1',playbackId:2,running:true,audiblePending:false});
 h.options.onPlaybackState?.({running:true,audiblePending:false});assert.equal(h.sent.filter(e=>e.type==='playback.state').length,1);h.client.dispose();
});
test('legacy or backwards audio cannot supply a current playback receipt, and close cancels pending probes',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const start=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await start;
 h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,playbackId:4});h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,playbackId:3});
 h.socket.emit({type:'playback.probe',id:'probe-stale'});h.options.onPlaybackState?.({running:true,audiblePending:false});assert(!h.sent.some(e=>e.type==='playback.state'));
 h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000});h.options.onPlaybackState?.({running:true,audiblePending:false});assert(!h.sent.some(e=>e.type==='playback.state'));
 h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,playbackId:5});h.client.dispose();h.options.onPlaybackState?.({running:true,audiblePending:false});assert(!h.sent.some(e=>e.type==='playback.state'));
});


test('chalk waits for a current snapshot and commit, and only the rendered view can acknowledge display',async()=>{
 const h=harness();try{
  const ready=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await ready;
  const {teacherSnapshot}=await import('./teacher-runtime-fixture');const {captureClassroomToolState}=await import('../lib/classroom-tool-state');
  const snapshot=teacherSnapshot({id:'classroom-1'}),scope=captureClassroomToolState(snapshot);assert(scope.ok);
  const id='00000001-0000-4000-8000-000000000001',offer={type:'chalk.offer',id,context:scope.snapshot.context,text:'I like apples.',displayMs:8000};
  h.socket.emit(offer);assert(!h.sent.some(value=>value.type==='chalk.ready'));
  h.socket.emit({type:'snapshot',classroom:snapshot});h.socket.emit(offer);assert.equal(h.sent.at(-1)?.type,'chalk.ready');assert.equal(h.chalk.length,0);
  h.advance(100);h.socket.emit({type:'chalk.commit',id,remainingMs:7900});assert.equal(h.chalk.at(-1)?.text,'I like apples.');assert(!h.sent.some(value=>value.type==='chalk.displayed'));
  assert.equal(h.client.chalkDisplayed(id),true);assert.equal(h.sent.at(-1)?.type,'chalk.displayed');assert.equal(h.client.chalkDisplayed(id),false);
  h.socket.emit({type:'snapshot',classroom:{...snapshot,status:'paused',revision:2}});assert.equal(h.chalk.at(-1),null);assert.equal(h.client.chalkDisplayed(id),false);assert.equal(h.client.sendText('voice still works'),true);
 }finally{h.client.dispose();}
});

 test('diagnostic reports use server IDs and local scheduled playback, bounded samples and final drain',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const start=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await start;
 const ids={turnId:'10000000-0000-4000-8000-000000000001',spanId:'20000000-0000-4000-8000-000000000001'};
 const metrics={tag:ids.spanId,running:true,playing:true,pending:true,queueMs:150};
 h.options.onPlaybackMetrics?.(metrics);assert.equal(h.sent.filter(e=>e.type==='diagnostic.playback').length,0);
 h.socket.emit({type:'diagnostic.response',...ids,state:'started'});h.options.onPlaybackMetrics?.({...metrics,playing:false});assert.equal(h.sent.filter(e=>e.type==='diagnostic.playback').length,0);
 h.advance(40);h.options.onPlaybackMetrics?.(metrics);assert.deepEqual(h.sent.at(-1),{type:'diagnostic.playback',...ids,phase:'playback_started',elapsedMs:40,queueMs:150});
 for(let i=0;i<100;i++)h.options.onPlaybackMetrics?.(metrics);assert.equal(h.sent.filter(e=>e.type==='diagnostic.playback').length,1);
 h.advance(1000);h.options.onPlaybackMetrics?.(metrics);assert.equal(h.sent.at(-1)?.phase,'playback_sample');
 h.options.onPlaybackMetrics?.({...metrics,playing:false,pending:false,queueMs:0});assert.notEqual(h.sent.at(-1)?.phase,'playback_finished');
 h.socket.emit({type:'diagnostic.response',...ids,state:'completed'});assert.equal(h.sent.at(-1)?.phase,'playback_finished');
 const count=h.sent.length;h.options.onPlaybackMetrics?.(metrics);assert.equal(h.sent.length,count);
 h.socket.emit({type:'interrupt'});h.options.onPlaybackMetrics?.(metrics);assert.equal(h.sent.length,count);h.client.dispose();
 });
 test('malformed diagnostic metadata and cancelled responses cannot claim playback',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const start=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await start;
 h.socket.emit({type:'diagnostic.response',turnId:'bad',spanId:'bad',state:'started'});h.options.onPlaybackMetrics?.({tag:'bad',running:true,playing:true,pending:true,queueMs:1});assert(!h.sent.some(e=>e.type==='diagnostic.playback'));
 const ids={turnId:'10000000-0000-4000-8000-000000000001',spanId:'20000000-0000-4000-8000-000000000001'};
 h.socket.emit({type:'diagnostic.response',...ids,state:'started'});h.socket.emit({type:'diagnostic.response',...ids,state:'cancelled'});h.options.onPlaybackMetrics?.({tag:ids.spanId,running:true,playing:true,pending:true,queueMs:1});assert(!h.sent.some(e=>e.type==='diagnostic.playback'));h.client.dispose();
 });

 test('each PCM frame uses its server-selected response span and mixed or unknown frames stay unbound',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const start=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await start;
 const ids={turnId:'10000000-0000-4000-8000-000000000001',spanId:'20000000-0000-4000-8000-000000000001'};h.socket.emit({type:'diagnostic.response',...ids,state:'started'});
 h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,diagnosticSpanId:ids.spanId});h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,diagnosticSpanId:null});h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,diagnosticSpanId:'30000000-0000-4000-8000-000000000001'});
 assert.deepEqual(h.playedTags,[ids.spanId,undefined,undefined]);
 });
test('an unbound PCM tail invalidates playback measurement without stopping audio or fabricating completion',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const start=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await start;
 const ids={turnId:'10000000-0000-4000-8000-000000000001',spanId:'20000000-0000-4000-8000-000000000001'};
 h.socket.emit({type:'diagnostic.response',...ids,state:'started'});h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,diagnosticSpanId:ids.spanId});
 h.options.onPlaybackMetrics?.({tag:ids.spanId,running:true,playing:true,pending:true,queueMs:50});
 h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,diagnosticSpanId:null});h.socket.emit({type:'diagnostic.response',...ids,state:'completed'});
 h.options.onPlaybackMetrics?.({tag:ids.spanId,running:true,playing:false,pending:false,queueMs:0});
 assert.deepEqual(h.sent.filter(event=>event.type==='diagnostic.playback').map(event=>event.phase),['playback_started']);assert.equal(h.playback,2);assert.equal(h.audioClosed,0);assert.equal(h.states.at(-1),'connected');assert(h.client.sendText('Voice still works.'));
});

const latencyIds={measurementId:'50000000-0000-4000-8000-000000000001',turnId:'60000000-0000-4000-8000-000000000001',spanId:'70000000-0000-4000-8000-000000000001'};
function latencyInput(h:ReturnType<typeof harness>){
 h.advance(100);h.options.onFrame('AAAA',{atMs:100,frameMs:100,level:.2});
 const audio=h.sent.filter(e=>e.type==='audio').at(-1)!;
 h.advance(100);h.options.onFrame('AAAA',{atMs:200,frameMs:100,level:0});
 return{inputId:audio.latencyInputId,lastVoiceSequence:audio.audioSequence};
}
test('recovery retires old playback measurements and discarded capture without stopping audio, then measures a fresh turn',async t=>{
 const h=harness();t.after(()=>h.client.dispose());await pointReady(h);const old=latencyInput(h);
 h.socket.emit({type:'diagnostic.latency',...latencyIds,...old,basis:'provider_turn',state:'bound'});
 h.socket.emit({type:'diagnostic.response',turnId:latencyIds.turnId,spanId:latencyIds.spanId,state:'started'});
 h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,diagnosticSpanId:latencyIds.spanId,latencyMeasurementId:latencyIds.measurementId});const oldTag=h.latencyTags.at(-1);assert(oldTag);
 const interrupts=h.interrupted,inputs=h.sent.filter(event=>event.type==='diagnostic.input').length;
 h.socket.emit({type:'voice.recovery',state:'checking'});
 h.options.onAudiblePlayback?.({measurementId:oldTag,atMs:200});h.options.onPlaybackMetrics?.({tag:latencyIds.spanId,running:true,playing:true,pending:true,queueMs:50});
 assert.equal(h.sent.filter(event=>event.type==='diagnostic.latency'||event.type==='diagnostic.playback').length,0);
 h.advance(100);h.options.onFrame('AAAA',{atMs:300,frameMs:100,level:.2});assert.equal(h.sent.at(-1)?.latencyInputId,undefined);
 h.advance(100);h.options.onFrame('AAAA',{atMs:400,frameMs:100,level:0});assert.equal(h.sent.filter(event=>event.type==='diagnostic.input').length,inputs);
 h.socket.emit({type:'voice.recovery',state:'recovered'});assert.equal(h.interrupted,interrupts);assert.equal(h.audioClosed,0);assert.equal(h.captures,1);
 h.advance(100);h.options.onFrame('AAAA',{atMs:500,frameMs:100,level:.2});const audio=h.sent.at(-1)!;
 h.advance(100);h.options.onFrame('AAAA',{atMs:600,frameMs:100,level:0});
 const input={inputId:audio.latencyInputId,lastVoiceSequence:audio.audioSequence};assert.notEqual(input.inputId,old.inputId);
 const next={...latencyIds,measurementId:'80000000-0000-4000-8000-000000000001'};
 h.socket.emit({type:'diagnostic.latency',...next,...input,basis:'provider_turn',state:'bound'});h.advance(100);
 h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,latencyMeasurementId:next.measurementId});const nextTag=h.latencyTags.at(-1);assert(nextTag);
 h.options.onAudiblePlayback?.({measurementId:nextTag,atMs:700});assert.equal(h.sent.at(-1)?.measurementId,next.measurementId);assert.equal(h.sent.at(-1)?.waitMs,200);assert.equal(h.playback,2);
});
test('native capture and approved voiced playback measure a complete local wait independently of metadata arrival',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const start=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await start;
 const input=latencyInput(h);assert.equal(typeof input.inputId,'string');assert.equal(input.lastVoiceSequence,0);
 assert.deepEqual(h.sent.find(e=>e.type==='diagnostic.input'),{type:'diagnostic.input',inputId:input.inputId,firstSequence:0,lastVoiceSequence:0,phase:'stopped',silenceMs:100});
 h.socket.emit({type:'interrupt'}); // Provider VAD may clear the previous playback before approving this input.
 h.advance(100);h.socket.emit({type:'diagnostic.latency',...latencyIds,...input,basis:'provider_turn',state:'bound'});
 h.advance(100);h.options.onFrame('AAAA',{atMs:400,frameMs:100,level:0});
 h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,latencyMeasurementId:latencyIds.measurementId});
 assert(h.latencyTags.at(-1)?.startsWith(latencyIds.measurementId));assert.equal(h.playedTags.at(-1),undefined);
 assert(!h.sent.some(e=>e.type==='diagnostic.latency'));
 h.advance(100);h.options.onAudiblePlayback?.({measurementId:h.latencyTags[0]??latencyIds.measurementId,atMs:480});
 assert.deepEqual(h.sent.at(-1),{type:'diagnostic.latency',measurementId:latencyIds.measurementId,phase:'playback_started',waitMs:380,captureGapMs:100,playbackMs:80});
 h.options.onAudiblePlayback?.({measurementId:h.latencyTags[0]??latencyIds.measurementId,atMs:490});assert.equal(h.sent.filter(e=>e.type==='diagnostic.latency').length,1);
});
test('latency cancellation, mute, input restart and unknown mixed audio cannot complete an old wait',async t=>{
 for(const mode of ['interrupt','mute','voice','mixed','unknown','cancelled','gap'] as const){
  const h=harness();t.after(()=>h.client.dispose());const start=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await start;
  const input=latencyInput(h);h.socket.emit({type:'diagnostic.latency',...latencyIds,...input,basis:'provider_turn',state:'bound'});h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,latencyMeasurementId:latencyIds.measurementId});
  if(mode==='interrupt')h.socket.emit({type:'interrupt'});if(mode==='mute')h.client.setMuted(true);
  if(mode==='voice'){h.advance(100);h.options.onFrame('AAAA',{atMs:300,frameMs:100,level:.2});}
  if(mode==='gap'){h.advance(600);h.options.onFrame('AAAA',{atMs:800,frameMs:100,level:0});}
  if(mode==='mixed'||mode==='unknown')h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,latencyMeasurementId:mode==='mixed'?null:'50000000-0000-4000-8000-000000000002'});
  if(mode==='cancelled')h.socket.emit({type:'diagnostic.latency',...latencyIds,...input,basis:'provider_turn',state:'cancelled'});
  h.advance(100);h.options.onAudiblePlayback?.({measurementId:h.latencyTags[0]??latencyIds.measurementId,atMs:mode==='gap'?850:300});
  assert(!h.sent.some(e=>e.type==='diagnostic.latency'),mode);assert.equal(h.states.at(-1),'connected');assert.equal(h.audioClosed,0);
 }
});
test('ordinary persisted revisions keep a latency wait but changing a classroom task discards it',async t=>{
 const {teacherSnapshot}=await import('./teacher-runtime-fixture');
 for(const changed of [false,true]){
  const h=harness();t.after(()=>h.client.dispose());const start=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await start;
  const snapshot=teacherSnapshot({id:'classroom-1'});h.socket.emit({type:'snapshot',classroom:snapshot});const input=latencyInput(h);
  h.socket.emit({type:'diagnostic.latency',...latencyIds,...input,basis:'application_window',state:'bound'});h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,latencyMeasurementId:latencyIds.measurementId});
  h.socket.emit({type:'snapshot',classroom:{...snapshot,revision:snapshot.revision+1,...(changed?{stepIndex:snapshot.stepIndex+1}:{})}});
  h.advance(100);h.options.onAudiblePlayback?.({measurementId:h.latencyTags[0]??latencyIds.measurementId,atMs:280});
  assert.equal(h.sent.filter(e=>e.type==='diagnostic.latency').length,changed?0:1);
 }
});
test('optional diagnostic send failures leave legacy PCM and the voice connection working',async t=>{
 const h=harness();t.after(()=>h.client.dispose());const start=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await start;
 const original=h.socket.send.bind(h.socket);h.socket.send=(value:string)=>{if(JSON.parse(value).type==='diagnostic.input')throw new Error('optional metadata delivery failed');original(value);};
 const input=latencyInput(h);h.socket.emit({type:'diagnostic.latency',...latencyIds,...input,basis:'provider_turn',state:'bound'});
 h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,latencyMeasurementId:latencyIds.measurementId});h.advance(100);h.options.onAudiblePlayback?.({measurementId:h.latencyTags[0]??latencyIds.measurementId,atMs:280});
 assert.equal(h.sent.filter(e=>e.type==='audio').length,2);assert(!h.sent.some(e=>e.type==='diagnostic.latency'));assert.equal(h.states.at(-1),'connected');assert.equal(h.audioClosed,0);
 h.options.onFrame('AAAA');assert.deepEqual(h.sent.at(-1),{type:'audio',audio:'AAAA'});
});

test('stopped capture candidates can migrate only after an explicit new binding for the advanced task',async t=>{
 const {teacherSnapshot}=await import('./teacher-runtime-fixture');
 for(const approved of [true,false]){
  const h=harness();t.after(()=>h.client.dispose());const start=h.client.start();await tick();h.socket.emit({type:'ready',inputSampleRate:16000,outputSampleRate:24000});await start;
  const snapshot=teacherSnapshot({id:'classroom-1'});h.socket.emit({type:'snapshot',classroom:snapshot});const input=latencyInput(h);
  h.socket.emit({type:'snapshot',classroom:{...snapshot,revision:snapshot.revision+1,stepIndex:snapshot.stepIndex+1}});
  if(approved)h.socket.emit({type:'diagnostic.latency',...latencyIds,...input,basis:'application_window',state:'bound'});
  h.socket.emit({type:'audio',audio:'AAAA',sampleRate:24000,latencyMeasurementId:latencyIds.measurementId});h.advance(100);h.options.onAudiblePlayback?.({measurementId:h.latencyTags[0]??latencyIds.measurementId,atMs:280});
  assert.equal(h.sent.filter(e=>e.type==='diagnostic.latency').length,approved?1:0);
 }
});
