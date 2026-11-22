import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {createHash} from 'node:crypto';
import {createOpenAIClassroomVision} from '../lib/server/classroom-vision-openai';
import WebSocket, { WebSocketServer } from 'ws';
import {configFromEnvironment, attachClassroomSockets, type VoiceLease, type ClassroomVoiceConfig } from '../lib/server/classroom-sockets';
import type { ClassroomSnapshot } from '../lib/classroom-contract';
import { refreshClassroom } from '../lib/server/classroom-events';
import type { PcmOutputClock } from '../lib/server/classroom-audio';
import type {ClassroomVisionObserver} from '../lib/classroom-vision';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import {withRuntimeEnv} from '../lib/server/runtime-env';
import type {ClassroomToolRequest} from '../lib/domain/classroom-tool';

const id = '6e98bb60-4ed0-4c64-bcbc-174d5dcb26c2';
const snapshot = { id, revision: 1, stepIndex: 0, connectionEpoch: 1, status: 'active', preferences: { voice: 'female' }, teacherObjectIds: [], feedback: null,
  course: { id: 'picnic', version: '1', title: 'Picnic', pages: [{ id: 'page-1', objects: [{ id: 'apple', label: 'apple', chinese: '苹果' }] }], steps: [{ id: 'find-apple', kind: 'select', pageId: 'page-1', english: 'Find the apple.' }, { id: 'say-banana', kind: 'speak', pageId: 'page-1', english: 'Say the banana.' }] },
} as unknown as ClassroomSnapshot;
const waitFor = async (condition: () => boolean) => {
  const end = Date.now() + 2000;
  while (!condition()) { if (Date.now() >= end) throw new Error('Expected socket event did not arrive.'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
async function harness(provider: 'qwen' | 'openai' | 'grok' = 'qwen', extra: { configuration?:ClassroomVoiceConfig; model?:string; teachingGuidance?:string;remainingMs?: number; startupMs?: number; autoReady?: boolean; delayedTool?: boolean;delegationAdvance?:'receipt'|'missing'|'wrong';delegationOutput?:'confirmed'|'unavailable'|'retry'|'reference';delayReviewConfiguration?:boolean;delayChalkRecoveryConfiguration?:boolean;delayQwenChalkConfiguration?:boolean;delayReviewRestore?:boolean;gptChalk?:boolean;qwenChalk?:boolean;badChalk?:'input'|'scope';spokenAdvance?:'receipt'|'missing'|'wrong'; voice?: string; startedFails?: boolean; delayedTranscript?: boolean; delayedResponses?: boolean; responseAckMs?: number; instructions?: string; spokenResult?: string; heartbeatMs?: number; refreshOnTranscript?: boolean; refreshOnTool?: boolean; audioClock?: PcmOutputClock; gptOutputQuietMs?: number; gptOutputWaitMs?: number; contextVersion?: string; observe?:ClassroomVisionObserver; noAutoPong?:boolean; connectionProbeMs?:number; connectionProbeTimeoutMs?:number; journal?:(entry:unknown)=>Promise<void>;toolThrows?:boolean;toolThrowCallId?:string;toolQueueNow?:()=>number;visualNow?:()=>number;utteranceSettleMs?:number;silencePromptMs?:number;silencePromptEnabled?:boolean;responseProgressMs?:number;delayOverlapConfiguration?:boolean;nativeApplicationInputs?:boolean } = {}) {
  const upstreamHttp = createServer(), vendor = new WebSocketServer({ server: upstreamHttp, autoPong: !extra.noAutoPong });
  const journal:Record<string,unknown>[]=[],journalOrder:string[]=[];
  const sent: Record<string, unknown>[] = [], downstream: Record<string, unknown>[] = [], transcripts: unknown[] = [], tools: unknown[] = [];
  const clients=new Set<WebSocket>();
  let capturedAuthorization: string | undefined,capturedEndpoint:string|undefined;
  let upstream: WebSocket | undefined, opened = 0, released = 0, heartbeatAllowed = true, current = snapshot, resolveTool: (() => void) | undefined, resolveTranscript: (() => void) | undefined, persistedStarts = 0;
  let heartbeatCalls = 0, delayHeartbeat = false, releaseHeartbeat: (() => void) | undefined,reviewConfigurationSeen=false,reviewRestoreDelayed=false,offerCandidate=false;
  vendor.on('connection', socket => {
    upstream = socket;
    socket.on('message', data => {
      const event = JSON.parse(data.toString()); sent.push(event);
      if (extra.autoReady === false) return;
      if (provider !== 'openai' && event.type === 'session.update') {const review=String(event.session?.instructions).includes('Saved source pairs:');if(review)reviewConfigurationSeen=true;const holdRestore=!!extra.delayReviewRestore&&reviewConfigurationSeen&&!review&&!reviewRestoreDelayed;if(holdRestore)reviewRestoreDelayed=true;if(!(extra.delayReviewConfiguration&&review)&&!(extra.delayChalkRecoveryConfiguration&&String(event.session?.instructions).includes('Current optional chalk reference:'))&&!(extra.delayQwenChalkConfiguration&&String(event.session?.instructions).includes('Current source-backed chalk reference:'))&&!holdRestore&&!(extra.delayOverlapConfiguration&&String(event.session?.instructions).includes('latest completed learner utterance')))socket.send(JSON.stringify({ type: 'session.updated' }));}
      if (provider !== 'openai' && event.type === 'response.create' && !extra.delayedResponses) {
        socket.send(JSON.stringify({ type: 'response.created' })); socket.send(JSON.stringify({ type: 'response.done' }));
      }
      if (provider === 'openai' && event.type === 'session.start') socket.send(JSON.stringify({ type: 'session.started', session: { id: 'voice_session' } }));
      if (event.type === 'session.close') socket.send(JSON.stringify({ type: 'session.closed' }));
    });
    if (provider !== 'openai') socket.send(JSON.stringify({ type: 'session.created', session: { id: 'voice_session' } }));
  });
  upstreamHttp.listen(0, '127.0.0.1'); await once(upstreamHttp, 'listening');
  const vendorAddress = upstreamHttp.address(); assert(vendorAddress && typeof vendorAddress !== 'string');
  const app = createServer();
  const lease: VoiceLease = {
    id, epoch: 1, provider, nativeApplicationInputs:extra.nativeApplicationInputs, configuration:extra.configuration, instructions: 'Current verified task: find apple.', initialCue: 'Can you find the apple?', remainingMs: extra.remainingMs ?? 60000, snapshot, observe:extra.observe,...(extra.model?{model:extra.model}:{}),...(extra.teachingGuidance?{teachingGuidance:extra.teachingGuidance}:{}), ...(extra.voice ? { voice: extra.voice } : {}),
    async heartbeat() {
      heartbeatCalls++; const captured = current;
      if (delayHeartbeat) { delayHeartbeat = false; await new Promise<void>(resolve => { releaseHeartbeat = resolve; }); }
      const learner=transcripts.findLast(event=>(event as {role?:string}).role==='child') as {itemId?:string}|undefined;const chalkScope=captureClassroomToolState(captured);return heartbeatAllowed ? { ...(extra.qwenChalk&&offerCandidate&&learner?.itemId&&chalkScope.ok?{chalk:{context:{...chalkScope.snapshot.context,...(extra.badChalk==='scope'?{stateRevision:99}:{})},evidenceItemId:extra.badChalk==='input'?'other-source':learner.itemId,text:'I like apples.',seconds:8 as const}}:{}),snapshot: captured, instructions: extra.instructions ?? captured.feedback?.message ?? 'Current verified task: say apple.',...(extra.teachingGuidance?{teachingGuidance:extra.teachingGuidance}:{}) } : null;
    },
    async started(sessionId) { assert.equal(sessionId, 'voice_session'); if (extra.startedFails) throw new Error('fixture persistence unavailable'); persistedStarts++; },
    async transcript(event) {
      if (extra.delayedTranscript) await new Promise<void>(resolve => { resolveTranscript = resolve; }); transcripts.push(event);
      if (extra.refreshOnTranscript) { current = { ...snapshot, revision: 2, stepIndex: 1 }; await refreshClassroom(id); }
    },
    async tool(name, args, callId, request?:ClassroomToolRequest) {if(extra.toolThrows||extra.toolThrowCallId===callId)throw new Error('PRIVATE_TOOL_DETAIL'); tools.push({ name, args, callId, request, finalEvidence: transcripts.filter(event => (event as { final?: boolean }).final) }); if (extra.delayedTool) await new Promise<void>(resolve => { resolveTool = resolve; }); if (extra.refreshOnTool) { current = { ...current, revision: current.revision + 1, teacherObjectIds: ['apple'], feedback: { id: 'tool-feedback', kind: 'hint', message: '老师标出了图案。' } }; await refreshClassroom(id); } const advanceMode=name==='delegate'?extra.delegationAdvance:extra.spokenAdvance;if(advanceMode&&(name==='delegate'||name==='submit_spoken_answer')){
      current={...current,revision:current.revision+1,stepIndex:1};
      const execution=request?{type:'tool.advance' as const,requestId:advanceMode==='wrong'?'20000000-0000-4000-8000-000000000001':request.id,callId:request.callId,before:request.context,after:{...request.context,stateRevision:current.revision,activityId:current.course.steps[1].id}}:undefined;
      return{output:{status:'confirmed',english:'The complete expression was accepted.'},snapshot:current,...(advanceMode!=='missing'?{execution}:{})};
    } return { output: { status: name==='delegate'?extra.delegationOutput??'confirmed':name==='chalk_write'?'reference':'confirmed', english: extra.spokenResult ?? 'The application confirms the selected apple.' }, snapshot: current,...(extra.gptChalk&&name==='delegate'&&request?{chalk:{context:{...request.context,...(extra.badChalk==='scope'?{stateRevision:99}:{})},evidenceItemId:extra.badChalk==='input'?'another-input':(request.command.arguments as {evidenceItemId:string}).evidenceItemId,text:'I like apples.',seconds:8 as const}}:{}) }; },
    async closed() { released++; journalOrder.push('closed'); },
    async journal(entry) {journal.push(entry as unknown as Record<string,unknown>);journalOrder.push('journal');await extra.journal?.(entry);},
  };
  const controller = attachClassroomSockets(app, {
    origin: 'http://localhost:8080',
    open: async () => { opened++; return lease; },
    config: () => ({ key: 'non-production-fixture', model: provider === 'qwen' ? 'qwen3.8-omni-flash-realtime' : provider==='grok'?'grok-voice-3.0':'gpt-live-1', voice: provider==='grok'?'eve':'Tina', workspaceId: 'workspace', region: 'cn-beijing', childDataReady: true }),
    connect: (_url,headers) => {capturedEndpoint=_url;capturedAuthorization=headers.Authorization;return new WebSocket(`ws://127.0.0.1:${vendorAddress.port}`);},
    heartbeatMs: extra.heartbeatMs ?? 25, startupMs: extra.startupMs ?? 1000, closeMs: 30, utteranceSettleMs: extra.utteranceSettleMs??20, responseAckMs: extra.responseAckMs ?? 1000,
    audioClock: extra.audioClock, toolQueueNow:extra.toolQueueNow,visualNow:extra.visualNow,silencePromptMs:extra.silencePromptMs,silencePromptEnabled:extra.silencePromptEnabled,responseProgressMs:extra.responseProgressMs,
    gptOutputQuietMs: extra.gptOutputQuietMs, gptOutputWaitMs: extra.gptOutputWaitMs,
    connectionProbeMs:extra.connectionProbeMs,connectionProbeTimeoutMs:extra.connectionProbeTimeoutMs,
  });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const address = app.address(); assert(address && typeof address !== 'string');
  const connect = (origin = 'http://localhost:8080', cookie = `teeko_session=${'t'.repeat(43)}`) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/classrooms/${id}`, { headers: { Origin: origin, Cookie: cookie } });
    clients.add(socket);socket.once('close',()=>clients.delete(socket));
    socket.on('error', () => {});
    socket.on('message', data => downstream.push(JSON.parse(data.toString())));
    return socket;
  };
  return {get endpoint(){return capturedEndpoint;}, connect, sent, downstream, transcripts, tools, journal, journalOrder, get capturedAuthorization(){return capturedAuthorization;}, get opened() { return opened; }, get released() { return released; }, get persistedStarts() { return persistedStarts; }, get upstream() { return upstream; }, get heartbeatCalls() { return heartbeatCalls; },get transcriptWaiting(){return !!resolveTranscript;}, offerChalk:(enabled=true)=>{offerCandidate=enabled;},delayNextHeartbeat: () => { delayHeartbeat = true; }, releaseHeartbeat: () => releaseHeartbeat?.(), revoke: () => { heartbeatAllowed = false; }, pause:()=>{current={...current,status:'paused',revision:current.revision+1};}, resolveTool: () => resolveTool?.(), resolveTranscript: () => resolveTranscript?.(), advance: () => { current = { ...snapshot, revision: 2, stepIndex: 1, course: { ...snapshot.course, version: extra.contextVersion ?? snapshot.course.version } }; }, bumpRevision:()=>{current={...current,revision:current.revision+1};},feedback: (message = 'Try once more.') => { current = { ...current, revision: current.revision + 1, feedback: { id: `feedback_${current.revision + 1}`, kind: 'retry', message } }; }, async close() { for(const socket of clients)socket.terminate();await controller.close(); for (const socket of vendor.clients) socket.terminate(); await new Promise<void>(resolve => vendor.close(() => resolve())); await new Promise<void>(resolve => upstreamHttp.close(() => resolve())); await new Promise<void>(resolve => app.close(() => resolve())); } };
}

function pcmFrame(voiced: boolean) {
  const audio = Buffer.alloc(4800);
  if (voiced) for (let i = 0; i < 2400; i++) audio.writeInt16LE(i % 2 ? 1500 : -1500, i * 2);
  return JSON.stringify({ type: 'audio', audio: audio.toString('base64') });
}
function finishSpokenInput(socket: WebSocket) { for (let i = 0; i < 12; i++) socket.send(pcmFrame(false)); }

test('wrong Origin and missing account Cookie cannot claim a lease or create an upstream', async () => {
  const h = await harness();
  try {
    for (const [origin, cookie, expected] of [['https://other.example', '', 403], ['http://localhost:8080', '', 401]] as const) {
      const socket = h.connect(origin, cookie);
      const [, response] = await once(socket, 'unexpected-response');
      assert.equal(response.statusCode, expected); response.resume(); socket.terminate();
      assert.equal(h.opened, 0); assert.equal(h.sent.length, 0);
    }
  } finally { await h.close(); }
});

async function settleNativeGreeting(h:Awaited<ReturnType<typeof harness>>){
 await waitFor(()=>h.sent.some(event=>event.type==='response.create'));
 const pong=once(h.upstream!,'pong');h.upstream!.ping('native_fixture_ready');
 const [nonce]=await pong;assert.equal(nonce.toString(),'native_fixture_ready');
}

test('native highlight carries a server scope and accepts its own revision change exactly once', async () => {
  const h=await harness('qwen',{refreshOnTool:true,heartbeatMs:60000});
  try {
    const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
    const event=JSON.stringify({type:'response.function_call_arguments.done',name:'highlight_objects',call_id:'scoped-highlight',arguments:JSON.stringify({contextKey:`${id}:1:0`,objectIds:['apple']})});
    h.upstream!.send(event);h.upstream!.send(event);
    await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='scoped-highlight'));
    assert.equal(h.tools.length,1);
    const request=(h.tools[0] as {request:ClassroomToolRequest}).request;assert(request);
    assert.equal(request.source,'teacher');assert.equal(request.callId,'scoped-highlight');
    assert.deepEqual(request.context,{logicalSessionId:id,courseVersion:'picnic:1',connectionEpoch:1,stateRevision:1,pageId:'page-1',activityId:'find-apple'});
    const item=h.sent.find(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='scoped-highlight')!.item as {output:string};
    assert.equal(JSON.parse(item.output).status,'confirmed');
    assert(h.downstream.some(e=>e.type==='snapshot'&&(e.classroom as ClassroomSnapshot).revision===2));
    assert.equal(h.downstream.some(e=>e.type==='error'),false);
  } finally {await h.close();}
});

test('highlight proposals with extra authority or media are rejected without closing speech', async () => {
  const h=await harness('qwen',{heartbeatMs:60000});
  try {
    const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
    h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'highlight_objects',call_id:'invalid-highlight',arguments:JSON.stringify({contextKey:`${id}:1:0`,objectIds:['apple'],image:'UNAPPROVED_FIXTURE',correct:true})}));
    await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='invalid-highlight'));
    assert.equal(h.tools.length,0);assert.equal(h.downstream.some(e=>e.type==='error'),false);
    assert(!JSON.stringify(h.journal).includes('UNAPPROVED_FIXTURE'));
    socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));
    await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));
  } finally {await h.close();}
});

test('a highlight result returned under a different current task cannot be announced as success',async()=>{
  const h=await harness('qwen',{delayedTool:true,heartbeatMs:60000});
  try{
    const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
    h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'highlight_objects',call_id:'late-highlight',arguments:JSON.stringify({contextKey:`${id}:1:0`,objectIds:['apple']})}));
    await waitFor(()=>h.tools.length===1);h.advance();h.resolveTool();
    await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='late-highlight'));
    const item=h.sent.find(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='late-highlight')!.item as {output:string};
    assert.equal(JSON.parse(item.output).status,'unavailable');assert(!item.output.includes('The application confirms the selected apple'));
    assert.equal(h.downstream.some(e=>e.type==='error'),false);
  }finally{await h.close();}
});

test('a scoped highlight application failure returns unavailable and speech keeps working',async()=>{
  const h=await harness('qwen',{toolThrows:true,heartbeatMs:60000});
  try{
    const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
    h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'highlight_objects',call_id:'failed-highlight',arguments:JSON.stringify({contextKey:`${id}:1:0`,objectIds:['apple']})}));
    await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='failed-highlight'));
    const item=h.sent.find(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='failed-highlight')!.item as {output:string};
    assert.equal(JSON.parse(item.output).status,'unavailable');assert(!JSON.stringify([...h.sent,...h.journal]).includes('PRIVATE_TOOL_DETAIL'));
    assert.equal(h.downstream.some(e=>e.type==='error'),false);
    socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));
  }finally{await h.close();}
});

test('a malformed highlight application result is not forwarded as a confirmed action',async()=>{
  const h=await harness('qwen',{spokenResult:'UNBOUNDED_FIXTURE '.repeat(400),heartbeatMs:60000});
  try{
    const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
    h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'highlight_objects',call_id:'invalid-result',arguments:JSON.stringify({contextKey:`${id}:1:0`,objectIds:['apple']})}));
    await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='invalid-result'));
    const item=h.sent.find(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='invalid-result')!.item as {output:string};
    assert.equal(JSON.parse(item.output).status,'unavailable');assert(!item.output.includes('UNBOUNDED_FIXTURE'));
    assert.equal(h.downstream.some(e=>e.type==='error'),false);
  }finally{await h.close();}
});

test('Qwen is configured before ready; only paced PCM enters upstream and raw commands are rejected', async () => {
  const h = await harness();
  try {
    const socket = h.connect(); await once(socket, 'open');
    await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    assert.equal(h.persistedStarts, 1);
    assert.equal(h.sent[0].type, 'session.update');
    socket.send(JSON.stringify({ type: 'audio', audio: Buffer.alloc(3200).toString('base64') }));
    await waitFor(() => h.sent.some(event => event.type === 'input_audio_buffer.append'));
    socket.send(JSON.stringify({ type: 'session.update', session: { instructions: 'untrusted replacement' } }));
    await once(socket, 'close');
    assert(!h.sent.some(event => JSON.stringify(event).includes('untrusted replacement')));
    await waitFor(() => h.released === 1);
  } finally { await h.close(); }
});

test('server revocation and hard deadline each close billed upstream and release the lease once', async () => {
  for (const mode of ['revoke', 'deadline'] as const) {
    const h = await harness('qwen', { remainingMs: mode === 'deadline' ? 100 : 60000 });
    try {
      const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
      if (mode === 'revoke') h.revoke();
      await once(socket, 'close'); await waitFor(() => h.released === 1);
      assert.notEqual(h.upstream?.readyState, WebSocket.OPEN);
    } finally { await h.close(); }
  }
});

test('GPT Live starts on its documented protocol and delegates verified work on the server', async () => {
  const h = await harness('openai');
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    assert.equal(h.sent[0].type, 'session.start');
    const session = h.sent[0].session as { audio: { format: unknown }; delegation: { type: string } };
    assert.deepEqual(session.audio.format, { type: 'audio/pcm', rate: 24000 }); assert.equal(session.delegation.type, 'client');
    socket.send(pcmFrame(true)); socket.send(pcmFrame(true));
    await waitFor(()=>h.sent.filter(event=>event.type==='session.input_audio.append').length===2);
    h.upstream!.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Circle the apple.' }));
    h.upstream!.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'delegation_1', target: 'client' } }));
    finishSpokenInput(socket);
    await waitFor(() => h.tools.length === 1);
    assert.equal((h.tools[0] as { name: string }).name, 'delegate');
    assert.equal((h.tools[0] as { finalEvidence: { text: string; final: boolean }[] }).finalEvidence[0].text, 'Circle the apple.');
    assert.equal((h.tools[0] as { args: { contextKey: string } }).args.contextKey, `${id}:1:0`);
    await waitFor(() => h.sent.some(event => event.type === 'session.commentary.append' && event.delegation_id === 'delegation_1'));
    assert(h.sent.some(event => event.type === 'session.thinking.append' && event.content === '' && event.delegation_id === 'delegation_1'));
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close'); await waitFor(() => h.released === 1);
  } finally { await h.close(); }
});

test('provider errors stay generic, and startup timeout releases an unready connection', async () => {
  for (const mode of ['error', 'timeout'] as const) {
    const h = await harness('qwen', { autoReady: mode !== 'timeout', startupMs: 80 });
    try {
      const socket = h.connect(); await once(socket, 'open');
      if (mode === 'error') { await waitFor(() => h.downstream.some(event => event.type === 'ready')); h.upstream!.send(JSON.stringify({ type: 'error', error: { message: 'sensitive-upstream-error' } })); }
      await once(socket, 'close'); await waitFor(() => h.released === 1);
      assert(h.downstream.some(event => event.type === 'error'));
      assert(!JSON.stringify(h.downstream).includes('sensitive-upstream-error'));
    } finally { await h.close(); }
  }
});

test('heartbeat publishes a changed snapshot while preserving its server revision', async () => {
  const h = await harness();
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    h.advance(); await waitFor(() => h.downstream.some(event => event.type === 'snapshot' && (event.classroom as ClassroomSnapshot).revision === 2));
    assert(h.sent.some(event => event.type === 'session.update' && JSON.stringify(event).includes('say apple')));
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

async function releaseGptTaskGate(h:Awaited<ReturnType<typeof harness>>,socket:WebSocket){
 await waitFor(()=>h.sent.some(event=>event.type==='session.thinking.append'&&String(event.content).includes('Say the banana.')));
 const context=h.sent.findLast(event=>event.type==='session.thinking.append')!;
 h.upstream!.send(JSON.stringify({type:'session.thinking.appended',client_event_id:context.event_id}));
 finishSpokenInput(socket);await waitFor(()=>h.sent.filter(event=>event.type==='session.input_audio.append').length===12);
 h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(24000).toString('base64')}));
}

test('a task refresh offers the next activity without ordering a conversational interruption',async()=>{
 const h=await harness('openai');
 try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));
  h.advance();await refreshClassroom(id);await releaseGptTaskGate(h,socket);await waitFor(()=>h.sent.some(event=>event.type==='session.commentary.append'&&String(event.content).includes('do not interrupt an ongoing conversation')));
  const cue=h.sent.find(event=>event.type==='session.commentary.append'&&String(event.content).includes('do not interrupt an ongoing conversation'));
  assert.match(String(cue?.content),/natural pause/);assert.match(String(cue?.content),/learner chooses to finish/);
  socket.send(JSON.stringify({type:'close'}));await once(socket,'close');
 }finally{await h.close();}
});

test('ending while a tool awaits cannot produce late confirmation or recreate speech', async () => {
  const h = await harness('openai', { delayedTool: true });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    socket.send(pcmFrame(true)); socket.send(pcmFrame(true));
    await waitFor(()=>h.sent.filter(event=>event.type==='session.input_audio.append').length===2);
    h.upstream!.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Apple.' }));
    h.upstream!.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'late_tool', target: 'client' } }));
    finishSpokenInput(socket);
    await waitFor(() => h.tools.length === 1); h.revoke(); await once(socket, 'close');
    const before = h.sent.length; h.resolveTool(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(h.sent.length, before); assert.equal(h.released, 1);
  } finally { await h.close(); }
});

test('server selected voice overrides the environment default at provider startup', async () => {
  const h = await harness('openai', { voice: 'meridian' });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.sent.some(event => event.type === 'session.start'));
    assert.equal((h.sent[0].session as { audio: { output: { voice: string } } }).audio.output.voice, 'meridian');
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('HTTP feedback on the same task triggers one natural teaching cue, never repeated on unchanged heartbeat', async () => {
  const h = await harness('openai');
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    const before = h.sent.filter(event => event.type === 'session.commentary.append').length;
    h.feedback(); await waitFor(() => h.sent.filter(event => event.type === 'session.commentary.append').length > before);
    await new Promise(resolve => setTimeout(resolve, 65));
    assert.equal(h.sent.filter(event => event.type === 'session.commentary.append').length, before + 1);
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('failure to persist provider session identity closes upstream before becoming ready', async () => {
  for (const provider of ['qwen', 'openai'] as const) {
    const h = await harness(provider, { startedFails: true });
    try {
      const socket = h.connect(); await once(socket, 'open'); await once(socket, 'close');
      assert.equal(h.persistedStarts, 0); assert(!h.downstream.some(event => event.type === 'ready')); await waitFor(() => h.released === 1);
    } finally { await h.close(); }
  }
});

test('GPT partial transcript and a delegation alone never become completed speech evidence', async () => {
  const h = await harness('openai');
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    socket.send(pcmFrame(true)); socket.send(pcmFrame(true));
    h.upstream!.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'I like app' }));
    h.upstream!.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'partial_1', target: 'client' } }));
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(h.tools.length, 0); assert(!h.transcripts.some(event => (event as { final?: boolean }).final));
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('GPT aggregates all fragments once after measured PCM silence, including a late transcript suffix', async () => {
  const h = await harness('openai');
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    socket.send(pcmFrame(true)); socket.send(pcmFrame(true));
    h.upstream!.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'I like ' }));
    h.upstream!.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'answer_1', target: 'client' } }));
    finishSpokenInput(socket);
    await new Promise(resolve => setTimeout(resolve, 5));
    h.upstream!.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'apples.' }));
    await waitFor(() => h.tools.length === 1);
    const evidence = (h.tools[0] as { finalEvidence: { text: string; final: boolean; contextKey: string }[] }).finalEvidence;
    assert.equal(evidence.length, 1); assert.equal(evidence[0].text, 'I like apples.'); assert.equal(evidence[0].contextKey, `${id}:1:0`);
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('changing task discards a pending GPT utterance and its delegation rather than grading it on the next task', async () => {
  const h = await harness('openai');
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    socket.send(pcmFrame(true)); socket.send(pcmFrame(true));
    h.upstream!.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Old answer' }));
    h.upstream!.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'obsolete_1', target: 'client' } }));
    h.advance(); await waitFor(() => h.downstream.some(event => event.type === 'snapshot' && (event.classroom as ClassroomSnapshot).revision === 2));
    finishSpokenInput(socket); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(h.tools.length, 0); assert(!h.transcripts.some(event => (event as { final?: boolean }).final));
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('authenticated typed input is persisted once before GPT delegation with the current task key', async () => {
  const h = await harness('openai');
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    socket.send(JSON.stringify({ type: 'text', text: 'I like apples.' })); await waitFor(() => h.tools.length === 1);
    const evidence = (h.tools[0] as { finalEvidence: { text: string; source: string; contextKey: string }[] }).finalEvidence;
    assert.equal(evidence.length, 1); assert.equal(evidence[0].source, 'typed'); assert.equal(evidence[0].text, 'I like apples.'); assert.equal(evidence[0].contextKey, `${id}:1:0`);
    assert.equal((h.tools[0] as { args: { contextKey: string } }).args.contextKey, `${id}:1:0`);
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('Qwen completed ASR persists its captured task before the following native tool can grade', async () => {
  const h = await harness('qwen', { delayedTranscript: true });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    // A native tool belongs to a response after VAD, never to a still-cancelling greeting.
    h.upstream!.send(JSON.stringify({type:'response.done'}));
    h.upstream!.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped'}));
    h.upstream!.send(JSON.stringify({type:'response.created'}));
    h.upstream!.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Apple.', item_id: 'asr_1' }));
    h.upstream!.send(JSON.stringify({ type: 'response.function_call_arguments.done', name: 'submit_spoken_answer', call_id: 'tool_1', arguments: JSON.stringify({ contextKey: `${id}:1:0`, answer: 'Apple.' }) }));
    await waitFor(()=>h.transcriptWaiting);assert.equal(h.tools.length, 0);
    h.resolveTranscript(); await waitFor(() => h.tools.length === 1);
    const evidence = (h.tools[0] as { finalEvidence: { text: string; contextKey: string; source: string }[] }).finalEvidence;
    assert.equal(evidence[0].contextKey, `${id}:1:0`); assert.equal(evidence[0].source, 'speech'); assert.equal(evidence[0].text, 'Apple.');
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('Qwen cancellation waits for response.done before creating a replacement reply', async () => {
  const h = await harness('qwen', { delayedResponses: true });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.sent.some(event => event.type === 'response.create'));
    h.upstream!.send(JSON.stringify({ type: 'response.created' })); h.feedback('replacement cue');
    await waitFor(() => h.sent.some(event => event.type === 'response.cancel'));
    h.upstream!.send(JSON.stringify({ type: 'response.audio.delta', delta: 'AAAAAA==' }));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(h.sent.filter(event => event.type === 'response.create').length, 1);
    assert.equal(h.downstream.filter(event => event.type === 'audio').length, 0);
    assert(h.downstream.some(event => event.type === 'interrupt'));
    h.upstream!.send(JSON.stringify({ type: 'response.done' }));
    await waitFor(() => h.sent.filter(event => event.type === 'response.create').length === 2);
    assert.equal(socket.readyState, WebSocket.OPEN);
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('a cancelled Qwen reply with truncated tool arguments cannot close the voice connection', async () => {
  const h = await harness('qwen', { delayedResponses: true, heartbeatMs: 60000 });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.sent.some(event => event.type === 'response.create'));
    h.upstream!.send(JSON.stringify({ type: 'response.created' }));
    h.feedback('A newer application cue'); await refreshClassroom(id);
    await waitFor(() => h.sent.some(event => event.type === 'response.cancel'));
    h.upstream!.send(JSON.stringify({ type: 'response.function_call_arguments.done', name: 'highlight_objects', call_id: 'cancelled_partial', arguments: '{"objectIds":[' }));
    h.upstream!.send(JSON.stringify({ type: 'response.done' }));
    await waitFor(() => h.sent.filter(event => event.type === 'response.create').length === 2 || h.downstream.some(event => event.type === 'error'));
    assert.equal(h.downstream.filter(event => event.type === 'error').length, 0); assert.equal(socket.readyState, WebSocket.OPEN); assert.equal(h.tools.length, 0);
    assert(!h.sent.some(event => JSON.stringify(event).includes('cancelled_partial')));
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('invalid current Qwen tool arguments return one unavailable result without application execution or media failure', async () => {
  const h = await harness('qwen', { delayedResponses: true, heartbeatMs: 60000 });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.sent.some(event => event.type === 'response.create'));
    h.upstream!.send(JSON.stringify({ type: 'response.created' }));
    const invalid = JSON.stringify({ type: 'response.function_call_arguments.done', name: 'highlight_objects', call_id: 'invalid_current', arguments: '{"objectIds":[' });
    h.upstream!.send(invalid); h.upstream!.send(invalid); h.upstream!.send(JSON.stringify({ type: 'response.done' }));
    await waitFor(() => h.sent.some(event => event.type === 'conversation.item.create' && (event.item as {call_id?:string})?.call_id === 'invalid_current') || h.downstream.some(event => event.type === 'error'));
    assert.equal(h.downstream.filter(event => event.type === 'error').length, 0); assert.equal(socket.readyState, WebSocket.OPEN); assert.equal(h.tools.length, 0);
    const results=h.sent.filter(event=>event.type==='conversation.item.create'&&(event.item as {call_id?:string})?.call_id==='invalid_current');
    assert.equal(results.length,1);assert.equal(JSON.parse((results[0].item as {output:string}).output).status,'unavailable');
    await waitFor(()=>h.sent.filter(event=>event.type==='response.create').length===2);
    h.upstream!.send(JSON.stringify({type:'response.created'}));
    h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'highlight_objects',call_id:'invalid_retry',arguments:'null'}));
    h.upstream!.send(JSON.stringify({type:'response.done'}));
    await waitFor(()=>h.sent.some(event=>event.type==='conversation.item.create'&&(event.item as {call_id?:string})?.call_id==='invalid_retry'));
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(h.tools.length,0);assert.equal(h.sent.filter(event=>event.type==='response.create').length,2,'invalid tool recovery cannot loop another response');
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('late Qwen tool arguments from the previous objective are discarded while the next response is pending', async () => {
  const h = await harness('qwen', { delayedResponses: true, heartbeatMs: 60000 });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.sent.some(event => event.type === 'response.create'));
    h.upstream!.send(JSON.stringify({ type: 'response.created' })); h.upstream!.send(JSON.stringify({ type: 'response.done' }));
    await new Promise(resolve=>setTimeout(resolve,5)); h.advance(); await refreshClassroom(id);
    await waitFor(() => h.sent.filter(event=>event.type==='response.create').length===2);
    h.upstream!.send(JSON.stringify({ type: 'response.function_call_arguments.done', name: 'highlight_objects', call_id: 'obsolete_partial', arguments: '{"objectIds":[' }));
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(h.downstream.filter(event=>event.type==='error').length,0);assert.equal(h.tools.length,0);
    assert(!h.sent.some(event=>JSON.stringify(event).includes('obsolete_partial')));
    h.upstream!.send(JSON.stringify({type:'response.created'}));
    h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'highlight_objects',call_id:'obsolete_valid_json',arguments:JSON.stringify({contextKey:`${id}:1:0`,objectIds:['apple']})}));
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(h.tools.length,0);
    assert(!h.sent.some(event=>JSON.stringify(event).includes('obsolete_valid_json')));
    socket.send(JSON.stringify({type:'close'}));await once(socket,'close');
  } finally {await h.close();}
});

test('Qwen create-to-created window holds new cues and keeps only the latest pending replacement', async () => {
  const h = await harness('qwen', { delayedResponses: true });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.sent.some(event => event.type === 'response.create'));
    h.feedback('first pending cue'); await waitFor(() => h.sent.some(event => event.type === 'session.update' && JSON.stringify(event).includes('first pending cue')));
    h.feedback('latest pending cue'); await waitFor(() => h.sent.some(event => event.type === 'session.update' && JSON.stringify(event).includes('latest pending cue')));
    assert.equal(h.sent.filter(event => event.type === 'response.create').length, 1);
    h.upstream!.send(JSON.stringify({ type: 'response.created' }));
    await waitFor(() => h.sent.some(event => event.type === 'response.cancel'));
    h.upstream!.send(JSON.stringify({ type: 'response.done' })); await waitFor(() => h.sent.filter(event => event.type === 'response.create').length === 2);
    const response = h.sent.filter(event => event.type === 'response.create')[1];
    assert(JSON.stringify(response).includes('latest pending cue')); assert(!JSON.stringify(response).includes('first pending cue'));
    assert.equal(h.downstream.filter(event => event.type === 'error').length, 0);
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('Qwen missing response.created acknowledgement times out visibly and releases the billed connection', async () => {
  const h = await harness('qwen', { delayedResponses: true, responseAckMs: 60 });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.sent.some(event => event.type === 'response.create'));
    await waitFor(() => h.released === 1);
    await waitFor(() => h.downstream.some(event => event.type === 'error') && h.upstream!.readyState !== WebSocket.OPEN);
    assert.equal(h.downstream.find(event => event.type === 'error')?.code, 'response_timeout');
  } finally { await h.close(); }
});

test('connection failures carry safe layer codes instead of resembling an intentional close', async () => {
  for (const cause of ['provider_error', 'input_rate_limited', 'upstream_closed', 'lease_lost'] as const) {
    const h = await harness('qwen', { heartbeatMs: 20 });
    try {
      const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
      if (cause === 'provider_error') h.upstream!.send(JSON.stringify({ type: 'error', error: { message: 'PRIVATE_UPSTREAM_DETAIL' } }));
      else if (cause === 'input_rate_limited') for (let i = 0; i < 17; i++) socket.send(JSON.stringify({ type: 'audio', audio: Buffer.alloc(3200).toString('base64') }));
      else if (cause === 'upstream_closed') h.upstream!.terminate();
      else h.revoke();
      await once(socket, 'close'); await waitFor(() => h.released === 1);
      assert.equal(h.downstream.find(event => event.type === 'error')?.code, cause);
      assert(!JSON.stringify(h.downstream).includes('PRIVATE_UPSTREAM_DETAIL'));
      assert(!h.downstream.some(event => event.type === 'snapshot' && (event.classroom as ClassroomSnapshot).status === 'paused'));
    } finally { await h.close(); }
  }
});

test('normal 100ms PCM captured in bounded 450ms browser batches survives sixty seconds across receive windows', {timeout:5000}, async t => {
  const h=await harness('qwen',{heartbeatMs:60000});
  try {
    const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));
    const base=Date.now();let clock=base,capturedAt=100,frames=0;
    t.mock.method(Date,'now',()=>clock);
    for(const arrival of [...Array.from({length:133},(_,i)=>(i+1)*450),60000]){
      clock=base+arrival;
      while(capturedAt<=arrival){assert(arrival-capturedAt<=450);socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));capturedAt+=100;frames++;}
      const until=performance.now()+1000;
      while(h.sent.filter(event=>event.type==='input_audio_buffer.append').length<frames&&!h.downstream.some(event=>event.type==='error')){if(performance.now()>until)throw Error('Bounded PCM batch was not forwarded');await new Promise(resolve=>setTimeout(resolve,2));}
      assert.equal(h.downstream.filter(event=>event.type==='error').length,0);
    }
    assert.equal(frames,600);assert.equal(socket.readyState,WebSocket.OPEN);
    t.mock.restoreAll();socket.send(JSON.stringify({type:'close'}));await once(socket,'close');
  }finally{t.mock.restoreAll();await h.close();}
});

test('GPT context appends contain only compact facts and every append stays within a conservative UTF8 bound', async () => {
  const h = await harness('openai', { instructions: 'STATIC_RULE_DO_NOT_RESEND '.repeat(200), spokenResult: '这是一个较长的确认。'.repeat(100) });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    h.feedback('这是已确认的课堂反馈。'.repeat(100));
    await waitFor(() => h.downstream.some(event => event.type === 'snapshot' && (event.classroom as ClassroomSnapshot).revision === 2));
    socket.send(JSON.stringify({ type: 'text', text: 'Apple.' })); await waitFor(() => h.tools.length === 1);
    await waitFor(() => h.sent.some(event => event.type === 'session.commentary.append' && String(event.content).includes('较长')));
    const appends = h.sent.filter(event => String(event.type).endsWith('.append'));
    for (const event of appends) assert(Buffer.byteLength(String(event.content), 'utf8') <= 480);
    const content = appends.map(event => String(event.content)).join('');
    assert(!content.includes('STATIC_RULE_DO_NOT_RESEND')); assert(content.includes(`${id}:1:0`));
    assert(content.includes('Find the apple.'));
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('GPT task-change commentary contains the actual question once after quiet and context acknowledgement', async () => {
  const h = await harness('openai');
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    h.advance();await refreshClassroom(id);assert.equal(h.sent.filter(event=>event.type==='session.commentary.append').length,1);await releaseGptTaskGate(h,socket);await waitFor(() => h.sent.some(event => event.type === 'session.commentary.append' && String(event.content).includes('Say the banana.')));assert.equal(h.sent.filter(event=>event.type==='session.commentary.append').length,2);
    assert.equal(h.downstream.filter(event => event.type === 'error').length, 0);
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('HTTP refresh synchronizes owner task before the next received learner input without waiting for polling', async () => {
  const h = await harness('openai', { heartbeatMs: 60000 });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    h.advance(); await refreshClassroom(id);
    socket.send(JSON.stringify({ type: 'text', text: 'Banana.' })); await waitFor(() => h.transcripts.length === 1);
    assert.equal((h.transcripts[0] as { contextKey: string }).contextKey, `${id}:1:1`);
    await waitFor(() => h.downstream.some(event => event.type === 'snapshot' && (event.classroom as ClassroomSnapshot).stepIndex === 1));
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('a refresh requested during an in-flight heartbeat is drained before both callers resolve and stop unsubscribes', async () => {
  const h = await harness('openai', { heartbeatMs: 60000 });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    h.delayNextHeartbeat(); const first = refreshClassroom(id); await waitFor(() => h.heartbeatCalls === 1);
    h.advance(); const second = refreshClassroom(id); h.releaseHeartbeat(); await Promise.all([first, second]);
    assert.equal(h.heartbeatCalls, 2);
    await waitFor(() => h.downstream.some(event => event.type === 'snapshot' && (event.classroom as ClassroomSnapshot).revision === 2));
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close'); await waitFor(() => h.released === 1);
    const before = h.heartbeatCalls; await refreshClassroom(id); assert.equal(h.heartbeatCalls, before);
  } finally { await h.close(); }
});

test('a transcript handler may await authoritative refresh without cycling on its own transcript chain', async () => {
  const h = await harness('openai', { heartbeatMs: 60000, refreshOnTranscript: true });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    socket.send(JSON.stringify({ type: 'text', text: 'Apple.' }));
    await waitFor(() => h.downstream.some(event => event.type === 'snapshot' && (event.classroom as ClassroomSnapshot).stepIndex === 1));
    assert.equal(h.transcripts.length, 1); assert.equal(h.tools.length, 0);
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close'); await waitFor(() => h.released === 1);
  } finally { await h.close(); }
});

test('Qwen VAD end reserves the automatic response before final ASR refresh can request a new question', async () => {
  const h = await harness('qwen', { delayedResponses: true, heartbeatMs: 60000, refreshOnTranscript: true });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.sent.some(event => event.type === 'response.create'));
    h.upstream!.send(JSON.stringify({ type: 'response.created' })); h.upstream!.send(JSON.stringify({ type: 'response.done' }));
    h.upstream!.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    h.upstream!.send(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    h.upstream!.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Apple.', item_id: 'voice_reply_1' }));
    await waitFor(() => h.downstream.some(event => event.type === 'snapshot' && (event.classroom as ClassroomSnapshot).stepIndex === 1));
    assert.equal(h.sent.filter(event => event.type === 'response.create').length, 1);
    h.upstream!.send(JSON.stringify({ type: 'response.created' })); await waitFor(() => h.sent.some(event => event.type === 'response.cancel'));
    assert.equal(h.sent.filter(event => event.type === 'response.create').length, 1);
    h.upstream!.send(JSON.stringify({ type: 'response.done' })); await waitFor(() => h.sent.filter(event => event.type === 'response.create').length === 2);
    h.upstream!.send(JSON.stringify({ type: 'response.created' }));
    h.upstream!.send(JSON.stringify({ type: 'response.audio.delta', delta: 'AAAAAA==' })); await waitFor(() => h.downstream.some(event => event.type === 'audio'));
    assert.equal(h.downstream.filter(event => event.type === 'error').length, 0);
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('Qwen VAD pending survives the old response cancellation acknowledgement', async () => {
  const h = await harness('qwen', { delayedResponses: true, heartbeatMs: 60000 });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.sent.some(event => event.type === 'response.create'));
    h.upstream!.send(JSON.stringify({ type: 'response.created' })); h.upstream!.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    await waitFor(() => h.sent.filter(event => event.type === 'response.cancel').length === 1);
    h.upstream!.send(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' })); h.feedback('new task after native VAD'); await refreshClassroom(id);
    h.upstream!.send(JSON.stringify({ type: 'response.done' })); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(h.sent.filter(event => event.type === 'response.create').length, 1);
    h.upstream!.send(JSON.stringify({ type: 'response.created' })); await waitFor(() => h.sent.filter(event => event.type === 'response.cancel').length === 2);
    h.upstream!.send(JSON.stringify({ type: 'response.done' })); await waitFor(() => h.sent.filter(event => event.type === 'response.create').length === 2);
    assert.equal(h.downstream.filter(event => event.type === 'error').length, 0);
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('Qwen automatic VAD response missing its created acknowledgement also has a bounded timeout', async () => {
  const h = await harness('qwen', { delayedResponses: true, heartbeatMs: 60000, responseAckMs: 60 });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.sent.some(event => event.type === 'response.create'));
    h.upstream!.send(JSON.stringify({ type: 'response.created' })); h.upstream!.send(JSON.stringify({ type: 'response.done' }));
    h.upstream!.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' })); h.upstream!.send(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    await waitFor(() => h.released === 1 && h.downstream.some(event => event.type === 'error'));
    assert.notEqual(h.upstream!.readyState, WebSocket.OPEN);
  } finally { await h.close(); }
});

function outputClock() {
  let time = 0, nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: PcmOutputClock = { now: () => time, schedule: (callback, milliseconds) => { const id = ++nextId; timers.set(id, { at: time + milliseconds, callback }); return id; }, cancel: handle => { timers.delete(handle as number); } };
  return { clock, timers, advance(milliseconds: number) {
    const end = time + milliseconds;
    for (;;) { const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > end) break; timers.delete(next[0]); time = Math.max(time, next[1].at); next[1].callback(); }
    time = end;
  } };
}

test('both providers pace burst audio to the consumer clock rather than forwarding seconds immediately', async () => {
  for (const provider of ['qwen', 'openai'] as const) {
    const output = outputClock(), h = await harness(provider, { delayedResponses: true, heartbeatMs: 60000, audioClock: output.clock });
    try {
      const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
      if (provider === 'qwen') { await waitFor(() => h.sent.some(event => event.type === 'response.create')); h.upstream!.send(JSON.stringify({ type: 'response.created' })); }
      const type = provider === 'qwen' ? 'response.audio.delta' : 'session.output_audio.delta', audio = Buffer.alloc(144000).toString('base64');
      h.upstream!.send(JSON.stringify({ type, delta: audio })); h.upstream!.send(JSON.stringify({ type, delta: audio }));
      await waitFor(() => output.timers.size === 1); assert.equal(h.downstream.filter(event => event.type === 'audio').length, 0);
      output.advance(1000); await waitFor(() => h.downstream.filter(event => event.type === 'audio').length >= 21);
      const frames = h.downstream.filter(event => event.type === 'audio'); assert.equal(frames.length, 21);
      assert(frames.every(event => Buffer.from(String(event.audio), 'base64').length <= 2400));
      socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
      output.advance(10000); assert.equal(output.timers.size, 0);
    } finally { await h.close(); }
  }
});

test('a new task clears already-generated Qwen audio even after response.done and drops pending stale packets', async () => {
  const output = outputClock(), h = await harness('qwen', { delayedResponses: true, heartbeatMs: 60000, audioClock: output.clock });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.sent.some(event => event.type === 'response.create'));
    h.upstream!.send(JSON.stringify({ type: 'response.created' }));
    h.upstream!.send(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.alloc(144000, 0x11).toString('base64') })); h.upstream!.send(JSON.stringify({ type: 'response.done' }));
    await waitFor(() => output.timers.size === 1); output.advance(0); await waitFor(() => h.downstream.some(event => event.type === 'audio'));
    const before = h.downstream.filter(event => event.type === 'audio').length;
    h.advance(); await refreshClassroom(id); await waitFor(() => h.sent.filter(event => event.type === 'response.create').length === 2);
    h.upstream!.send(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.alloc(2400, 0x33).toString('base64') }));
    await new Promise(resolve => setTimeout(resolve, 5)); output.advance(7000); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.downstream.filter(event => event.type === 'audio').length, before);
    assert(h.downstream.some(event => event.type === 'interrupt'));
    h.upstream!.send(JSON.stringify({ type: 'response.created' }));
    h.upstream!.send(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.alloc(2400, 0x22).toString('base64') }));
    await waitFor(() => output.timers.size === 1); output.advance(0); await waitFor(() => h.downstream.filter(event => event.type === 'audio').length === before + 1);
    assert.equal(Buffer.from(String(h.downstream.filter(event => event.type === 'audio').at(-1)!.audio), 'base64')[0], 0x22);
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('Qwen same-task tool feedback refresh preserves every queued PCM byte across response boundaries', async () => {
  const output = outputClock(), h = await harness('qwen', { delayedResponses: true, heartbeatMs: 60000, audioClock: output.clock, refreshOnTool: true });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.sent.some(event => event.type === 'response.create'));
    h.upstream!.send(JSON.stringify({ type: 'response.created' }));
    h.upstream!.send(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.alloc(144000, 0x11).toString('base64') }));
    h.upstream!.send(JSON.stringify({ type: 'response.function_call_arguments.done', name: 'highlight_objects', call_id: 'continuation', arguments: JSON.stringify({ contextKey: `${id}:1:0`, objectIds: ['apple'] }) }));
    h.upstream!.send(JSON.stringify({ type: 'response.done' }));
    await waitFor(() => h.sent.filter(event => event.type === 'response.create').length === 2);
    assert(h.downstream.some(event => event.type === 'snapshot' && (event.classroom as ClassroomSnapshot).feedback?.id === 'tool-feedback'));
    assert(!h.sent.some(event => event.type === 'response.cancel'));
    h.upstream!.send(JSON.stringify({ type: 'response.created' }));
    h.upstream!.send(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.alloc(4800, 0x22).toString('base64') }));
    h.upstream!.send(JSON.stringify({ type: 'response.done' }));
    await new Promise(resolve => setTimeout(resolve, 10)); output.advance(4000);
    await waitFor(() => h.downstream.filter(event => event.type === 'audio').length >= 2);
    const bytes = Buffer.concat(h.downstream.filter(event => event.type === 'audio').map(event => Buffer.from(String(event.audio), 'base64')));
    assert.equal(bytes.length, 148800); assert(bytes.subarray(0, 144000).every(value => value === 0x11)); assert(bytes.subarray(144000).every(value => value === 0x22));
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('GPT learner speech immediately clears playback and cannot replay late old audio during speech or missing PCM', async () => {
  const output = outputClock(), h = await harness('openai', { heartbeatMs: 60000, audioClock: output.clock });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    h.upstream!.send(JSON.stringify({ type: 'session.output_audio.delta', delta: Buffer.alloc(144000, 0x11).toString('base64') }));
    await waitFor(() => output.timers.size === 1); output.advance(0); await waitFor(() => h.downstream.some(event => event.type === 'audio'));
    const before = h.downstream.filter(event => event.type === 'audio').length, interrupts = h.downstream.filter(event => event.type === 'interrupt').length;
    socket.send(pcmFrame(true));
    await waitFor(() => h.sent.some(event => event.type === 'session.input_audio.append'));
    h.upstream!.send(JSON.stringify({ type: 'session.output_audio.delta', delta: Buffer.alloc(2400, 0x33).toString('base64') }));
    await new Promise(resolve => setTimeout(resolve, 20)); output.advance(7000); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.downstream.filter(event => event.type === 'audio').length, before);
    assert(h.downstream.filter(event => event.type === 'interrupt').length > interrupts);
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close'); assert.equal(output.timers.size, 0);
  } finally { await h.close(); }
});

test('GPT task gate uses actual output silence despite continuous media frames and drops uncertain new speech', async () => {
  const output = outputClock(), h = await harness('openai', { heartbeatMs: 60000, audioClock: output.clock, gptOutputQuietMs: 80, contextVersion: 'version'.repeat(100) });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    h.upstream!.send(JSON.stringify({ type: 'session.output_audio.delta', delta: Buffer.alloc(144000, 0x11).toString('base64') }));
    await waitFor(() => output.timers.size === 1);
    h.advance(); await refreshClassroom(id,'explicit_navigation');await waitFor(()=>h.sent.some(event=>event.type==='session.thinking.append'));assert.equal(h.sent.filter(event=>event.type==='session.commentary.append').length,1);
    const contexts = h.sent.filter(event => event.type === 'session.thinking.append'), context = contexts.at(-1)!; assert(contexts.length > 1);
    h.upstream!.send(JSON.stringify({ type: 'session.thinking.appended', client_event_id: contexts[0].event_id }));
    finishSpokenInput(socket); await waitFor(() => h.sent.filter(event => event.type === 'session.input_audio.append').length === 12);
    await new Promise(resolve => setTimeout(resolve, 90)); assert.equal(output.timers.size, 0);
    h.upstream!.send(JSON.stringify({ type: 'session.thinking.appended', client_event_id: context.event_id }));
    h.upstream!.send(JSON.stringify({ type: 'session.output_audio.delta', delta: Buffer.alloc(2400, 0x33).toString('base64') }));
    const quietFrame = JSON.stringify({ type: 'session.output_audio.delta', delta: Buffer.alloc(480).toString('base64') });
    for (let i = 0; i < 7; i++) h.upstream!.send(quietFrame);
    h.upstream!.send(JSON.stringify({ type: 'session.output_audio.delta', delta: Buffer.alloc(2400, 0x44).toString('base64') }));
    for (let i = 0; i < 7; i++) h.upstream!.send(quietFrame);
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(output.timers.size, 0);
    assert.equal(h.sent.filter(event => event.type === 'session.commentary.append').length, 1);
    h.upstream!.send(quietFrame);
    await waitFor(() => h.sent.filter(event => event.type === 'session.commentary.append').length === 2);
    assert(String(h.sent.filter(event => event.type === 'session.commentary.append').at(-1)!.content).includes('Say the banana.'));
    h.upstream!.send(JSON.stringify({ type: 'session.output_audio.delta', delta: Buffer.alloc(2400, 0x22).toString('base64') }));
    await waitFor(() => output.timers.size === 1); output.advance(0); await waitFor(() => h.downstream.some(event => event.type === 'audio'));
    const frames = h.downstream.filter(event => event.type === 'audio'); assert.equal(frames.length, 1);
    assert(Buffer.from(String(frames[0].audio), 'base64').every(value => value === 0x22));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(h.sent.filter(event => event.type === 'session.commentary.append').length, 2);
    assert.equal(h.sent.filter(event => event.type === 'session.start').length, 1);
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
  } finally { await h.close(); }
});

test('GPT output gate has a bounded wait and closing it releases every queued frame', async () => {
  const output = outputClock(), h = await harness('openai', { heartbeatMs: 60000, audioClock: output.clock, gptOutputWaitMs: 60 });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    socket.send(pcmFrame(true)); await once(socket, 'close'); await waitFor(() => h.released === 1);
    output.advance(60000); assert.equal(output.timers.size, 0);
    assert(h.downstream.some(event => event.type === 'error')); assert.notEqual(h.upstream?.readyState, WebSocket.OPEN);
  } finally { await h.close(); }
});

test('closing GPT during the recovery quiet window never appends a late recovery cue or opens another session', async () => {
  const h = await harness('openai', { heartbeatMs: 60000, gptOutputQuietMs: 80 });
  try {
    const socket = h.connect(); await once(socket, 'open'); await waitFor(() => h.downstream.some(event => event.type === 'ready'));
    h.advance();await refreshClassroom(id);await waitFor(()=>h.sent.some(event=>event.type==='session.thinking.append'));assert.equal(h.sent.filter(event=>event.type==='session.commentary.append').length,1);
    h.upstream!.send(JSON.stringify({ type: 'session.thinking.appended', client_event_id: h.sent.filter(event => event.type === 'session.thinking.append').at(-1)!.event_id }));
    finishSpokenInput(socket); await waitFor(() => h.sent.filter(event => event.type === 'session.input_audio.append').length === 12);
    for (let i = 0; i < 7; i++) h.upstream!.send(JSON.stringify({ type: 'session.output_audio.delta', delta: Buffer.alloc(480).toString('base64') }));
    socket.send(JSON.stringify({ type: 'close' })); await once(socket, 'close');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(h.sent.filter(event => event.type === 'session.commentary.append').length, 1);
    assert.equal(h.sent.filter(event => event.type === 'session.start').length, 1); assert.equal(h.opened, 1); assert.equal(h.released, 1);
  } finally { await h.close(); }
});


const visionJpeg=Buffer.from([255,216,255,192,0,11,8,0,240,1,64,1,1,17,0,255,217]).toString('base64');
test('authenticated Qwen camera frames use native image append and invalid images keep voice connected',async()=>{
 const h=await harness();try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));
  socket.send(JSON.stringify({type:'vision.start',generation:1}));
  socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(event=>event.type==='input_audio_buffer.append'));
  socket.send(JSON.stringify({type:'vision.frame',generation:1,sequence:1,image:visionJpeg}));
  await waitFor(()=>h.sent.some(event=>event.type==='input_image_buffer.append'));
  assert.equal(h.sent.find(event=>event.type==='input_image_buffer.append')?.image,visionJpeg);
  socket.send(JSON.stringify({type:'vision.frame',generation:1,sequence:2,image:'bad JPEG'}));
  await waitFor(()=>h.downstream.some(event=>event.type==='vision.state'&&event.status==='error'));
  assert.equal(h.released,0);assert.equal(socket.readyState,WebSocket.OPEN);assert(!h.downstream.some(event=>event.type==='error'));
 }finally{await h.close();}
});
test('GPT camera frames go through its observer and only textual observations enter Live',async()=>{
 let called=0;const h=await harness('openai',{observe:async input=>{called++;assert.equal(input.image,visionJpeg);return{visible:true,description:'A blue toy car is visible.'};}});
 try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));
  socket.send(JSON.stringify({type:'vision.start',generation:1}));socket.send(JSON.stringify({type:'vision.frame',generation:1,sequence:1,image:visionJpeg}));
  await acknowledgeSchedulingPlayback(h,socket);quietSchedulingInput(socket);
  await waitFor(()=>h.sent.some(event=>event.type==='session.thinking.append'&&String(event.content).includes('A blue toy car')));
  assert.equal(called,1);assert(!h.sent.some(event=>event.type==='input_image_buffer.append'||JSON.stringify(event).includes(visionJpeg)));
  socket.send(JSON.stringify({type:'vision.stop',generation:1}));await waitFor(()=>h.downstream.some(event=>event.type==='vision.state'&&event.status==='off'));assert.equal(h.released,0);
 }finally{await h.close();}
});

test('vision control messages retain the small non-image message limit',async()=>{
 const h=await harness();try{const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));socket.send(JSON.stringify({type:'vision.start',generation:1,padding:'x'.repeat(40000)}));await waitFor(()=>h.downstream.some(event=>event.type==='error'));assert.equal(h.downstream.find(event=>event.type==='error')?.code,'protocol_error');}finally{await h.close();}
});

test('a recoverable provider image-parameter error stops only vision; unrelated errors still stop voice',async()=>{
 const h=await harness();try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));
  socket.send(JSON.stringify({type:'vision.start',generation:1}));socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(event=>event.type==='input_audio_buffer.append'));
  socket.send(JSON.stringify({type:'vision.frame',generation:1,sequence:1,image:visionJpeg}));await waitFor(()=>h.sent.some(event=>event.type==='input_image_buffer.append'));
  h.upstream!.send(JSON.stringify({type:'error',error:{type:'invalid_request_error',param:'image',code:'invalid_value',message:'private provider text must not be forwarded'}}));
  await waitFor(()=>h.downstream.some(event=>event.type==='vision.state'&&event.status==='error'));assert.equal(h.released,0);assert.equal(socket.readyState,WebSocket.OPEN);assert(!JSON.stringify(h.downstream).includes('private provider text'));
  h.upstream!.send(JSON.stringify({type:'error',error:{type:'invalid_request_error',param:'session.modalities',code:'invalid_value'}}));
  await waitFor(()=>h.released===1&&h.downstream.some(event=>event.type==='error'&&event.code==='provider_error'));
 }finally{await h.close();}
});


test('real vendor WebSocket pong provides teacher RTT separately from browser ping nonce',async t=>{
 for(const provider of ['qwen','openai'] as const)await t.test(provider,async()=>{
  const h=await harness(provider);try{
   const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));
   socket.send(JSON.stringify({type:'ping',nonce:'device_probe_1'}));
   await waitFor(()=>h.downstream.some(event=>event.type==='pong'&&event.nonce==='device_probe_1'));
   await waitFor(()=>h.downstream.some(event=>event.type==='connection.quality'&&event.link==='teacher'&&(event.quality as {status?:string}).status==='good'));
   const event=h.downstream.find(event=>event.type==='connection.quality'&&(event.quality as {status?:string}).status==='good')!;
   assert.equal(typeof (event.quality as {rttMs:unknown}).rttMs,'number');assert.equal(h.released,0);
  }finally{await h.close();}
 });
});
test('a missing provider pong reports poor without terminating the media session',async()=>{
 const h=await harness('qwen',{noAutoPong:true,connectionProbeMs:20,connectionProbeTimeoutMs:30});
 try{const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));
  await waitFor(()=>h.downstream.some(event=>event.type==='connection.quality'&&(event.quality as {status?:string}).status==='poor'));
  assert.equal(socket.readyState,WebSocket.OPEN);assert.equal(h.released,0);assert(!h.downstream.some(event=>event.type==='error'));
 }finally{await h.close();}
});

test('a bounded measurement ping has its own budget and cannot spend the media/control allowance',async()=>{
 const h=await harness();try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));
  for(let i=0;i<24;i++)socket.send(JSON.stringify({type:'ping'}));
  socket.send(JSON.stringify({type:'ping',nonce:'quality_does_not_spend_audio_budget'}));
  await waitFor(()=>h.downstream.some(event=>event.type==='pong'&&event.nonce==='quality_does_not_spend_audio_budget'));
  assert.equal(h.released,0);assert(!h.downstream.some(event=>event.type==='error'));
 }finally{await h.close();}
});

test('excess measurement pings consume the existing bounded message allowance',async()=>{
 const h=await harness();try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));
  for(let i=0;i<100;i++)socket.send(JSON.stringify({type:'ping',nonce:`excess_probe_${i}`}));
  await waitFor(()=>h.released===1);
  assert(h.downstream.some(event=>event.type==='error'&&event.code==='input_rate_limited'));
 }finally{await h.close();}
});

test('published model selection is applied by the server lease rather than a browser parameter',async()=>{
 const h=await harness('openai',{model:'gpt-live-1-synthetic',teachingGuidance:'effectiveLevel=starter; hintLimit=2'});try{const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(event=>event.type==='session.start'));const start=h.sent.find(event=>event.type==='session.start')!;assert.equal((start.session as {model:string}).model,'gpt-live-1-synthetic');h.advance();await refreshClassroom(id);await waitFor(()=>h.sent.some(event=>event.type==='session.thinking.append'&&JSON.stringify(event).includes('effectiveLevel=starter')));socket.close();}finally{await h.close();}
});


test('server-resolved model credentials authenticate upstream without appearing in browser events',async()=>{
 const key='synthetic-private-model-key';
 const h=await harness('openai',{configuration:{key,model:'gpt-live-1',voice:'gleam',childDataReady:true}});
 try{const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));assert.equal(h.capturedAuthorization,`Bearer ${key}`);assert(!JSON.stringify(h.downstream).includes(key));assert(!JSON.stringify(h.sent).includes(key));socket.close();}finally{await h.close();}
});

test('textbook vision is separate from camera, context-bound, and GPT receives only the observation',async()=>{
 let calls=0;const h=await harness('openai',{observe:async input=>{calls++;assert.equal(input.source,'board');return{visible:true,description:'An orange loop surrounds the apple on the textbook.'};}});
 const key=JSON.stringify([id,1,1,'1','page-1','find-apple']);
 try{const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  socket.send(JSON.stringify({type:'board.start',generation:1,contextKey:'stale'}));socket.send(JSON.stringify({type:'board.frame',generation:1,sequence:1,contextKey:'stale',image:visionJpeg}));
  await new Promise(r=>setTimeout(r,20));assert.equal(calls,0);
  socket.send(JSON.stringify({type:'board.start',generation:2,contextKey:key}));socket.send(JSON.stringify({type:'board.frame',generation:2,sequence:1,contextKey:key,image:visionJpeg}));
  await acknowledgeSchedulingPlayback(h,socket);quietSchedulingInput(socket);
  await waitFor(()=>h.sent.some(e=>e.type==='session.thinking.append'&&String(e.content).includes('orange loop')));
  assert.equal(calls,1);assert(!JSON.stringify(h.sent).includes(visionJpeg));
  assert(h.downstream.some(e=>e.type==='board.state'&&e.status==='sharing'));
  socket.send(JSON.stringify({type:'vision.stop',generation:2}));assert.equal(h.released,0);
 }finally{await h.close();}
});
test('Qwen receives textbook images natively, without requiring camera permission or an OpenAI observer',async()=>{
 const h=await harness(),key=JSON.stringify([id,1,1,'1','page-1','find-apple']);
 try{const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));
  socket.send(JSON.stringify({type:'board.start',generation:1,contextKey:key}));socket.send(JSON.stringify({type:'board.frame',generation:1,sequence:1,contextKey:key,image:visionJpeg}));
  await waitFor(()=>h.sent.some(e=>e.type==='input_image_buffer.append'));assert(h.downstream.some(e=>e.type==='board.state'&&e.status==='sharing'));assert.equal(h.released,0);
 }finally{await h.close();}
});

test('Qwen cannot claim an expired textbook image is still a current inspection',async t=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000}),key=JSON.stringify([id,1,1,'1','page-1','find-apple']);
 try{const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));
  h.upstream!.send(JSON.stringify({type:'response.created'}));
  socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));
  socket.send(JSON.stringify({type:'board.start',generation:1,contextKey:key}));socket.send(JSON.stringify({type:'board.frame',generation:1,sequence:1,contextKey:key,image:visionJpeg}));await waitFor(()=>h.downstream.some(e=>e.type==='board.state'&&e.status==='sharing'));
  const later=Date.now()+9000;t.mock.method(Date,'now',()=>later);
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'inspect_current_page',call_id:'old_board',arguments:JSON.stringify({contextKey:`${id}:1:0`,question:'What did I draw?'})}));
  h.upstream!.send(JSON.stringify({type:'response.done'}));
  await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='old_board'));
  const output=h.sent.find(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='old_board')!.item as {output:string};
  assert(!output.output.includes('current labelled textbook image'));
 }finally{t.mock.restoreAll();await h.close();}
});

test('Qwen inspection distinguishes buffered board images from images committed by the learner turn',async t=>{
 for(const committed of [false,true])await t.test(committed?'committed image can be referenced':'buffered image is not claimed consumed',async()=>{
  const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000}),key=JSON.stringify([id,1,1,'1','page-1','find-apple']);
  try{const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));
   socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));
   socket.send(JSON.stringify({type:'board.start',generation:1,contextKey:key}));socket.send(JSON.stringify({type:'board.frame',generation:1,sequence:1,contextKey:key,image:visionJpeg}));await waitFor(()=>h.downstream.some(e=>e.type==='board.state'&&e.status==='sharing'));
   if(committed){h.upstream!.send(JSON.stringify({type:'response.done'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped'}));h.upstream!.send(JSON.stringify({type:'response.created'}));}
   h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'inspect_current_page',call_id:'inspect_board',arguments:JSON.stringify({contextKey:`${id}:1:0`,question:'What did I draw?'})}));h.upstream!.send(JSON.stringify({type:'response.done'}));
   await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='inspect_board'));
   const item=h.sent.find(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='inspect_board')!.item as {output:string};assert.equal(item.output.includes('current labelled textbook image'),committed);
  }finally{await h.close();}
 });
});


test('GPT teacher output is journaled in bounded application segments and flushed before releasing the lease',async()=>{
 const h=await harness('openai');try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  h.upstream!.send(JSON.stringify({type:'session.output_transcript.delta',delta:'Hello, '}));h.upstream!.send(JSON.stringify({type:'session.output_transcript.delta',delta:'what do you like?'}));
  await new Promise(r=>setTimeout(r,20));socket.send(JSON.stringify({type:'close'}));await once(socket,'close');
  const said=h.journal.filter(e=>e.kind==='utterance');assert.equal(said.length,1);assert.equal(said[0].text,'Hello, what do you like?');assert.equal(said[0].actor,'teacher');assert.equal((said[0].details as {boundary:string}).boundary,'application_segment');assert.equal((said[0].details as {playback:string}).playback,'generated');assert.equal(h.journalOrder.at(-1),'closed');
 }finally{await h.close();}
});
test('GPT generated transcript segmentation preserves long speech without changing learner assessment evidence',async()=>{
 const h=await harness('openai');try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  const text='a'.repeat(4000)+'b'.repeat(4000);for(const delta of [text.slice(0,4000),text.slice(4000)])h.upstream!.send(JSON.stringify({type:'session.output_transcript.delta',delta}));
  await new Promise(r=>setTimeout(r,20));socket.send(JSON.stringify({type:'close'}));await once(socket,'close');
  const said=h.journal.filter(e=>e.kind==='utterance');assert.equal(said.map(e=>e.text).join(''),text);assert(said.every(e=>String(e.text).length<=6000));assert.equal(h.transcripts.length,0);
 }finally{await h.close();}
});
test('annotation summaries accept only the current learner action shape and never client-supplied tool facts',async()=>{
 const h=await harness();try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  socket.send(JSON.stringify({type:'interaction',eventId:'10000000-0000-4000-8000-000000000001',contextKey:`${id}:1:0`,action:'draw',strokeCount:1,pointCount:12}));await waitFor(()=>h.journal.some(e=>e.name==='annotation'));
  const drawn=h.journal.find(e=>e.name==='annotation')!;assert.equal(drawn.actor,'child');assert.deepEqual(drawn.details,{contextKey:`${id}:1:0`,action:'draw',strokeCount:1,pointCount:12});
  socket.send(JSON.stringify({type:'interaction',eventId:'10000000-0000-4000-8000-000000000002',contextKey:`${id}:1:0`,action:'draw',strokeCount:1,pointCount:12,actor:'teacher',text:'invented result'}));
  socket.send(JSON.stringify({type:'interaction',eventId:'10000000-0000-4000-8000-000000000003',contextKey:`${id}:1:9`,action:'undo',strokeCount:0,pointCount:12}));await new Promise(r=>setTimeout(r,20));assert.equal(h.journal.filter(e=>e.name==='annotation').length,1);assert.equal(h.released,0);
 }finally{await h.close();}
});
test('unavailable journal storage does not block media forwarding or expose persistence failures',async()=>{
 const h=await harness('qwen',{journal:async()=>{throw new Error('PRIVATE_STORAGE_DETAIL');}});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));assert(!JSON.stringify(h.downstream).includes('PRIVATE_STORAGE_DETAIL'));assert.equal(h.released,0);
 }finally{await h.close();}
});

test('GPT teacher segments flush on text quiet or learner speech, never as student answer evidence',async()=>{
 const h=await harness('openai');try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  h.upstream!.send(JSON.stringify({type:'session.output_transcript.delta',delta:'Look at the apple.'}));await waitFor(()=>h.journal.some(e=>e.text==='Look at the apple.'));
  h.upstream!.send(JSON.stringify({type:'session.output_transcript.delta',delta:'What color is it?'}));await new Promise(r=>setTimeout(r,10));socket.send(pcmFrame(true));
  await waitFor(()=>h.journal.some(e=>e.text==='What color is it?'));assert.equal(h.transcripts.length,0);
 }finally{await h.close();}
});
test('native visual state logs exclude images and deduplicate frame sharing while preserving inspect call IDs',async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000}),key=JSON.stringify([id,1,1,'1','page-1','find-apple']);
 try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));
  socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));
  socket.send(JSON.stringify({type:'board.start',generation:1,contextKey:key}));socket.send(JSON.stringify({type:'board.frame',generation:1,sequence:1,contextKey:key,image:visionJpeg}));await waitFor(()=>h.journal.some(e=>e.name==='board_state'&&(e.details as {state:string}).state==='sharing'));
  h.upstream!.send(JSON.stringify({type:'response.done'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped'}));h.upstream!.send(JSON.stringify({type:'response.created'}));
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'inspect_current_page',call_id:'inspect_journal',arguments:JSON.stringify({contextKey:`${id}:1:0`,question:'What did I draw?'})}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  await waitFor(()=>h.journal.some(e=>e.correlationId==='inspect_journal'));
  const result=h.journal.find(e=>e.correlationId==='inspect_journal')!;assert.equal(result.status,'confirmed');assert.equal((result.details as {resultStatus:string}).resultStatus,'reference');assert(h.tools.some(e=>(e as {callId:string}).callId==='inspect_journal'));assert(h.journal.some(e=>e.name==='board_commit'));assert(!JSON.stringify(h.journal).includes(visionJpeg));
 }finally{await h.close();}
});

test('a stalled journal stays bounded, reports a gap when writable and never stalls media',async()=>{
 let release!:(value:void)=>void,first=true;
 const h=await harness('qwen',{journal:async()=>{if(first){first=false;await new Promise<void>(resolve=>{release=resolve;});}}});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await waitFor(()=>!!release);
  for(let index=0;index<100;index++)h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'unknown_tool',call_id:`unsupported-${index}`,arguments:'{}'}));
  await new Promise(r=>setTimeout(r,20));socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));assert.equal(h.journal.length,1);
  release();await waitFor(()=>h.journal.some(e=>e.name==='journal_gap'));assert(h.journal.length<=66);assert.equal(h.released,0);
 }finally{release?.();await h.close();}
});

test('inspection failures are journaled as safe failed results without exposing storage or provider text',async()=>{
 const h=await harness('qwen',{toolThrows:true});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'inspect_current_page',call_id:'failed_inspection',arguments:JSON.stringify({contextKey:`${id}:1:0`,question:'What did I draw?'})}));
  await waitFor(()=>h.journal.some(e=>e.correlationId==='failed_inspection'));assert.equal(h.journal.find(e=>e.correlationId==='failed_inspection')!.status,'failed');assert(!JSON.stringify(h.journal).includes('PRIVATE_TOOL_DETAIL'));assert.equal(h.released,0);
 }finally{await h.close();}
});

test('a received native final is journaled even when an earlier transcript blocks teaching persistence until stop',async()=>{
 const h=await harness('qwen',{delayedTranscript:true});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'blocked_child',transcript:'Apple.'}));await waitFor(()=>h.transcriptWaiting);
  h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',item_id:'received_teacher',transcript:'You found the apple.'}));
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'capture_marker',call_id:'received_marker',arguments:'{}'}));await waitFor(()=>h.journal.some(e=>e.correlationId==='received_marker'));
  socket.send(JSON.stringify({type:'close'}));await once(socket,'close');
  const said=h.journal.find(e=>e.kind==='utterance'&&e.correlationId==='received_teacher');assert.equal(Boolean(said),true);assert.equal(said!.text,'You found the apple.');assert.equal((said!.details as {boundary:string}).boundary,'provider_final');assert.equal(h.transcripts.length,0);
 }finally{h.resolveTranscript();await h.close();}
});
test('a missing final item ID is generated once and shared by captured log and teaching evidence',async()=>{
 const h=await harness('qwen');try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'A banana.'}));await waitFor(()=>h.transcripts.length===1);
  const evidence=h.transcripts[0] as {itemId?:string};assert.match(evidence.itemId??'',/^[0-9a-f-]{36}$/);
  const said=h.journal.find(e=>e.correlationId===evidence.itemId)!;assert.equal(Boolean(said),true);assert.equal(said.eventKey,`utterance:${createHash('sha256').update(`1:${evidence.itemId}:child`).digest('hex')}`);
 }finally{await h.close();}
});

test('a received final retains its captured old task in the journal when teaching moves on',async()=>{
 const h=await harness('qwen',{delayedTranscript:true});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'pending_first',transcript:'Apple.'}));await waitFor(()=>h.transcriptWaiting);
  h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',item_id:'old_task_teacher',transcript:'That apple is red.'}));h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'capture_marker',call_id:'old_task_marker',arguments:'{}'}));await waitFor(()=>h.journal.some(e=>e.correlationId==='old_task_marker'));
  h.advance();await refreshClassroom(id);
  const said=h.journal.find(e=>e.correlationId==='old_task_teacher')!;assert.equal(Boolean(said),true);assert.equal((said.details as {contextKey:string}).contextKey,`${id}:1:0`);assert.equal(h.transcripts.length,0);
 }finally{h.resolveTranscript();await h.close();}
});

test('transient journal write failure becomes a visible gap after storage recovers',async()=>{
 let failed=false;const stored:Record<string,unknown>[]=[];
 const h=await harness('qwen',{journal:async entry=>{if((entry as {name?:string}).name==='voice_connected'&&!failed){failed=true;throw new Error('PRIVATE_DATABASE_FAILURE');}stored.push(entry as Record<string,unknown>);}});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await waitFor(()=>failed);
  socket.send(JSON.stringify({type:'interaction',eventId:'10000000-0000-4000-8000-000000000011',contextKey:`${id}:1:0`,action:'draw',strokeCount:1,pointCount:2}));await waitFor(()=>stored.some(e=>e.name==='annotation'));
  assert.equal(stored.filter(e=>e.name==='journal_gap').length,1);assert(!JSON.stringify(stored).includes('PRIVATE_DATABASE_FAILURE'));assert.equal(h.released,0);
 }finally{await h.close();}
});
test('persistent journal failure does not schedule endless recovery writes or stop media',async()=>{
 let attempts=0;const h=await harness('qwen',{journal:async()=>{attempts++;throw new Error('PRIVATE_DATABASE_FAILURE');}});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await waitFor(()=>attempts>=1);await new Promise(r=>setTimeout(r,20));const initial=attempts;
  await new Promise(r=>setTimeout(r,20));assert.equal(attempts,initial);
  socket.send(JSON.stringify({type:'interaction',eventId:'10000000-0000-4000-8000-000000000012',contextKey:`${id}:1:0`,action:'undo',strokeCount:0,pointCount:2}));await waitFor(()=>attempts>initial);await new Promise(r=>setTimeout(r,20));const after=attempts;assert(after-initial<=2);
  await new Promise(r=>setTimeout(r,20));assert.equal(attempts,after);socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));assert.equal(h.released,0);
 }finally{await h.close();}
});

test('long provider call IDs stay intact on the native wire while journal identifiers remain bounded',async()=>{
 const h=await harness('qwen'),callId='long-native-call-'.repeat(16),correlationId=createHash('sha256').update(callId).digest('hex');try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'inspect_current_page',call_id:callId,arguments:JSON.stringify({contextKey:`${id}:1:0`,question:'What did I draw?'})}));
  await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id===callId));
  const result=h.journal.find(e=>e.name==='inspect_current_page')!;assert.equal(Boolean(result),true);assert.equal(result.correlationId,correlationId);assert(String(result.eventKey).length<=200);assert(h.tools.some(e=>(e as {callId:string}).callId===callId));
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'unknown_tool',call_id:callId+'x',arguments:'{}'}));await waitFor(()=>h.journal.some(e=>e.name==='unsupported_tool'));
  const rejected=h.journal.find(e=>e.name==='unsupported_tool')!;assert.equal(rejected.correlationId,createHash('sha256').update(callId+'x').digest('hex'));assert(String(rejected.eventKey).length<=200);
 }finally{await h.close();}
});

function nativeHighlight(h:Awaited<ReturnType<typeof harness>>,callId:string){
 h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'highlight_objects',call_id:callId,arguments:JSON.stringify({contextKey:`${id}:1:0`,objectIds:['apple']})}));
}
async function blockSchedulerTranscript(h:Awaited<ReturnType<typeof harness>>){
 h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'scheduler-final',transcript:'Can you show the apple?'}));
 await waitFor(()=>h.transcriptWaiting);
}
async function schedulerBarrier(h:Awaited<ReturnType<typeof harness>>,marker='scheduler-barrier'){
 h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'unsupported_marker',call_id:marker,arguments:'{}'}));
 await waitFor(()=>h.journal.some(e=>e.correlationId===marker));
}
const schedulerResult=(h:Awaited<ReturnType<typeof harness>>,callId:string)=>h.sent.find(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id===callId)?.item as {output:string}|undefined;

test('scheduler bounds pending highlights before transcript persistence and preserves FIFO',async()=>{
 const h=await harness('qwen',{delayedTranscript:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);await blockSchedulerTranscript(h);
  for(const call of ['queued-1','queued-1','queued-2','queued-3','queue-full'])nativeHighlight(h,call);
  await schedulerBarrier(h);assert(h.journal.some(e=>e.correlationId==='queue-full'&&(e.details as {errorCode?:string})?.errorCode==='tool_queue_full'));
  assert.equal(h.tools.length,0);h.resolveTranscript();await waitFor(()=>Boolean(schedulerResult(h,'queued-3')));
  assert.deepEqual(h.tools.map(t=>(t as {callId:string}).callId),['queued-1','queued-2','queued-3']);
  assert.equal(JSON.parse(schedulerResult(h,'queue-full')!.output).status,'unavailable');
  assert.equal(h.downstream.some(e=>e.type==='error'),false);
 }finally{h.resolveTranscript();await h.close();}
});

test('scheduler expires a waiting highlight using the server clock without executing it',async()=>{
 let now=100;const h=await harness('qwen',{delayedTranscript:true,heartbeatMs:60000,toolQueueNow:()=>now});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);await blockSchedulerTranscript(h);
  nativeHighlight(h,'expired-highlight');await schedulerBarrier(h);now=10100;h.resolveTranscript();
  await waitFor(()=>Boolean(schedulerResult(h,'expired-highlight')));assert.equal(h.tools.length,0);
  assert.equal(JSON.parse(schedulerResult(h,'expired-highlight')!.output).status,'unavailable');
  assert(h.journal.some(e=>e.correlationId==='expired-highlight'&&(e.details as {errorCode?:string})?.errorCode==='expired_tool_request'));
  socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));assert.equal(h.released,0);
 }finally{h.resolveTranscript();await h.close();}
});

test('scheduler preserves the captured revision while a highlight waits for evidence',async()=>{
 const h=await harness('qwen',{delayedTranscript:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);await blockSchedulerTranscript(h);
  nativeHighlight(h,'old-revision-highlight');await schedulerBarrier(h);h.feedback();await refreshClassroom(id);h.resolveTranscript();
  await waitFor(()=>Boolean(schedulerResult(h,'old-revision-highlight')));assert.equal(h.tools.length,0);
  assert.equal(JSON.parse(schedulerResult(h,'old-revision-highlight')!.output).status,'unavailable');
  assert(h.journal.some(e=>e.correlationId==='old-revision-highlight'&&(e.details as {errorCode?:string})?.errorCode==='stale_tool_request'));
 }finally{h.resolveTranscript();await h.close();}
});

test('scheduler serializes highlights instead of executing the waiting batch concurrently',async()=>{
 const h=await harness('qwen',{delayedTool:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  nativeHighlight(h,'serial-1');nativeHighlight(h,'serial-2');await schedulerBarrier(h);await waitFor(()=>h.tools.length>0);
  assert.equal(h.tools.length,1);h.resolveTool();await waitFor(()=>h.tools.length===2);h.resolveTool();await waitFor(()=>Boolean(schedulerResult(h,'serial-2')));
  assert.deepEqual(h.tools.map(t=>(t as {callId:string}).callId),['serial-1','serial-2']);
 }finally{h.resolveTool();await h.close();}
});

for(const cause of ['stop','lease','pause','task'] as const)test(`scheduler cancels pending highlights on ${cause}`,async()=>{
 const h=await harness('qwen',{delayedTranscript:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);await blockSchedulerTranscript(h);
  nativeHighlight(h,'cancel-pending');await schedulerBarrier(h);
  if(cause==='stop'){socket.send(JSON.stringify({type:'close'}));await once(socket,'close');}
  else if(cause==='lease'){h.revoke();await refreshClassroom(id);await waitFor(()=>h.released===1);}
  else if(cause==='pause'){h.pause();await refreshClassroom(id);}
  else{h.advance();await refreshClassroom(id);}
  await waitFor(()=>h.journal.some(e=>e.correlationId==='cancel-pending'&&e.status==='rejected'));h.resolveTranscript();await Promise.resolve();assert.equal(h.tools.length,0);
  assert(h.journal.some(e=>e.correlationId==='cancel-pending'&&e.status==='rejected'));
 }finally{h.resolveTranscript();await h.close();}
});

function hasVisualNote(h:Awaited<ReturnType<typeof harness>>,description:string){return h.sent.some(e=>e.type==='session.thinking.append'&&String(e.content).includes(description));}
async function shareSchedulingCamera(socket:WebSocket){socket.send(JSON.stringify({type:'vision.start',generation:1}));socket.send(JSON.stringify({type:'vision.frame',generation:1,sequence:1,image:visionJpeg}));}
function quietSchedulingInput(socket:WebSocket){for(let n=0;n<12;n++)socket.send(pcmFrame(false));}
async function acknowledgeSchedulingPlayback(h:Awaited<ReturnType<typeof harness>>,socket:WebSocket,playbackId?:number){
 await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));const probe=h.downstream.filter(e=>e.type==='playback.probe').at(-1)!;
 const latest=playbackId??Number(h.downstream.filter(e=>e.type==='audio'||e.type==='interrupt').at(-1)?.playbackId??0);
 socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:latest,running:true,audiblePending:false}));
}
test('visual scheduling waits for browser playback and contiguous input silence before appending a camera fact',async()=>{
 const description='SCHEDULING_CAMERA_FACT';const h=await harness('openai',{observe:async()=>({visible:true,description}),heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await shareSchedulingCamera(socket);
  await waitFor(()=>h.downstream.some(e=>e.type==='vision.state'&&e.status==='sharing'));assert.equal(hasVisualNote(h,description),false);
  await acknowledgeSchedulingPlayback(h,socket);socket.send(JSON.stringify({type:'ping',nonce:'scheduler_sync'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='scheduler_sync'));
  assert.equal(hasVisualNote(h,description),false);quietSchedulingInput(socket);await waitFor(()=>hasVisualNote(h,description));
  assert.equal(h.sent.filter(e=>e.type==='session.commentary.append'&&String(e.content).includes(description)).length,1);
  assert.equal(h.journal.some(e=>JSON.stringify(e).includes(description)),false);assert.equal(h.downstream.some(e=>e.type==='error'),false);
 }finally{await h.close();}
});
test('visual scheduling without playback receipts keeps voice usable and does not assume playback from packet delivery',async()=>{
 const description='UNACKNOWLEDGED_CAMERA_FACT';const h=await harness('openai',{observe:async()=>({visible:true,description}),heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await shareSchedulingCamera(socket);
  await waitFor(()=>h.downstream.some(e=>e.type==='vision.state'&&e.status==='sharing'));quietSchedulingInput(socket);
  socket.send(JSON.stringify({type:'playback.state',probeId:'wrong',playbackId:0,running:true,audiblePending:false}));socket.send(JSON.stringify({type:'text',text:'We can still talk.'}));
  await waitFor(()=>h.transcripts.length===1);assert.equal(hasVisualNote(h,description),false);assert.equal(h.released,0);assert.equal(h.downstream.some(e=>e.type==='error'),false);
 }finally{await h.close();}
});
for(const cause of ['stop','task','revision','pause','lease','expiry'] as const)test(`visual scheduling discards pending private observations on ${cause}`,async()=>{
 let now=10000;const description='STALE_PRIVATE_CAMERA_FACT';const h=await harness('openai',{observe:async()=>({visible:true,description}),heartbeatMs:60000,visualNow:()=>now});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await shareSchedulingCamera(socket);
  await waitFor(()=>h.downstream.some(e=>e.type==='vision.state'&&e.status==='sharing'));assert.equal(hasVisualNote(h,description),false);
  if(cause==='stop')socket.send(JSON.stringify({type:'vision.stop',generation:1}));
  else if(cause==='task'){h.advance();await refreshClassroom(id);}
  else if(cause==='revision'){h.feedback();await refreshClassroom(id);}
  else if(cause==='pause'){h.pause();await refreshClassroom(id);}
  else if(cause==='lease'){h.revoke();await refreshClassroom(id);}
  else now=18000;
  if(cause!=='lease'){await acknowledgeSchedulingPlayback(h,socket);quietSchedulingInput(socket);socket.send(JSON.stringify({type:'text',text:'The picture changed.'}));if(cause==='pause'){socket.send(JSON.stringify({type:'ping',nonce:'paused_input_seen'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='paused_input_seen'));assert.equal(h.transcripts.length,0);}else await waitFor(()=>h.transcripts.length>0);}
  else await waitFor(()=>h.released===1);
  assert.equal(hasVisualNote(h,description),false);assert.equal(h.journal.some(e=>JSON.stringify(e).includes(description)),false);
 }finally{await h.close();}
});

test('visual scheduling rejects a receipt from before new voice but permits continuous silent output',async()=>{
 const description='CURRENT_PLAYBACK_CAMERA_FACT',output=outputClock();const h=await harness('openai',{observe:async()=>({visible:true,description}),heartbeatMs:60000,audioClock:output.clock});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));quietSchedulingInput(socket);await shareSchedulingCamera(socket);
  await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));
  const voice=Buffer.alloc(2400);voice.writeInt16LE(2000,2300);h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:voice.toString('base64')}));
  await waitFor(()=>output.timers.size===1);output.advance(0);await waitFor(()=>h.downstream.some(e=>e.type==='audio'));
  assert.equal(h.downstream.find(e=>e.type==='audio')!.playbackId,1);await acknowledgeSchedulingPlayback(h,socket,0);
  await waitFor(()=>h.downstream.filter(e=>e.type==='playback.probe').length===2);assert.equal(hasVisualNote(h,description),false);
  h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(2400).toString('base64')}));
  await waitFor(()=>output.timers.size===1);output.advance(50);await waitFor(()=>h.downstream.filter(e=>e.type==='audio').length===2);
  assert.equal(h.downstream.filter(e=>e.type==='audio').at(-1)!.playbackId,1);await acknowledgeSchedulingPlayback(h,socket,1);
  await waitFor(()=>hasVisualNote(h,description));assert.equal(h.released,0);
 }finally{await h.close();}
});
test('visual scheduling cannot tag a late classifier result with a newer same-task revision',async()=>{
 let resolve!:(value:{visible:boolean;description:string})=>void,calls=0;const description='OLD_CLASSIFIER_RESULT';
 const h=await harness('openai',{observe:()=>{calls++;return new Promise(r=>{resolve=r;});},heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await shareSchedulingCamera(socket);await waitFor(()=>calls===1);
  h.feedback();await refreshClassroom(id);resolve({visible:true,description});quietSchedulingInput(socket);
  socket.send(JSON.stringify({type:'text',text:'The activity feedback changed.'}));await waitFor(()=>h.transcripts.length===1);
  assert.equal(hasVisualNote(h,description),false);assert.equal(h.downstream.some(e=>e.type==='playback.probe'),false);assert.equal(h.released,0);
 }finally{await h.close();}
});

test('visual scheduling never loops playback probes while only the server has queued voice',async()=>{
 const output=outputClock(),h=await harness('openai',{heartbeatMs:60000,audioClock:output.clock,observe:async()=>({visible:true,description:'PROBE_LOOP_FACT'})});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));quietSchedulingInput(socket);
  h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(48000,0x11).toString('base64')}));await waitFor(()=>output.timers.size===1);
  let probes=0;socket.on('message',data=>{const e=JSON.parse(data.toString());if(e.type==='playback.probe'&&++probes<=4)socket.send(JSON.stringify({type:'playback.state',probeId:e.id,playbackId:0,running:true,audiblePending:false}));});
  await shareSchedulingCamera(socket);await waitFor(()=>probes>0);socket.send(JSON.stringify({type:'ping',nonce:'probe_loop_sync'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='probe_loop_sync'));
  assert.equal(probes,1);assert.equal(h.downstream.some(e=>e.type==='error'),false);assert.equal(h.released,0);assert.equal(hasVisualNote(h,'PROBE_LOOP_FACT'),false);
 }finally{await h.close();}
});
for(const phase of ['settling','persisting'] as const)test(`visual scheduling gives the ${phase} learner turn priority over camera commentary`,async()=>{
 const description='FOREGROUND_TURN_CAMERA';const h=await harness('openai',{heartbeatMs:60000,gptOutputQuietMs:80,utteranceSettleMs:phase==='settling'?10000:20,delayedTranscript:phase==='persisting',observe:async()=>({visible:true,description})});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  socket.send(pcmFrame(true));socket.send(pcmFrame(true));await waitFor(()=>h.sent.filter(e=>e.type==='session.input_audio.append').length===2);
  h.upstream!.send(JSON.stringify({type:'session.input_transcript.delta',delta:'Apple.'}));h.upstream!.send(JSON.stringify({type:'session.delegation.created',delegation:{id:'foreground-turn',target:'client'}}));
  await waitFor(()=>h.sent.some(e=>e.delegation_id==='foreground-turn'));
  const gate=h.sent.find(e=>e.type==='session.thinking.append'&&String(e.content).includes('learner is speaking'))!;
  h.upstream!.send(JSON.stringify({type:'session.thinking.appended',client_event_id:gate.event_id}));finishSpokenInput(socket);await waitFor(()=>h.sent.filter(e=>e.type==='session.input_audio.append').length===14);
  for(let n=0;n<9;n++)h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(480).toString('base64')}));
  await waitFor(()=>h.sent.some(e=>e.type==='session.commentary.append'&&String(e.content).includes('Continue naturally')));
  if(phase==='persisting')await waitFor(()=>h.transcriptWaiting);
  await shareSchedulingCamera(socket);await acknowledgeSchedulingPlayback(h,socket);
  socket.send(JSON.stringify({type:'ping',nonce:'foreground_sync'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='foreground_sync'));
  await new Promise(r=>setImmediate(r));assert.equal(h.tools.length,0);assert.equal(h.transcripts.length,0);assert.equal(hasVisualNote(h,description),false);
  if(phase==='persisting'){h.resolveTranscript();await waitFor(()=>h.tools.length===1);await waitFor(()=>hasVisualNote(h,description));}
 }finally{h.resolveTranscript();await h.close();}
});

test('visual scheduling keeps full-scope camera keys compatible with the actual bounded observer adapter',async()=>{
 let called=0;const observer=createOpenAIClassroomVision({apiKey:'non-production-observer',fetch:async(_url,init)=>{called++;const body=JSON.parse(String(init?.body));
  const reference=JSON.parse(String(body.input[0].content[0].text).replace('Untrusted classroom reference data: ',''));assert.equal(reference.contextKey.length,64);
  return Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({visible:true,description:'A red book is visible.'})}]}]});
 }});
 const h=await harness('openai',{observe:observer,heartbeatMs:60000,contextVersion:'v'.repeat(120)});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));h.advance();await refreshClassroom(id);await shareSchedulingCamera(socket);
  await waitFor(()=>h.downstream.some(e=>e.type==='vision.state'&&e.status==='sharing'));assert.equal(called,1);assert.equal(h.released,0);
 }finally{await h.close();}
});

function nativeInspection(h:Awaited<ReturnType<typeof harness>>,callId:string,extra:Record<string,unknown>={}){
 h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'inspect_current_page',call_id:callId,arguments:JSON.stringify({contextKey:`${id}:1:0`,question:'What did I draw?',...extra})}));
}
test('native inspection captures a server request scope, deduplicates and never invents a visual reference',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  nativeInspection(h,'scoped-inspection');nativeInspection(h,'scoped-inspection');await waitFor(()=>Boolean(schedulerResult(h,'scoped-inspection')));
  assert.equal(h.tools.length,1);const tool=h.tools[0] as {request:ClassroomToolRequest};assert(tool.request);assert.equal(tool.request.command.name,'inspect_current_page');
  assert.equal(tool.request.context.stateRevision,1);assert.equal(tool.request.context.courseVersion,'picnic:1');assert.equal(tool.request.source,'teacher');
  assert.equal(JSON.parse(schedulerResult(h,'scoped-inspection')!.output).status,'unavailable');assert.equal(h.downstream.some(e=>e.type==='error'),false);
 }finally{await h.close();}
});
test('inspection with unexpected authority or media is rejected before application execution',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  nativeInspection(h,'invalid-inspection',{score:100,image:'PRIVATE_UNAPPROVED_IMAGE'});await waitFor(()=>Boolean(schedulerResult(h,'invalid-inspection')));
  assert.equal(h.tools.length,0);assert.equal(JSON.parse(schedulerResult(h,'invalid-inspection')!.output).status,'unavailable');assert(!JSON.stringify(h.journal).includes('PRIVATE_UNAPPROVED'));
 }finally{await h.close();}
});
test('inspection waiting for captured transcripts expires instead of receiving a fresh scope at execution',async()=>{
 let now=100;const h=await harness('qwen',{delayedTranscript:true,heartbeatMs:60000,toolQueueNow:()=>now});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);await blockSchedulerTranscript(h);
  nativeInspection(h,'expired-inspection');await schedulerBarrier(h);now=10100;h.resolveTranscript();await waitFor(()=>Boolean(schedulerResult(h,'expired-inspection')));
  assert.equal(h.tools.length,0);assert.equal(JSON.parse(schedulerResult(h,'expired-inspection')!.output).status,'unavailable');
 }finally{h.resolveTranscript();await h.close();}
});
test('a pending inspection cannot borrow a newly committed image from a newer same-task revision',async()=>{
 let now=10000;const h=await harness('qwen',{delayedTool:true,heartbeatMs:60000,visualNow:()=>now});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));
  nativeInspection(h,'revision-inspection');await waitFor(()=>h.tools.length===1);h.feedback();await refreshClassroom(id);now+=1000;
  const contextKey=JSON.stringify([id,1,2,'1','page-1','find-apple']);socket.send(JSON.stringify({type:'board.start',generation:1,contextKey}));socket.send(JSON.stringify({type:'board.frame',generation:1,sequence:1,contextKey,image:visionJpeg}));
  await waitFor(()=>h.sent.some(e=>e.type==='input_image_buffer.append'));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped'}));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  await schedulerBarrier(h);h.resolveTool();await waitFor(()=>Boolean(schedulerResult(h,'revision-inspection')));
  assert.equal(JSON.parse(schedulerResult(h,'revision-inspection')!.output).status,'unavailable');assert.equal(h.downstream.some(e=>e.type==='error'),false);
 }finally{h.resolveTool();await h.close();}
});

test('native highlights and inspections share one bounded FIFO while evidence is persisting',async()=>{
 const h=await harness('qwen',{delayedTranscript:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);await blockSchedulerTranscript(h);
  nativeInspection(h,'mixed-inspect-1');nativeHighlight(h,'mixed-highlight');nativeInspection(h,'mixed-inspect-2');nativeHighlight(h,'mixed-overflow');
  await schedulerBarrier(h);assert.equal(h.tools.length,0);assert(h.journal.some(e=>e.correlationId==='mixed-overflow'&&(e.details as {errorCode?:string}).errorCode==='tool_queue_full'));
  h.resolveTranscript();await waitFor(()=>Boolean(schedulerResult(h,'mixed-inspect-2')));
  assert.deepEqual(h.tools.map(t=>(t as {callId:string}).callId),['mixed-inspect-1','mixed-highlight','mixed-inspect-2']);
  assert.equal(JSON.parse(schedulerResult(h,'mixed-inspect-1')!.output).status,'unavailable');assert.equal(JSON.parse(schedulerResult(h,'mixed-highlight')!.output).status,'confirmed');assert.equal(h.downstream.some(e=>e.type==='error'),false);
 }finally{h.resolveTranscript();await h.close();}
});

for(const phase of ['queued','executing'] as const)test(`inspection received before a board restart cannot borrow its new generation while ${phase}`,async()=>{
 let now=10000;const h=await harness('qwen',{delayedTool:phase==='executing',delayedTranscript:phase==='queued',heartbeatMs:60000,visualNow:()=>now});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));
  const key=JSON.stringify([id,1,1,'1','page-1','find-apple']);
  const commit=async()=>{h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped'}));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));const pong=once(h.upstream!,'pong');h.upstream!.ping('inspection-commit');await pong;};
  socket.send(JSON.stringify({type:'board.start',generation:1,contextKey:key}));socket.send(JSON.stringify({type:'board.frame',generation:1,sequence:1,contextKey:key,image:visionJpeg}));await waitFor(()=>h.sent.filter(e=>e.type==='input_image_buffer.append').length===1);await commit();
  if(phase==='queued')await blockSchedulerTranscript(h);
  nativeInspection(h,'old-board-inspection');if(phase==='executing')await waitFor(()=>h.tools.length===1);else await schedulerBarrier(h);
  socket.send(JSON.stringify({type:'board.stop',generation:1,contextKey:key}));socket.send(JSON.stringify({type:'board.start',generation:2,contextKey:key}));now+=1000;
  socket.send(JSON.stringify({type:'board.frame',generation:2,sequence:1,contextKey:key,image:visionJpeg}));await waitFor(()=>h.sent.filter(e=>e.type==='input_image_buffer.append').length===2);await commit();
  h.resolveTranscript();h.resolveTool();await waitFor(()=>Boolean(schedulerResult(h,'old-board-inspection')));assert.equal(JSON.parse(schedulerResult(h,'old-board-inspection')!.output).status,'unavailable');assert.equal(h.released,0);
 }finally{h.resolveTranscript();h.resolveTool();await h.close();}
});

test('annotation cannot use a legacy key to bypass an invalid complete course scope',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000,contextVersion:'v'.repeat(129)});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);h.advance();await refreshClassroom(id);await settleNativeGreeting(h);
  socket.send(JSON.stringify({type:'interaction',eventId:'10000000-0000-4000-8000-000000000041',contextKey:`${id}:1:1`,action:'draw',strokeCount:1,pointCount:12}));socket.send(JSON.stringify({type:'ping',nonce:'invalid_annotation_scope'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='invalid_annotation_scope'));
  assert.equal(h.journal.some(e=>e.name==='annotation'),false);assert.equal(h.released,0);
 }finally{await h.close();}
});

function nativeSpoken(h:Awaited<ReturnType<typeof harness>>,callId:string,extra:Record<string,unknown>={}){
 h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'submit_spoken_answer',call_id:callId,arguments:JSON.stringify({contextKey:`${id}:1:0`,answer:'Apple.',...extra})}));
}
for(const mode of ['receipt','missing','wrong'] as const)test(`native spoken task advancement requires its own application receipt: ${mode}`,async()=>{
 const h=await harness('qwen',{spokenAdvance:mode,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'scoped-spoken-evidence',transcript:'Apple.'}));await waitFor(()=>h.transcripts.length===1);nativeSpoken(h,'scoped-spoken');
  await waitFor(()=>Boolean(schedulerResult(h,'scoped-spoken')));const called=h.tools[0] as {request?:ClassroomToolRequest};assert(called.request);assert.equal(called.request.command.name,'submit_spoken_answer');
  assert.equal(JSON.parse(schedulerResult(h,'scoped-spoken')!.output).status,mode==='receipt'?'confirmed':'unavailable');assert.equal(h.downstream.some(e=>e.type==='error'),false);
 }finally{await h.close();}
});
test('native spoken requests share bounds, deduplication and expiry with the other two tools',async()=>{
 let now=100;const h=await harness('qwen',{delayedTranscript:true,heartbeatMs:60000,toolQueueNow:()=>now});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);await blockSchedulerTranscript(h);
  nativeSpoken(h,'queued-spoken');nativeSpoken(h,'queued-spoken');nativeHighlight(h,'queued-mark');nativeInspection(h,'queued-see');nativeSpoken(h,'overflow-spoken');await schedulerBarrier(h);
  assert(h.journal.some(e=>e.correlationId==='overflow-spoken'&&(e.details as {errorCode?:string}).errorCode==='tool_queue_full'));now=10100;h.resolveTranscript();await waitFor(()=>Boolean(schedulerResult(h,'queued-spoken')));
  assert.equal(h.tools.length,0);assert.equal(JSON.parse(schedulerResult(h,'queued-spoken')!.output).status,'unavailable');assert.equal(h.released,0);
 }finally{h.resolveTranscript();await h.close();}
});

test('native spoken requests reject caller-supplied assessment authority before application execution',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);nativeSpoken(h,'invalid-spoken',{score:100,execution:{type:'tool.advance'}});await waitFor(()=>Boolean(schedulerResult(h,'invalid-spoken')));
  assert.equal(h.tools.length,0);assert.equal(JSON.parse(schedulerResult(h,'invalid-spoken')!.output).status,'unavailable');assert.equal(h.released,0);
 }finally{await h.close();}
});

test('final text cannot reuse a legacy key when complete course scope is invalid',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000,contextVersion:'v'.repeat(129)});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);h.advance();await refreshClassroom(id);await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'invalid-scope-final',transcript:'I like apples.'}));await schedulerBarrier(h);assert.equal(h.transcripts.length,0);assert.equal(h.journal.some(e=>e.correlationId==='invalid-scope-final'),false);assert.equal(h.released,0);
 }finally{await h.close();}
});

test('a late native learner final keeps its captured starting task without becoming current evidence',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started'}));await schedulerBarrier(h,'speech-scope-captured');h.advance();await refreshClassroom(id);
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'late-old-final',transcript:'I like apples.'}));await schedulerBarrier(h,'old-final-observed');
  const said=h.journal.find(e=>e.correlationId==='late-old-final');assert(said);assert.equal((said.details as {contextKey:string}).contextKey,`${id}:1:0`);assert.equal((said.details as {boundary:string}).boundary,'provider_final');assert.equal(h.transcripts.length,0);assert.equal(h.tools.length,0);assert.equal(h.released,0);
 }finally{await h.close();}
});

for(const created of ['before-task-change','after-task-change'] as const)test(`a late native teacher final keeps its response starting task with created ${created}`,async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));
  const start=async()=>{h.upstream!.send(JSON.stringify({type:'response.created'}));const pong=once(h.upstream!,'pong');h.upstream!.ping('teacher-start-scope');await pong;};
  if(created==='before-task-change')await start();h.advance();await refreshClassroom(id);if(created==='after-task-change')await start();h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',item_id:'late-old-teacher',transcript:'This old task asks for the apple.'}));await schedulerBarrier(h,'late-teacher-observed');
  const said=h.journal.find(e=>e.correlationId==='late-old-teacher');assert(said);assert.equal((said.details as {contextKey:string}).contextKey,`${id}:1:0`);assert.equal(h.transcripts.length,0);assert.equal(h.tools.length,0);
 }finally{await h.close();}
});

test('a late native VAD teacher final keeps the learner turn starting task',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped'}));await schedulerBarrier(h,'vad-scope-started');h.advance();await refreshClassroom(id);
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',item_id:'late-vad-teacher',transcript:'This reply belongs to the earlier learner turn.'}));await schedulerBarrier(h,'late-vad-observed');
  const said=h.journal.find(e=>e.correlationId==='late-vad-teacher');assert(said);assert.equal((said.details as {contextKey:string}).contextKey,`${id}:1:0`);assert.equal(h.transcripts.length,0);
 }finally{await h.close();}
});

test('GPT typed delegation captures full scope and the persisted input identity before executing',async()=>{
 const h=await harness('openai',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));socket.send(JSON.stringify({type:'text',text:'I like apples.'}));await waitFor(()=>h.tools.length===1);await waitFor(()=>h.sent.some(e=>e.type==='session.commentary.append'));
  const tool=h.tools[0] as {name:string;args:unknown;request?:ClassroomToolRequest};assert(tool.request);assert.equal(tool.request.source,'application');assert.equal(tool.request.command.name,'delegate');assert.equal(tool.request.context.stateRevision,1);
  const evidence=h.transcripts[0] as {itemId:string};assert.deepEqual(tool.args,{contextKey:`${id}:1:0`,evidenceItemId:evidence.itemId});assert.equal(h.downstream.some(e=>e.type==='error'),false);
  await waitFor(()=>h.sent.some(e=>e.type==='session.commentary.append'));assert(h.sent.filter(e=>e.type==='session.commentary.append').every(e=>!e.delegation_id));
 }finally{await h.close();}
});
for(const change of ['expiry','revision'] as const)test(`GPT completed input cannot receive a fresh request scope after waiting: ${change}`,async()=>{
 let now=100;const h=await harness('openai',{delayedTranscript:true,heartbeatMs:60000,toolQueueNow:()=>now});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));socket.send(JSON.stringify({type:'text',text:'Can you show the apple?'}));await waitFor(()=>h.transcriptWaiting);
  if(change==='expiry')now=10100;else{h.feedback();await refreshClassroom(id);}h.resolveTranscript();socket.send(JSON.stringify({type:'ping',nonce:'delegation_wait_finished'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='delegation_wait_finished'));
  await waitFor(()=>h.journal.some(e=>e.name==='delegate'&&(e.details as {errorCode?:string}).errorCode===(change==='expiry'?'expired_tool_request':'stale_tool_request')));assert.equal(h.tools.length,0);assert.equal(h.released,0);
 }finally{h.resolveTranscript();await h.close();}
});
test('GPT completed inputs execute serially instead of running competing checks in parallel',async()=>{
 const h=await harness('openai',{delayedTool:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));socket.send(JSON.stringify({type:'text',text:'I like apples.'}));await waitFor(()=>h.tools.length===1);
  await new Promise(resolve=>setTimeout(resolve,510));socket.send(JSON.stringify({type:'text',text:'I like bananas.'}));await waitFor(()=>h.transcripts.length===2);socket.send(JSON.stringify({type:'ping',nonce:'second_input_waiting'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='second_input_waiting'));
  assert.equal(h.tools.length,1);h.resolveTool();await waitFor(()=>h.tools.length===2);h.resolveTool();await waitFor(()=>h.sent.filter(e=>e.type==='session.thinking.append'&&String(e.content).includes('verifiedApplicationResult')).length===2);assert.equal(h.released,0);
 }finally{h.resolveTool();await h.close();}
});

test('a queued GPT check waits for final inputs added while the first transcript is saving',async()=>{
 const h=await harness('openai',{delayedTranscript:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));socket.send(JSON.stringify({type:'text',text:'I like apples.'}));await waitFor(()=>h.transcriptWaiting);
  await new Promise(resolve=>setTimeout(resolve,510));socket.send(JSON.stringify({type:'text',text:'I like bananas.'}));socket.send(JSON.stringify({type:'ping',nonce:'both_inputs_received'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='both_inputs_received'));
  h.resolveTranscript();await waitFor(()=>h.transcripts.length===1);socket.send(JSON.stringify({type:'ping'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&!e.nonce));assert.equal(h.tools.length,0);
  h.resolveTranscript();await waitFor(()=>h.transcripts.length===2);await waitFor(()=>h.tools.length===2);assert.equal(h.released,0);
 }finally{h.resolveTranscript();await h.close();}
});

test('a repeated GPT handoff waiting for persistence cannot consume the next completed learner turn',async()=>{
 const h=await harness('openai',{delayedTranscript:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  socket.send(pcmFrame(true));socket.send(pcmFrame(true));await waitFor(()=>h.sent.filter(e=>e.type==='session.input_audio.append').length===2);
  h.upstream!.send(JSON.stringify({type:'session.input_transcript.delta',delta:'Apple.'}));h.upstream!.send(JSON.stringify({type:'session.delegation.created',delegation:{id:'same-handoff',target:'client'}}));finishSpokenInput(socket);await waitFor(()=>h.transcriptWaiting);
  h.upstream!.send(JSON.stringify({type:'session.delegation.created',delegation:{id:'same-handoff',target:'client'}}));h.upstream!.send(JSON.stringify({type:'session.delegation.created',delegation:{id:'next-handoff',target:'client'}}));const pong=once(h.upstream!,'pong');h.upstream!.ping('queued-handoffs');await pong;
  await new Promise(resolve=>setTimeout(resolve,1010));socket.send(pcmFrame(true));socket.send(pcmFrame(true));await waitFor(()=>h.sent.filter(e=>e.type==='session.input_audio.append').length===16);
  h.upstream!.send(JSON.stringify({type:'session.input_transcript.delta',delta:'Banana.'}));finishSpokenInput(socket);await waitFor(()=>h.journal.filter(e=>e.kind==='utterance'&&e.actor==='child').length===2);
  h.resolveTranscript();await waitFor(()=>h.transcripts.length===1);socket.send(JSON.stringify({type:'ping'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&!e.nonce));h.resolveTranscript();await waitFor(()=>h.transcripts.length===2);await waitFor(()=>h.tools.length===2);
  assert.deepEqual(h.tools.map(tool=>(tool as {callId:string}).callId),['same-handoff','next-handoff']);assert.equal(h.released,0);
 }finally{h.resolveTranscript();await h.close();}
});

test('an obsolete GPT application result settles its handoff without starting new commentary',async()=>{
 const h=await harness('openai',{delayedTool:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));socket.send(JSON.stringify({type:'text',text:'I like apples.'}));await waitFor(()=>h.tools.length===1);
  h.advance();await refreshClassroom(id);socket.send(JSON.stringify({type:'ping',nonce:'new_task_seen'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='new_task_seen'));const count=h.sent.filter(e=>e.type==='session.commentary.append').length;
  h.resolveTool();await waitFor(()=>h.sent.some(e=>e.type==='session.thinking.append'&&String(e.content).includes('verifiedApplicationResult')));assert.equal(h.sent.filter(e=>e.type==='session.commentary.append').length,count);assert.equal(h.released,0);
 }finally{h.resolveTool();await h.close();}
});

for(const output of ['confirmed','unavailable'] as const)test(`an earlier GPT input cannot speak over a newer completed input even with ${output} result`,async()=>{
 const h=await harness('openai',{delayedTool:true,delegationOutput:output,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));socket.send(JSON.stringify({type:'text',text:'I like apples.'}));await waitFor(()=>h.tools.length===1);
  await new Promise(resolve=>setTimeout(resolve,510));socket.send(JSON.stringify({type:'text',text:'Actually, I like bananas.'}));await waitFor(()=>h.transcripts.length===2);const count=h.sent.filter(e=>e.type==='session.commentary.append').length;
  h.resolveTool();await waitFor(()=>h.tools.length===2);const pong=once(h.upstream!,'pong');h.upstream!.ping('old-input-settled');await pong;
  assert.equal(h.sent.filter(e=>e.type==='session.commentary.append').length,count);assert.equal(h.released,0);
 }finally{h.resolveTool();await h.close();}
});

for(const mode of ['receipt','missing','wrong'] as const)test(`GPT application task advancement preserves latest-input checks with ${mode} receipt`,async()=>{
 const h=await harness('openai',{delegationAdvance:mode,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));const greeting=once(h.upstream!,'pong');h.upstream!.ping('gpt-greeting-settled');await greeting;
  const baseline=h.sent.filter(e=>e.type==='session.commentary.append').length;socket.send(JSON.stringify({type:'text',text:'Apple.'}));
  await waitFor(()=>h.sent.some(e=>e.type==='session.thinking.append'&&String(e.content).includes('verifiedApplicationResult')));const result=h.sent.find(e=>e.type==='session.thinking.append'&&String(e.content).includes('verifiedApplicationResult'))!;
  assert.equal(JSON.parse(String(result.content)).verifiedApplicationResult.status,mode==='receipt'?'confirmed':'unavailable');
  const pong=once(h.upstream!,'pong');h.upstream!.ping('advance-result-settled');await pong;
  assert.equal(h.sent.filter(e=>e.type==='session.commentary.append').length,baseline+(mode==='receipt'?1:0));assert.equal(h.released,0);
 }finally{await h.close();}
});

async function requestNativeChalk(h:Awaited<ReturnType<typeof harness>>,callId:string){
 h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'I do not understand. Can you help?',item_id:`${callId}-child`}));
 await waitFor(()=>h.transcripts.some(event=>(event as {itemId?:string}).itemId===`${callId}-child`));
 h.upstream!.send(JSON.stringify({type:'response.created'}));
 h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',item_id:`${callId}-teacher`,transcript:'You can say that you like the apples.'}));
 h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));
 h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'chalk_write',call_id:callId,arguments:JSON.stringify({contextKey:`${id}:1:0`,text:'I like apples.',seconds:8})}));
 h.upstream!.send(JSON.stringify({type:'response.done'}));
 await waitFor(()=>h.downstream.some(event=>event.type==='playback.probe'));
 return {probe:h.downstream.findLast(event=>event.type==='playback.probe')!,audio:h.downstream.findLast(event=>event.type==='audio')!};
}
async function startNativeChalk(h:Awaited<ReturnType<typeof harness>>,socket:WebSocket,callId:string){
 const {probe,audio}=await requestNativeChalk(h,callId);
 socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));
 await waitFor(()=>h.downstream.some(event=>event.type==='chalk.offer'));
 return h.downstream.findLast(event=>event.type==='chalk.offer')!;
}
test('native chalk cannot claim display until explanation playback and current browser DOM receipts',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));await settleNativeGreeting(h);
  const offer=await startNativeChalk(h,socket,'chalk-visible');assert(!h.sent.some(event=>event.type==='conversation.item.create'&&(event.item as {call_id?:string})?.call_id==='chalk-visible'));
  socket.send(JSON.stringify({type:'chalk.displayed',id:offer.id}));socket.send(JSON.stringify({type:'chalk.ready',id:offer.id}));await waitFor(()=>h.downstream.some(event=>event.type==='chalk.commit'));
  assert(!h.sent.some(event=>event.type==='conversation.item.create'&&(event.item as {call_id?:string})?.call_id==='chalk-visible'));
  socket.send(JSON.stringify({type:'chalk.displayed',id:offer.id}));await waitFor(()=>h.sent.some(event=>event.type==='conversation.item.create'&&(event.item as {call_id?:string})?.call_id==='chalk-visible'));
  const result=h.sent.find(event=>event.type==='conversation.item.create'&&(event.item as {call_id?:string})?.call_id==='chalk-visible')!.item as {output:string};assert.equal(JSON.parse(result.output).status,'confirmed');assert.equal(h.tools.length,1);
  assert(!JSON.stringify(h.journal).includes('I like apples.'));
 }finally{await h.close();}
});
test('a chalk proposal without a completed oral explanation is unavailable and keeps voice connected',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'chalk_write',call_id:'no-rephrase',arguments:JSON.stringify({contextKey:`${id}:1:0`,text:'Apple.',seconds:8})}));
  await waitFor(()=>h.sent.some(event=>event.type==='conversation.item.create'&&(event.item as {call_id?:string})?.call_id==='no-rephrase'));
  const result=h.sent.find(event=>event.type==='conversation.item.create'&&(event.item as {call_id?:string})?.call_id==='no-rephrase')!.item as {output:string};assert.equal(JSON.parse(result.output).status,'unavailable');assert(!h.downstream.some(event=>event.type==='chalk.offer'));assert(!h.downstream.some(event=>event.type==='error'));
  await waitFor(()=>h.journal.some(event=>event.name==='chalk_write'&&(event.details as {resultStatus?:string})?.resultStatus==='unavailable'));const rejected=h.journal.find(event=>event.name==='chalk_write'&&(event.details as {resultStatus?:string})?.resultStatus==='unavailable');assert.equal((rejected?.details as {errorCode?:string})?.errorCode,'chalk_oral_reference_missing');assert.equal((rejected?.details as {state?:string})?.state,'response_unbound');
 }finally{await h.close();}
});
test('a revoked lease after chalk offer cannot return a confirmed display',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));await settleNativeGreeting(h);
  const offer=await startNativeChalk(h,socket,'chalk-revoked');socket.send(JSON.stringify({type:'chalk.ready',id:offer.id}));await waitFor(()=>h.downstream.some(event=>event.type==='chalk.commit'));h.revoke();socket.send(JSON.stringify({type:'chalk.displayed',id:offer.id}));await waitFor(()=>h.downstream.some(event=>event.type==='closed'));
  assert(!h.sent.some(event=>event.type==='conversation.item.create'&&(event.item as {call_id?:string;output?:string})?.call_id==='chalk-revoked'&&JSON.parse((event.item as {output:string}).output).status==='confirmed'));
 }finally{await h.close();}
});


test('new learner speech withdraws an in-flight chalk offer and late display receipts are harmless',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));await settleNativeGreeting(h);
  const offer=await startNativeChalk(h,socket,'chalk-interrupted');h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started'}));
  await waitFor(()=>h.downstream.some(event=>event.type==='chalk.clear'&&event.id===offer.id));socket.send(JSON.stringify({type:'chalk.ready',id:offer.id}));socket.send(JSON.stringify({type:'chalk.displayed',id:offer.id}));
  await waitFor(()=>h.sent.some(event=>event.type==='conversation.item.create'&&(event.item as {call_id?:string})?.call_id==='chalk-interrupted'));
  const result=h.sent.find(event=>event.type==='conversation.item.create'&&(event.item as {call_id?:string})?.call_id==='chalk-interrupted')!.item as {output:string};assert.equal(JSON.parse(result.output).status,'unavailable');assert(!h.downstream.some(event=>event.type==='chalk.commit'));assert(!h.downstream.some(event=>event.type==='error'));
 }finally{await h.close();}
});
test('a wrong playback sequence refuses chalk without damaging the voice transport',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));await settleNativeGreeting(h);
  const {probe,audio}=await requestNativeChalk(h,'chalk-wrong-playback');socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:Number(audio.playbackId)+1,running:true,audiblePending:false}));
  await waitFor(()=>h.sent.some(event=>event.type==='conversation.item.create'&&(event.item as {call_id?:string})?.call_id==='chalk-wrong-playback'));assert(!h.downstream.some(event=>event.type==='chalk.offer'));assert(!h.downstream.some(event=>event.type==='error'));
 }finally{await h.close();}
});

test('new chalk oral proof must not borrow buffered audio from an earlier response',async()=>{
 const output=outputClock(),h=await harness('qwen',{delayedResponses:true,audioClock:output.clock,heartbeatMs:60000});
 const barrier=async()=>{const done=once(h.upstream!,'pong');h.upstream!.ping('review-barrier');await done;};
 try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));await barrier();
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'Please help me.',item_id:'review-child'}));await waitFor(()=>h.transcripts.length===1);
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(4800,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done'}));await barrier();
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',transcript:'A silent newer explanation.',item_id:'review-teacher'}));
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'chalk_write',call_id:'review-borrow-audio',arguments:JSON.stringify({contextKey:`${id}:1:0`,text:'I like apples.',seconds:8})}));h.upstream!.send(JSON.stringify({type:'response.done'}));await barrier();await waitFor(()=>h.tools.length===1);
  output.advance(500);
  await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='review-borrow-audio')||h.downstream.some(e=>e.type==='playback.probe'));
  if(h.downstream.some(e=>e.type==='playback.probe')){
  const probe=h.downstream.findLast(e=>e.type==='playback.probe')!,audio=h.downstream.findLast(e=>e.type==='audio')!;
  socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));
  await waitFor(()=>h.downstream.some(e=>e.type==='chalk.offer'));
  }
  assert.equal(h.downstream.some(e=>e.type==='chalk.offer'),false);
 }finally{await h.close();}
});

test('malformed audio after a current chalk explanation start closes safely instead of reading odd PCM',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(event=>event.type==='ready'));await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'Please explain.',item_id:'chalk-bad-audio-child'}));await waitFor(()=>h.transcripts.length===1);
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:'AA=='}));
  await waitFor(()=>h.downstream.some(event=>event.type==='error'));assert(!h.downstream.some(event=>event.type==='chalk.offer'));
 }finally{await h.close();}
});

test('child input after DOM display must not erase the existing chalk',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await waitFor(()=>h.sent.some(e=>e.type==='response.create'));const greeting=once(h.upstream!,'pong');h.upstream!.ping('greeting');await greeting;
  const offer=await startNativeChalk(h,socket,'review-displayed-child');socket.send(JSON.stringify({type:'chalk.ready',id:offer.id}));await waitFor(()=>h.downstream.some(e=>e.type==='chalk.commit'));
  h.delayNextHeartbeat();const calls=h.heartbeatCalls;socket.send(JSON.stringify({type:'chalk.displayed',id:offer.id}));await waitFor(()=>h.heartbeatCalls>calls);
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'I like apples.',item_id:'review-next-child'}));await waitFor(()=>h.transcripts.some(e=>(e as {itemId?:string}).itemId==='review-next-child'));
  h.releaseHeartbeat();await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='review-displayed-child'));
  socket.send(JSON.stringify({type:'ping',nonce:'review-display-sealed'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='review-display-sealed'));
  const clears=h.downstream.filter(e=>e.type==='chalk.clear'&&e.id===offer.id).length;assert.equal(clears,0);
 }finally{h.releaseHeartbeat();await h.close();}
});

async function prepareGptChalk(h:Awaited<ReturnType<typeof harness>>){
 const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
 const pong=once(h.upstream!,'pong');h.upstream!.ping('gpt-chalk-greeting');await pong;
 socket.send(JSON.stringify({type:'text',text:'I not know. Please help.'}));
 await waitFor(()=>h.sent.some(e=>e.type==='session.thinking.append'&&String(e.content).includes('optionalChalkReference')));
 const arm=h.sent.findLast(e=>e.type==='session.thinking.append'&&String(e.content).includes('optionalChalkReference'))!;
 return{socket,arm};
}
async function explainGptChalk(h:Awaited<ReturnType<typeof harness>>,socket:WebSocket,arm:Record<string,unknown>,text='You could say: I like apples.'){
 h.upstream!.send(JSON.stringify({type:'session.thinking.appended',client_event_id:arm.event_id}));
 h.upstream!.send(JSON.stringify({type:'session.output_transcript.delta',delta:text.slice(0,15)}));h.upstream!.send(JSON.stringify({type:'session.output_transcript.delta',delta:text.slice(15)}));
 h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));
 for(let i=0;i<5;i++)h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(4800).toString('base64')}));
 finishSpokenInput(socket);
}
test('GPT chalk uses a bound backend proposal, its own oral reference and current display receipts',async()=>{
 const h=await harness('openai',{gptChalk:true,delegationOutput:'retry',heartbeatMs:60000});try{
  const {socket,arm}=await prepareGptChalk(h);assert.equal(h.tools.length,1);assert(!h.downstream.some(e=>e.type==='chalk.offer'));
  await explainGptChalk(h,socket,arm);await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));
  const probe=h.downstream.findLast(e=>e.type==='playback.probe')!,audio=h.downstream.findLast(e=>e.type==='audio')!;
  socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));await waitFor(()=>h.downstream.some(e=>e.type==='chalk.offer'));
  const offer=h.downstream.findLast(e=>e.type==='chalk.offer')!;socket.send(JSON.stringify({type:'chalk.ready',id:offer.id}));await waitFor(()=>h.downstream.some(e=>e.type==='chalk.commit'));socket.send(JSON.stringify({type:'chalk.displayed',id:offer.id}));
  await waitFor(()=>h.journal.some(e=>e.name==='chalk_write'&&e.status==='confirmed'));
  assert.equal(h.tools.length,2);const chalkTool=h.tools[1] as {request:ClassroomToolRequest};assert.equal(chalkTool.request.source,'application');assert.equal(chalkTool.request.command.name,'chalk_write');assert('evidenceItemId' in chalkTool.request.command.arguments);assert.equal(h.released,0);
  assert(!h.sent.some(e=>e.type==='session.commentary.append'&&String(e.content).includes('browser reports')));
 }finally{await h.close();}
});
for(const missing of ['ack','reference','voice','silence'] as const)test(`GPT chalk cannot borrow a missing ${missing} from older output`,async()=>{
 const h=await harness('openai',{gptChalk:true,delegationOutput:'retry',heartbeatMs:60000});try{
  const {socket,arm}=await prepareGptChalk(h);
  if(missing!=='ack')h.upstream!.send(JSON.stringify({type:'session.thinking.appended',client_event_id:arm.event_id}));
  h.upstream!.send(JSON.stringify({type:'session.output_transcript.delta',delta:missing==='reference'?'You could say something else.':'I like apples.'}));
  if(missing!=='voice')h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));
  if(missing!=='silence')for(let i=0;i<5;i++)h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(4800).toString('base64')}));finishSpokenInput(socket);
  const pong=once(h.upstream!,'pong');h.upstream!.ping('missing-proof');await pong;await new Promise(resolve=>setTimeout(resolve,130));assert.equal(h.tools.length,1);assert(!h.downstream.some(e=>e.type==='chalk.offer'));assert.equal(h.released,0);
 }finally{await h.close();}
});
test('GPT chalk is withdrawn on new learner speech before late display receipts',async()=>{
 const h=await harness('openai',{gptChalk:true,delegationOutput:'retry',heartbeatMs:60000});try{
  const {socket,arm}=await prepareGptChalk(h);await explainGptChalk(h,socket,arm);await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));const probe=h.downstream.findLast(e=>e.type==='playback.probe')!,audio=h.downstream.findLast(e=>e.type==='audio')!;
  socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));await waitFor(()=>h.downstream.some(e=>e.type==='chalk.offer'));const offer=h.downstream.findLast(e=>e.type==='chalk.offer')!;
  socket.send(pcmFrame(true));await waitFor(()=>h.downstream.some(e=>e.type==='chalk.clear'&&e.id===offer.id));socket.send(JSON.stringify({type:'chalk.ready',id:offer.id}));socket.send(JSON.stringify({type:'chalk.displayed',id:offer.id}));await waitFor(()=>h.journal.some(e=>e.name==='chalk_write'&&e.status==='rejected'));assert(!h.downstream.some(e=>e.type==='chalk.commit'));assert.equal(h.released,0);
 }finally{await h.close();}
});
for(const badChalk of ['input','scope'] as const)test(`GPT chalk rejects a backend candidate with mismatched ${badChalk}`,async()=>{
 const h=await harness('openai',{gptChalk:true,badChalk,delegationOutput:'retry',heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));socket.send(JSON.stringify({type:'text',text:'Please help.'}));await waitFor(()=>h.sent.some(e=>e.type==='session.thinking.append'&&String(e.content).includes('verifiedApplicationResult')));const pong=once(h.upstream!,'pong');h.upstream!.ping('bad-candidate');await pong;
  assert(!h.sent.some(e=>String(e.content).includes('optionalChalkReference')));assert.equal(h.tools.length,1);assert.equal(h.released,0);
 }finally{await h.close();}
});

test('GPT chalk cannot reuse a quiet receipt if teacher speech resumes during the final PG check',async()=>{
 const h=await harness('openai',{gptChalk:true,delegationOutput:'retry',heartbeatMs:60000});try{
  const {socket,arm}=await prepareGptChalk(h);await explainGptChalk(h,socket,arm);await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));
  const probe=h.downstream.findLast(e=>e.type==='playback.probe')!,audio=h.downstream.findLast(e=>e.type==='audio')!;h.delayNextHeartbeat();const calls=h.heartbeatCalls;
  socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));await waitFor(()=>h.heartbeatCalls>calls);
  h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));const pong=once(h.upstream!,'pong');h.upstream!.ping('teacher-resumed-before-offer');await pong;h.releaseHeartbeat();
  await waitFor(()=>h.downstream.some(e=>e.type==='chalk.offer')||h.journal.some(e=>e.name==='chalk_write'&&e.status==='rejected'));assert(!h.downstream.some(e=>e.type==='chalk.offer'));assert.equal(h.released,0);
 }finally{h.releaseHeartbeat();await h.close();}
});

for(const phase of ['offered','committed','displayed'] as const)test(`GPT chalk preserves only already displayed writing after teacher resumes: ${phase}`,async()=>{
 const h=await harness('openai',{gptChalk:true,delegationOutput:'retry',heartbeatMs:60000});try{
  const {socket,arm}=await prepareGptChalk(h);await explainGptChalk(h,socket,arm);await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));
  const probe=h.downstream.findLast(e=>e.type==='playback.probe')!,audio=h.downstream.findLast(e=>e.type==='audio')!;
  socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));await waitFor(()=>h.downstream.some(e=>e.type==='chalk.offer'));const offer=h.downstream.findLast(e=>e.type==='chalk.offer')!;
  if(phase!=='offered'){socket.send(JSON.stringify({type:'chalk.ready',id:offer.id}));await waitFor(()=>h.downstream.some(e=>e.type==='chalk.commit'));}
  if(phase==='displayed'){socket.send(JSON.stringify({type:'chalk.displayed',id:offer.id}));await waitFor(()=>h.journal.some(e=>e.name==='chalk_write'&&e.status==='confirmed'));}
  const audioCount=h.downstream.filter(e=>e.type==='audio').length;
  h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));const pong=once(h.upstream!,'pong');h.upstream!.ping('new-teacher-voice');await pong;
  socket.send(JSON.stringify({type:'ping',nonce:'review-new-voice-sealed'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='review-new-voice-sealed'));
  const cleared=h.downstream.some(e=>e.type==='chalk.clear'&&e.id===offer.id);assert.equal(cleared,phase!=='displayed');
  if(phase!=='displayed'){socket.send(JSON.stringify({type:'chalk.ready',id:offer.id}));socket.send(JSON.stringify({type:'chalk.displayed',id:offer.id}));await waitFor(()=>h.journal.some(e=>e.name==='chalk_write'&&e.status==='rejected'));assert(!h.journal.some(e=>e.name==='chalk_write'&&e.status==='confirmed'));}
  await waitFor(()=>h.downstream.filter(e=>e.type==='audio').length>audioCount);assert.equal(h.released,0);
 }finally{await h.close();}
});

test('automatic lesson review stays a single scoped read when a redundant native proposal arrives',async()=>{
 const h=await harness('qwen',{delayedTranscript:true,delegationOutput:'reference',spokenResult:'Saved source pairs: synthetic reference.',heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'Can we review this lesson?',item_id:'native-recap-child'}));await waitFor(()=>h.transcriptWaiting);
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'review_lesson_notes',call_id:'native-recap',arguments:JSON.stringify({contextKey:`${id}:1:0`})}));const pong=once(h.upstream!,'pong');h.upstream!.ping('review-persistence-barrier');await pong;assert.equal(h.tools.length,0);
  h.resolveTranscript();await waitFor(()=>h.tools.length===1);await waitFor(()=>Boolean(schedulerResult(h,'native-recap')));const tool=h.tools[0] as {request?:ClassroomToolRequest};assert(tool.request);assert.equal(tool.request.source,'application');assert.equal(tool.request.command.name,'delegate');assert.equal(JSON.parse(schedulerResult(h,'native-recap')!.output).status,'unavailable');assert.equal(h.released,0);
 }finally{h.resolveTranscript();await h.close();}
});
test('a queued native lesson review is discarded after its task is replaced',async()=>{
 const h=await harness('qwen',{delayedTranscript:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:"Let's review.",item_id:'old-recap-child'}));await waitFor(()=>h.transcriptWaiting);
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'review_lesson_notes',call_id:'old-recap',arguments:JSON.stringify({contextKey:`${id}:1:0`})}));const pong=once(h.upstream!,'pong');h.upstream!.ping('old-review-queued');await pong;h.advance();await refreshClassroom(id);h.resolveTranscript();await waitFor(()=>h.journal.some(e=>e.name==='review_lesson_notes'&&e.status==='rejected'));assert.equal(h.tools.length,0);assert.equal(h.released,0);
 }finally{h.resolveTranscript();await h.close();}
});
test('GPT lesson review uses its measured completed input without requiring a fabricated native tool event',async()=>{
 const h=await harness('openai',{delayedTranscript:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  socket.send(pcmFrame(true));socket.send(pcmFrame(true));await waitFor(()=>h.sent.filter(e=>e.type==='session.input_audio.append').length===2);h.upstream!.send(JSON.stringify({type:'session.input_transcript.delta',delta:'Can we review this lesson?'}));finishSpokenInput(socket);await waitFor(()=>h.transcriptWaiting);assert.equal(h.tools.length,0);
  h.resolveTranscript();await waitFor(()=>h.tools.length===1);const request=(h.tools[0] as {request:ClassroomToolRequest}).request;assert.equal(request.source,'application');assert.equal(request.command.name,'delegate');assert('evidenceItemId' in request.command.arguments);assert.equal(h.released,0);
  h.upstream!.send(JSON.stringify({type:'session.delegation.created',delegation:{id:'late-review-handoff',target:'client'}}));await waitFor(()=>h.sent.some(e=>e.type==='session.thinking.append'&&e.delegation_id==='late-review-handoff'&&String(e.content).includes('review request')));assert.equal(h.tools.length,1);
 }finally{h.resolveTranscript();await h.close();}
});

test('native lesson review cannot return old source material after new learner speech begins',async()=>{
 const h=await harness('qwen',{delayedTool:true,spokenResult:'Saved source pairs: synthetic reference.',heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:"Let's review.",item_id:'review-before-interruption'}));await waitFor(()=>h.transcripts.length===1);
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'review_lesson_notes',call_id:'review-speaking-child',arguments:JSON.stringify({contextKey:`${id}:1:0`})}));await waitFor(()=>h.tools.length===1);h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started'}));const pong=once(h.upstream!,'pong');h.upstream!.ping('new-speaking-child');await pong;h.resolveTool();await waitFor(()=>Boolean(schedulerResult(h,'review-speaking-child')));
  const output=JSON.parse(schedulerResult(h,'review-speaking-child')!.output);assert.equal(output.status,'unavailable');assert(!String(output.english).includes('Saved source pairs'));assert.equal(h.released,0);
 }finally{h.resolveTool();await h.close();}
});
test('GPT lesson review waiting on persistence is withdrawn by a newer audible input',async()=>{
 const h=await harness('openai',{delayedTranscript:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));socket.send(pcmFrame(true));socket.send(pcmFrame(true));await waitFor(()=>h.sent.filter(e=>e.type==='session.input_audio.append').length===2);
  h.upstream!.send(JSON.stringify({type:'session.input_transcript.delta',delta:"Let's review."}));finishSpokenInput(socket);await waitFor(()=>h.transcriptWaiting);socket.send(pcmFrame(true));socket.send(JSON.stringify({type:'ping',nonce:'new-review-input'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='new-review-input'));h.resolveTranscript();await waitFor(()=>h.journal.some(e=>e.name==='delegate'&&e.status==='rejected'));assert.equal(h.tools.length,0);assert.equal(h.released,0);
 }finally{h.resolveTranscript();await h.close();}
});

test('a new learner utterance keeps its early handoff after an automatic lesson review',async()=>{
 const h=await harness('openai',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));socket.send(pcmFrame(true));socket.send(pcmFrame(true));await waitFor(()=>h.sent.filter(e=>e.type==='session.input_audio.append').length===2);
  h.upstream!.send(JSON.stringify({type:'session.input_transcript.delta',delta:"Let's review."}));finishSpokenInput(socket);await waitFor(()=>h.tools.length===1);
  await new Promise(resolve=>setTimeout(resolve,1010));socket.send(pcmFrame(true));socket.send(pcmFrame(true));await waitFor(()=>h.sent.filter(e=>e.type==='session.input_audio.append').length===16);
  h.upstream!.send(JSON.stringify({type:'session.delegation.created',delegation:{id:'new-after-review',target:'client'}}));h.upstream!.send(JSON.stringify({type:'session.input_transcript.delta',delta:'I like bananas.'}));finishSpokenInput(socket);await waitFor(()=>h.transcripts.length===2);await waitFor(()=>h.tools.length===2);
  assert.equal((h.tools[1] as {callId:string}).callId,'new-after-review');assert.equal(h.released,0);
 }finally{await h.close();}
});

const reviewReference='Saved source pairs: synthetic original and generated reference. Optional, not a grade.';
test('Qwen explicit lesson review reads after persistence without a native proposal or forged tool output',async()=>{
 const h=await harness('qwen',{delayedTranscript:true,delegationOutput:'reference',spokenResult:reviewReference,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  socket.send(JSON.stringify({type:'text',text:'Can we review this lesson?'}));await waitFor(()=>h.transcriptWaiting);assert.equal(h.tools.length,0);assert(!h.sent.some(e=>e.type==='session.update'&&String((e.session as {instructions?:string})?.instructions).includes(reviewReference)));
  h.resolveTranscript();await waitFor(()=>h.tools.length===1);await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(reviewReference)));
  const request=(h.tools[0] as {request:ClassroomToolRequest}).request;assert.equal(request.source,'application');assert.equal(request.command.name,'delegate');assert(!h.sent.some(e=>e.type==='conversation.item.create'));assert(!h.sent.some(e=>e.type==='session.thinking.append'));assert.equal(h.released,0);
 }finally{h.resolveTranscript();await h.close();}
});
test('an expanded Qwen review cue cannot start after a new typed input while configuration awaits ACK',async()=>{
 const h=await harness('qwen',{delegationOutput:'reference',spokenResult:reviewReference,delayReviewConfiguration:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);socket.send(JSON.stringify({type:'text',text:"Let's review."}));
  await waitFor(()=>h.sent.some(e=>e.type==='session.update'&&String((e.session as {instructions?:string})?.instructions).includes(reviewReference)));const baseline=h.sent.filter(e=>e.type==='response.create').length;
  await new Promise(resolve=>setTimeout(resolve,510));socket.send(JSON.stringify({type:'text',text:'I want to talk about my cat.'}));socket.send(JSON.stringify({type:'ping',nonce:'review-superseded'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='review-superseded'));
  h.upstream!.send(JSON.stringify({type:'session.updated'}));await waitFor(()=>h.sent.filter(e=>e.type==='response.create').length>baseline);assert(h.sent.filter(e=>e.type==='response.create').slice(baseline).every(e=>!String((e.response as {instructions?:string})?.instructions).includes(reviewReference)));assert.equal(h.released,0);
 }finally{h.upstream?.send(JSON.stringify({type:'session.updated'}));await h.close();}
});
test('a redundant native review settlement preserves a valid pending application review cue',async()=>{
 const h=await harness('qwen',{delegationOutput:'reference',spokenResult:reviewReference,delayReviewConfiguration:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);socket.send(JSON.stringify({type:'text',text:"Let's review."}));
  await waitFor(()=>h.sent.some(e=>e.type==='session.update'&&String((e.session as {instructions?:string})?.instructions).includes(reviewReference)));
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'review_lesson_notes',call_id:'redundant-current-review',arguments:JSON.stringify({contextKey:`${id}:1:0`})}));const pong=once(h.upstream!,'pong');h.upstream!.ping('redundant-review-seen');await pong;
  h.upstream!.send(JSON.stringify({type:'session.updated'}));await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(reviewReference)));await waitFor(()=>Boolean(schedulerResult(h,'redundant-current-review')));assert.equal(h.tools.length,1);assert.equal(JSON.parse(schedulerResult(h,'redundant-current-review')!.output).status,'unavailable');assert.equal(h.released,0);
 }finally{h.upstream?.send(JSON.stringify({type:'session.updated'}));await h.close();}
});
test('an expired expanded Qwen review cue is discarded at the original queue deadline',async()=>{
 let now=100;const h=await harness('qwen',{delegationOutput:'reference',spokenResult:reviewReference,delayReviewConfiguration:true,heartbeatMs:60000,toolQueueNow:()=>now});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);socket.send(JSON.stringify({type:'text',text:"Let's review."}));
  await waitFor(()=>h.sent.some(e=>e.type==='session.update'&&String((e.session as {instructions?:string})?.instructions).includes(reviewReference)));now=10100;h.upstream!.send(JSON.stringify({type:'session.updated'}));const pong=once(h.upstream!,'pong');h.upstream!.ping('expired-review-ack');await pong;
  socket.send(JSON.stringify({type:'ping',nonce:'expired-review-finished'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='expired-review-finished'));assert(!h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(reviewReference)));assert.equal(h.released,0);
 }finally{h.upstream?.send(JSON.stringify({type:'session.updated'}));await h.close();}
});

test('a late Qwen review response.created is cancelled before forwarding old audio',async()=>{
 const h=await harness('qwen',{delegationOutput:'reference',spokenResult:reviewReference,delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  socket.send(JSON.stringify({type:'text',text:"Let's review."}));await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(reviewReference)));const audio=h.downstream.filter(e=>e.type==='audio').length;
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'I like cats.',item_id:'new-after-queued-review'}));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='response.cancel'));assert.equal(h.downstream.filter(e=>e.type==='audio').length,audio);
  h.upstream!.send(JSON.stringify({type:'response.done'}));const pong=once(h.upstream!,'pong');h.upstream!.ping('old-review-done');await pong;h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));await waitFor(()=>h.downstream.filter(e=>e.type==='audio').length>audio);h.upstream!.send(JSON.stringify({type:'response.done'}));assert.equal(h.released,0);
 }finally{await h.close();}
});
test('a repeated native final does not cancel or replay the same automatic review read',async()=>{
 const h=await harness('qwen',{delegationOutput:'reference',spokenResult:reviewReference,delayedTool:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);const final={type:'conversation.item.input_audio_transcription.completed',transcript:"Let's review.",item_id:'same-review-final'};
  h.upstream!.send(JSON.stringify(final));await waitFor(()=>h.tools.length===1);h.upstream!.send(JSON.stringify(final));const pong=once(h.upstream!,'pong');h.upstream!.ping('duplicate-final-checked');await pong;h.resolveTool();await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(reviewReference)));assert.equal(h.tools.length,1);assert.equal(h.transcripts.length,1);assert(!h.sent.some(e=>e.type==='conversation.item.create'));assert.equal(h.released,0);
 }finally{h.resolveTool();await h.close();}
});

test('Qwen resumes the new completed utterance if VAD replied before old review configuration was restored',async()=>{
 const h=await harness('qwen',{delegationOutput:'reference',spokenResult:reviewReference,delayedResponses:true,delayReviewRestore:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  socket.send(JSON.stringify({type:'text',text:"Let's review."}));await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(reviewReference)));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));await waitFor(()=>h.sent.some(e=>e.type==='session.update'&&!String((e.session as {instructions?:string})?.instructions).includes(reviewReference)&&h.sent.indexOf(e)>h.sent.findIndex(v=>v.type==='response.create'&&String((v.response as {instructions?:string})?.instructions).includes(reviewReference))));
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'I want to talk about my cat.',item_id:'voice-during-review-restore'}));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='response.cancel'));assert.equal(h.downstream.some(e=>e.type==='audio'),false);
  h.upstream!.send(JSON.stringify({type:'response.done'}));h.upstream!.send(JSON.stringify({type:'session.updated'}));await waitFor(()=>h.sent.filter(e=>e.type==='response.create').length===3);const resumed=h.sent.filter(e=>e.type==='response.create').at(-1)!;assert(!String((resumed.response as {instructions?:string})?.instructions).includes(reviewReference));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));await waitFor(()=>h.downstream.some(e=>e.type==='audio'));h.upstream!.send(JSON.stringify({type:'response.done'}));h.upstream!.send(JSON.stringify({type:'session.updated'}));assert.equal(h.released,0);
 }finally{h.upstream?.send(JSON.stringify({type:'session.updated'}));await h.close();}
});

test('a historical native review final cannot replace the current task input or cancel its valid cue',async()=>{
 const h=await harness('qwen',{delegationOutput:'reference',spokenResult:reviewReference,delayReviewConfiguration:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started'}));const pong=once(h.upstream!,'pong');h.upstream!.ping('old-task-speech-start');await pong;
  h.advance();await refreshClassroom(id);socket.send(JSON.stringify({type:'text',text:"Let's review."}));await waitFor(()=>h.sent.some(e=>e.type==='session.update'&&String((e.session as {instructions?:string})?.instructions).includes(reviewReference)));
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:"Let's review.",item_id:'historical-review-final'}));const late=once(h.upstream!,'pong');h.upstream!.ping('historical-review-recorded');await late;h.upstream!.send(JSON.stringify({type:'session.updated'}));
  await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(reviewReference)));assert.equal(h.tools.length,1);assert(h.journal.some(e=>e.kind==='utterance'&&e.correlationId==='historical-review-final'&&(e.details as {contextKey?:string})?.contextKey===`${id}:1:0`));assert.equal(h.released,0);
 }finally{h.upstream?.send(JSON.stringify({type:'session.updated'}));await h.close();}
});

test('an invalid native tool settlement cannot erase a valid application review cue',async()=>{
 const h=await harness('qwen',{delegationOutput:'reference',spokenResult:reviewReference,delayReviewConfiguration:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);socket.send(JSON.stringify({type:'text',text:"Let's review."}));
  await waitFor(()=>h.sent.some(e=>e.type==='session.update'&&String((e.session as {instructions?:string})?.instructions).includes(reviewReference)));
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'inspect_current_page',call_id:'invalid-beside-review',arguments:'{'}));const pong=once(h.upstream!,'pong');h.upstream!.ping('bad-native-args-seen');await pong;
  h.upstream!.send(JSON.stringify({type:'session.updated'}));await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(reviewReference)));assert.equal(h.tools.length,1);assert.equal(h.released,0);
 }finally{h.upstream?.send(JSON.stringify({type:'session.updated'}));await h.close();}
});

test('long native item IDs dedupe the same completed review before queuing a second read',async()=>{
 const reference='Saved source pairs: safe synthetic material.';
 const h=await harness('qwen',{delegationOutput:'reference',spokenResult:reference,delayReviewConfiguration:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  const final={type:'conversation.item.input_audio_transcription.completed',transcript:"Let's review.",item_id:'long-review-'.repeat(20)};
  h.upstream!.send(JSON.stringify(final));await waitFor(()=>h.sent.some(e=>e.type==='session.update'&&String((e.session as {instructions?:string})?.instructions).includes(reference)));assert.equal(h.tools.length,1);
  h.upstream!.send(JSON.stringify(final));const pong=once(h.upstream!,'pong');h.upstream!.ping('duplicate-long-item');await pong;
  socket.send(JSON.stringify({type:'ping',nonce:'duplicate-long-item-sealed'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='duplicate-long-item-sealed'));
  assert.equal(h.tools.length,1);assert.equal(h.transcripts.length,1);
 }finally{h.upstream?.send(JSON.stringify({type:'session.updated'}));await h.close();}
});

test('an old review result cannot acquire a new revision through a delayed heartbeat',async()=>{
 const reference='Saved source pairs: stale synthetic reference.';
 const h=await harness('qwen',{delegationOutput:'reference',spokenResult:reference,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await settleNativeGreeting(h);
  h.delayNextHeartbeat();const calls=h.heartbeatCalls;socket.send(JSON.stringify({type:'text',text:"Let's review."}));await waitFor(()=>h.tools.length===1&&h.heartbeatCalls>calls);
  h.feedback();await refreshClassroom(id);h.releaseHeartbeat();
  await waitFor(()=>h.journal.some(e=>e.name==='delegate'&&(e.status==='confirmed'||e.status==='rejected'))||h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(reference)));
  const pong=once(h.upstream!,'pong');h.upstream!.ping('old-review-heartbeat-settled');await pong;
  assert(!h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(reference)));
 }finally{h.releaseHeartbeat();await h.close();}
});

for(const changedTask of [false,true])test(changedTask?'a restored ordinary reply is discarded when its task changes':'a same-task semantic revision must not lose the restored ordinary learner reply',async()=>{
 const h=await harness('qwen',{delegationOutput:'reference',spokenResult:reviewReference,delayedResponses:true,delayReviewRestore:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  socket.send(JSON.stringify({type:'text',text:"Let's review."}));await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(reviewReference)));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));await waitFor(()=>h.sent.some(e=>e.type==='session.update'&&!String((e.session as {instructions?:string})?.instructions).includes(reviewReference)&&h.sent.indexOf(e)>h.sent.findIndex(v=>v.type==='response.create'&&String((v.response as {instructions?:string})?.instructions).includes(reviewReference))));
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'I want to talk about my cat.',item_id:'voice-during-review-restore'}));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='response.cancel'));assert.equal(h.downstream.some(e=>e.type==='audio'),false);
  h.upstream!.send(JSON.stringify({type:'response.done'}));h.upstream!.send(JSON.stringify({type:'session.updated'}));await waitFor(()=>h.sent.filter(e=>e.type==='response.create').length===3);const resumed=h.sent.filter(e=>e.type==='response.create').at(-1)!;assert(!String((resumed.response as {instructions?:string})?.instructions).includes(reviewReference));
  if(changedTask)h.advance();else h.bumpRevision();await refreshClassroom(id);h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done'}));h.upstream!.send(JSON.stringify({type:'session.updated'}));if(changedTask){const pong=once(h.upstream!,'pong');h.upstream!.ping('ordinary-new-task-settled');await pong;assert.equal(h.downstream.some(e=>e.type==='audio'),false);}else await waitFor(()=>h.downstream.some(e=>e.type==='audio'));assert.equal(h.sent.filter(e=>e.type==='response.create').length,3);assert.equal(h.released,0);
 }finally{h.upstream?.send(JSON.stringify({type:'session.updated'}));await h.close();}
});

async function staleNativeChalkRequest(h:Awaited<ReturnType<typeof harness>>,socket:WebSocket,callId:string,secondCallId?:string){
 await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await waitFor(()=>h.sent.some(e=>e.type==='response.create'));
 h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
 h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'I still need help. Please write the short example.',item_id:'chalk-recovery-child'}));await waitFor(()=>h.transcripts.length===1);
 h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',transcript:'You can say I like apples.',item_id:'chalk-recovery-old-teacher'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));await waitFor(()=>h.downstream.some(e=>e.type==='audio'));
 h.bumpRevision();await refreshClassroom(id);
 h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'chalk_write',call_id:callId,arguments:JSON.stringify({contextKey:`${id}:1:0`,text:'I like apples.',seconds:8})}));if(secondCallId)h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'chalk_write',call_id:secondCallId,arguments:JSON.stringify({contextKey:`${id}:1:0`,text:'I like apples.',seconds:8})}));h.upstream!.send(JSON.stringify({type:'response.done'}));
 await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id===callId));
 await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));const probe=h.downstream.findLast(e=>e.type==='playback.probe')!,audio=h.downstream.findLast(e=>e.type==='audio'||e.type==='interrupt');socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio?.playbackId??0,running:true,audiblePending:false}));
}
const chalkRecoveryCue='Current optional chalk reference:';
test('native chalk can recover a stale oral proof only through a fresh current explanation and display receipt',async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await staleNativeChalkRequest(h,socket,'chalk-stale-first');const priorProbes=h.downstream.filter(e=>e.type==='playback.probe').length;
  await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(chalkRecoveryCue)));assert.equal(h.downstream.some(e=>e.type==='chalk.offer'),false);
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',transcript:'You can say I like apples.',item_id:'chalk-recovery-fresh-teacher'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'chalk_write',call_id:'chalk-fresh-second',arguments:JSON.stringify({contextKey:`${id}:1:0`,text:'I like apples.',seconds:8})}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  await waitFor(()=>h.downstream.filter(e=>e.type==='playback.probe').length>priorProbes);const probe=h.downstream.findLast(e=>e.type==='playback.probe')!,audio=h.downstream.findLast(e=>e.type==='audio')!;
  socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));await waitFor(()=>h.downstream.some(e=>e.type==='chalk.offer'));const offer=h.downstream.findLast(e=>e.type==='chalk.offer')!;
  socket.send(JSON.stringify({type:'chalk.ready',id:offer.id}));await waitFor(()=>h.downstream.some(e=>e.type==='chalk.commit'));socket.send(JSON.stringify({type:'chalk.displayed',id:offer.id}));
  await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='chalk-fresh-second'));const result=h.sent.find(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='chalk-fresh-second')!.item as {output:string};assert.equal(JSON.parse(result.output).status,'confirmed');assert.equal(h.tools.length,2);assert.equal(h.released,0);
 }finally{await h.close();}
});
for(const toolFailure of [false,true])test(`native chalk schedules at most one stale-proof recovery for the same completed input${toolFailure?' on tool error':''}`,async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000,...(toolFailure?{toolThrowCallId:'chalk-once-second'}:{})});try{
  const socket=h.connect();await staleNativeChalkRequest(h,socket,'chalk-once-first','chalk-once-second');await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(chalkRecoveryCue)));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='chalk-once-second'));
  const barrier=once(h.upstream!,'pong');h.upstream!.ping('chalk-recovery-once-settled');await barrier;assert.equal(h.sent.filter(e=>e.type==='session.update'&&String((e.session as {instructions?:string})?.instructions).includes(chalkRecoveryCue)).length,1);assert.equal(h.downstream.some(e=>e.type==='chalk.offer'),false);assert.equal(h.released,0);
 }finally{await h.close();}
});

for(const invalidation of ['new-input','expired'] as const)test(`a pending native chalk recovery is withdrawn on ${invalidation}`,async()=>{
 let now=1000;const h=await harness('qwen',{delayedResponses:true,delayChalkRecoveryConfiguration:true,toolQueueNow:()=>now,heartbeatMs:60000});try{
  const socket=h.connect();await staleNativeChalkRequest(h,socket,`chalk-invalid-${invalidation}`);await waitFor(()=>h.sent.some(e=>e.type==='session.update'&&String((e.session as {instructions?:string})?.instructions).includes(chalkRecoveryCue)));
  if(invalidation==='new-input'){socket.send(JSON.stringify({type:'text',text:'I want to talk about my cat.'}));await waitFor(()=>h.transcripts.some(e=>(e as {text?:string}).text==='I want to talk about my cat.'));}else now=11000;
  h.upstream!.send(JSON.stringify({type:'session.updated'}));await waitFor(()=>h.sent.filter(e=>e.type==='session.update').length>=4);const barrier=once(h.upstream!,'pong');h.upstream!.ping('chalk-invalid-recovery-settled');await barrier;
  assert.equal(h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(chalkRecoveryCue)),false);assert.equal(h.downstream.some(e=>e.type==='chalk.offer'),false);assert.equal(h.tools.length,1);assert.equal(h.released,0);
 }finally{h.upstream?.send(JSON.stringify({type:'session.updated'}));await h.close();}
});


async function startQwenApplicationChalk(h:Awaited<ReturnType<typeof harness>>,socket:WebSocket,waitForCandidate:boolean|'configuration'=true){
 await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  socket.send(JSON.stringify({type:'text',text:'I still need help.'}));await waitFor(()=>h.sent.filter(e=>e.type==='response.create').length===2);h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));const first=once(h.upstream!,'pong');h.upstream!.ping('qwen-candidate-ordinary-done');await first;
  h.offerChalk();await refreshClassroom(id);if(waitForCandidate){await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));const probe=h.downstream.findLast(e=>e.type==='playback.probe')!,audio=h.downstream.findLast(e=>e.type==='audio'||e.type==='interrupt');socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio?.playbackId??0,running:true,audiblePending:false}));}if(waitForCandidate===true)await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes('Current source-backed chalk reference:')));
}
async function offerQwenApplicationChalk(h:Awaited<ReturnType<typeof harness>>,socket:WebSocket,nativeDuplicate=false){
 await startQwenApplicationChalk(h,socket);
  const priorProbes=h.downstream.filter(e=>e.type==='playback.probe').length;for(let i=0;i<14;i++)socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',transcript:'You can say I like apples.',item_id:'qwen-private-reference'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));if(nativeDuplicate)h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'chalk_write',call_id:'qwen-app-native-duplicate',arguments:JSON.stringify({contextKey:`${id}:1:0`,text:'I like apples.',seconds:8})}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  await waitFor(()=>h.downstream.filter(e=>e.type==='playback.probe').length>priorProbes);const probe=h.downstream.findLast(e=>e.type==='playback.probe')!,audio=h.downstream.findLast(e=>e.type==='audio')!;socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));
  await waitFor(()=>h.downstream.some(e=>e.type==='chalk.offer'));const offer=h.downstream.findLast(e=>e.type==='chalk.offer')!;
 return offer;
}
for(const nativeDuplicate of [false,true])test(`Qwen application chalk uses a private saved candidate and its own current spoken reference${nativeDuplicate?' with a duplicate native request':' without native tool output'}`,async()=>{
 const h=await harness('qwen',{qwenChalk:true,delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect(),offer=await offerQwenApplicationChalk(h,socket,nativeDuplicate);socket.send(JSON.stringify({type:'chalk.ready',id:offer.id}));await waitFor(()=>h.downstream.some(e=>e.type==='chalk.commit'));socket.send(JSON.stringify({type:'chalk.displayed',id:offer.id}));await waitFor(()=>h.journal.some(e=>e.name==='chalk_write'&&e.status==='confirmed'));
  const inputTrace=h.journal.find(e=>(e.details as {phase?:string})?.phase==='input_final')?.details as {turnId:string}|undefined;assert(inputTrace);assert(h.journal.some(e=>e.name==='diagnostic_phase'&&e.actor==='application'&&(e.details as {phase?:string;turnId?:string})?.phase==='tool_requested'&&(e.details as {turnId?:string}).turnId===inputTrace.turnId));assert.equal(h.tools.length,1);assert.equal((h.tools[0] as {request:ClassroomToolRequest}).request.source,'application');const replies=h.sent.filter(e=>e.type==='conversation.item.create');assert.equal(replies.length,nativeDuplicate?1:0);if(nativeDuplicate)assert.equal((replies[0].item as {call_id:string}).call_id,'qwen-app-native-duplicate');assert.equal(h.released,0);
 }finally{await h.close();}
});


for(const missing of ['reference','voice','quiet','done'] as const)test(`Qwen application chalk cannot borrow a missing current ${missing}`,async()=>{
 const output=outputClock(),h=await harness('qwen',{qwenChalk:true,delayedResponses:true,audioClock:output.clock,heartbeatMs:60000});try{
  const socket=h.connect();await startQwenApplicationChalk(h,socket);
  if(missing!=='quiet')for(let i=0;i<14;i++)socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',transcript:missing==='reference'?'Let us talk about a picnic.':'You can say I like apples.',item_id:'qwen-missing-reference'}));if(missing!=='voice')h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));if(missing!=='done')h.upstream!.send(JSON.stringify({type:'response.done'}));
  const barrier=once(h.upstream!,'pong');h.upstream!.ping('qwen-incomplete-reference');await barrier;output.advance(500);const settled=once(h.upstream!,'pong');h.upstream!.ping('qwen-incomplete-drained');await settled;
  assert.equal(h.tools.length,0);assert.equal(h.downstream.some(e=>e.type==='chalk.offer'),false);assert.equal(h.sent.some(e=>e.type==='conversation.item.create'),false);assert.equal(h.released,0);
 }finally{await h.close();}
});
for(const badChalk of ['input','scope'] as const)test(`Qwen application chalk rejects a private candidate with mismatched ${badChalk}`,async()=>{
 const h=await harness('qwen',{qwenChalk:true,badChalk,delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await startQwenApplicationChalk(h,socket,false);const barrier=once(h.upstream!,'pong');h.upstream!.ping('qwen-rejected-private-source');await barrier;
  assert.equal(h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes('Current source-backed chalk reference:')),false);assert.equal(h.tools.length,0);assert.equal(h.released,0);
 }finally{await h.close();}
});


for(const phase of ['offered','committed','displayed'] as const)test(`Qwen application chalk preserves only already displayed writing when teacher output resumes: ${phase}`,async()=>{
 const h=await harness('qwen',{qwenChalk:true,delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect(),offer=await offerQwenApplicationChalk(h,socket);
  if(phase!=='offered'){socket.send(JSON.stringify({type:'chalk.ready',id:offer.id}));await waitFor(()=>h.downstream.some(e=>e.type==='chalk.commit'));}
  if(phase==='displayed'){socket.send(JSON.stringify({type:'chalk.displayed',id:offer.id}));await waitFor(()=>h.journal.some(e=>e.name==='chalk_write'&&e.status==='confirmed'));}
  const before=h.downstream.length;h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));await waitFor(()=>h.downstream.slice(before).some(e=>e.type==='audio'));
  assert.equal(h.downstream.some(e=>e.type==='chalk.clear'&&e.id===offer.id),phase!=='displayed');
  assert.equal(h.released,0);
 }finally{await h.close();}
});


for(const reason of ['new-input','expired'] as const)test(`Qwen application chalk withdraws an expanded pending cue on ${reason}`,async()=>{
 let now=1000;const h=await harness('qwen',{qwenChalk:true,delayedResponses:true,delayQwenChalkConfiguration:true,toolQueueNow:()=>now,heartbeatMs:60000});try{
  const socket=h.connect();await startQwenApplicationChalk(h,socket,'configuration');await waitFor(()=>h.sent.some(e=>e.type==='session.update'&&String((e.session as {instructions?:string})?.instructions).includes('Current source-backed chalk reference:')));h.offerChalk(false);
  if(reason==='new-input'){await new Promise(resolve=>setTimeout(resolve,510));socket.send(JSON.stringify({type:'text',text:'I want to talk about my cat.'}));await waitFor(()=>h.transcripts.some(e=>(e as {text?:string}).text==='I want to talk about my cat.'));}else now=11000;
  h.upstream!.send(JSON.stringify({type:'session.updated'}));await waitFor(()=>h.sent.filter(e=>e.type==='session.update').length>=4);const barrier=once(h.upstream!,'pong');h.upstream!.ping('qwen-private-cue-invalidated');await barrier;
  assert.equal(h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes('Current source-backed chalk reference:')),false);assert.equal(h.tools.length,0);assert.equal(h.released,0);
 }finally{h.upstream?.send(JSON.stringify({type:'session.updated'}));await h.close();}
});
test('a failed Qwen application chalk action records failure without inventing a native tool result or breaking voice',async()=>{
 const h=await harness('qwen',{qwenChalk:true,delayedResponses:true,toolThrows:true,heartbeatMs:60000});try{
  const socket=h.connect();await startQwenApplicationChalk(h,socket);for(let i=0;i<14;i++)socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',transcript:'You can say I like apples.',item_id:'qwen-failed-reference'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  await waitFor(()=>h.journal.some(e=>e.name==='chalk_write'&&e.status==='failed'));assert.equal(h.sent.some(e=>e.type==='conversation.item.create'),false);assert.equal(h.downstream.some(e=>e.type==='error'||e.type==='chalk.offer'),false);assert.equal(JSON.stringify(h.sent).includes('PRIVATE_TOOL_DETAIL'),false);assert.equal(h.released,0);
 }finally{await h.close();}
});

for(const audible of [true,false])test(`Qwen application chalk waits for older ${audible?'audible':'silent'} output bytes and current browser quiet before starting its reference`,async()=>{
 const output=outputClock(),h=await harness('qwen',{qwenChalk:true,delayedResponses:true,audioClock:output.clock,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  socket.send(JSON.stringify({type:'text',text:'I still need help.'}));await waitFor(()=>h.sent.filter(e=>e.type==='response.create').length===2);h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(9600,audible?0x11:0).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done'}));const barrier=once(h.upstream!,'pong');h.upstream!.ping('qwen-older-output-buffered');await barrier;output.advance(50);
  const interrupts=h.downstream.filter(e=>e.type==='interrupt').length;h.offerChalk();await refreshClassroom(id);const before=once(h.upstream!,'pong');h.upstream!.ping('qwen-pending-reference');await before;
  assert.equal(h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes('Current source-backed chalk reference:')),false);assert.equal(h.downstream.filter(e=>e.type==='interrupt').length,interrupts);assert.equal(h.downstream.some(e=>e.type==='playback.probe'),false);
  output.advance(500);await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));const probe=h.downstream.findLast(e=>e.type==='playback.probe')!,audio=h.downstream.findLast(e=>e.type==='audio')!;socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));
  await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes('Current source-backed chalk reference:')));assert.equal(h.released,0);
 }finally{await h.close();}
});

test('native chalk recovery also waits for the old voice queue and current browser playback before speaking',async()=>{
 const output=outputClock(),h=await harness('qwen',{delayedResponses:true,audioClock:output.clock,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'Please write a short example.',item_id:'native-recovery-queued-child'}));await waitFor(()=>h.transcripts.length===1);
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',transcript:'You can say I like apples.',item_id:'native-recovery-queued-teacher'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(9600,0x11).toString('base64')}));const barrier=once(h.upstream!,'pong');h.upstream!.ping('native-old-audio-queued');await barrier;output.advance(50);h.bumpRevision();await refreshClassroom(id);
  const interrupts=h.downstream.filter(e=>e.type==='interrupt').length;h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',name:'chalk_write',call_id:'native-recovery-queued',arguments:JSON.stringify({contextKey:`${id}:1:0`,text:'I like apples.',seconds:8})}));h.upstream!.send(JSON.stringify({type:'response.done'}));await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='native-recovery-queued'));
  const settled=once(h.upstream!,'pong');h.upstream!.ping('native-recovery-held');await settled;assert.equal(h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(chalkRecoveryCue)),false);assert.equal(h.downstream.filter(e=>e.type==='interrupt').length,interrupts);
  output.advance(500);await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));const probe=h.downstream.findLast(e=>e.type==='playback.probe')!,audio=h.downstream.findLast(e=>e.type==='audio')!;socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId:audio.playbackId,running:true,audiblePending:false}));await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes(chalkRecoveryCue)));assert.equal(h.released,0);
 }finally{await h.close();}
});


test('Qwen application chalk cannot borrow reference text from a response before its configuration acknowledgment',async()=>{
 const output=outputClock(),h=await harness('qwen',{qwenChalk:true,delayedResponses:true,delayQwenChalkConfiguration:true,audioClock:output.clock,heartbeatMs:60000});try{
  const socket=h.connect();await startQwenApplicationChalk(h,socket,'configuration');await waitFor(()=>h.sent.some(e=>e.type==='session.update'&&String((e.session as {instructions?:string})?.instructions).includes('Current source-backed chalk reference:')));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',transcript:'You can say I like apples.',item_id:'pre-ack-unrelated-reference'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done'}));const first=once(h.upstream!,'pong');h.upstream!.ping('pre-ack-reference-done');await first;output.advance(500);h.upstream!.send(JSON.stringify({type:'session.updated'}));
  await waitFor(()=>h.downstream.filter(e=>e.type==='playback.probe').length>=2);const preProbe=h.downstream.findLast(e=>e.type==='playback.probe')!,preAudio=h.downstream.findLast(e=>e.type==='audio'||e.type==='interrupt');socket.send(JSON.stringify({type:'playback.state',probeId:preProbe.id,playbackId:preAudio?.playbackId??0,running:true,audiblePending:false}));
  await waitFor(()=>h.sent.some(e=>e.type==='response.create'&&String((e.response as {instructions?:string})?.instructions).includes('Current source-backed chalk reference:')));for(let i=0;i<14;i++)socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',transcript:'Let us talk about a picnic.',item_id:'actual-reference-without-phrase'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done'}));const last=once(h.upstream!,'pong');h.upstream!.ping('actual-reference-done');await last;output.advance(500);const settled=once(h.upstream!,'pong');h.upstream!.ping('actual-reference-drained');await settled;assert.equal(h.tools.length,0);assert.equal(h.downstream.some(e=>e.type==='chalk.offer'),false);assert.equal(h.released,0);
 }finally{h.upstream?.send(JSON.stringify({type:'session.updated'}));await h.close();}
});

async function beginQwenTranscriptionFailure(h:Awaited<ReturnType<typeof harness>>,socket:WebSocket){
 await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
 h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'failed-current-input'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'failed-current-input'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.failed',item_id:'failed-current-input',error:{code:'PRIVATE_PROVIDER_CODE',message:'PRIVATE_CHILD_AND_CREDENTIAL_TEXT'}}));
}
test('a Qwen transcription failure keeps live audio and can accept the next complete utterance without inventing evidence',async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await beginQwenTranscriptionFailure(h,socket);h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  await waitFor(()=>h.downstream.some(e=>e.type==='audio')||h.downstream.some(e=>e.type==='error'));assert.equal(h.downstream.some(e=>e.type==='error'),false);assert.equal(h.transcripts.length,0);assert.equal(h.tools.length,0);assert.equal(h.released,0);
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'next-complete-input'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'next-complete-input'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'next-complete-input',transcript:'An apple.'}));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',call_id:'next-complete-tool',name:'submit_spoken_answer',arguments:JSON.stringify({contextKey:`${id}:1:0`,answer:'An apple.'})}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  await waitFor(()=>h.tools.length===1);assert.equal(h.transcripts.length,1);await waitFor(()=>h.journal.some(e=>e.name==='input_transcription_failed'));assert.equal(JSON.stringify([...h.journal,...h.downstream]).includes('PRIVATE_'),false);assert.equal(h.released,0);
 }finally{await h.close();}
});
test('a Qwen transcription failure cannot reuse the previous learner evidence through a new native answer tool',async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'previous-valid-input',transcript:'An apple.'}));await waitFor(()=>h.transcripts.length===1);
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'failed-current-input'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'failed-current-input'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.failed',item_id:'failed-current-input'}));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',call_id:'failed-input-answer',name:'submit_spoken_answer',arguments:JSON.stringify({contextKey:`${id}:1:0`,answer:'An apple.'})}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='failed-input-answer')||h.downstream.some(e=>e.type==='error'));assert.equal(h.downstream.some(e=>e.type==='error'),false);assert.equal(h.tools.length,0);assert.equal(h.transcripts.length,1);assert.equal(h.sent.filter(e=>e.type==='response.create').length,1);assert.equal(h.released,0);
 }finally{await h.close();}
});
for(const type of ['error','response.done'] as const)test(`Qwen genuine ${type} failures still stop voice and retain only fixed diagnostic categories`,async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify(type==='error'?{type,error:{type:'server_error',code:'PRIVATE_CODE',message:'PRIVATE_DETAIL'}}:{type,response:{status:'failed',status_details:{error:{message:'PRIVATE_DETAIL'}}}}));await waitFor(()=>h.released===1);
  const diagnostic=h.journal.find(e=>e.name==='voice_provider_failure');assert(diagnostic);const details=diagnostic.details as {errorCode:string;state:string};assert.equal(details.errorCode,type==='error'?'provider_server_error':'provider_response_failed');assert.equal(details.state,'active');assert.equal(JSON.stringify([...h.journal,...h.downstream]).includes('PRIVATE'),false);assert(h.downstream.some(e=>e.type==='error'&&e.code==='provider_error'));
 }finally{await h.close();}
});
test('Qwen no reply after a transcription failure still hits the bounded response deadline with state diagnostics',async()=>{
 const h=await harness('qwen',{delayedResponses:true,responseAckMs:100,heartbeatMs:60000});try{
  const socket=h.connect();await beginQwenTranscriptionFailure(h,socket);await waitFor(()=>h.released===1&&h.downstream.some(e=>e.type==='error'));assert.equal(h.downstream.find(e=>e.type==='error')?.code,'response_timeout',JSON.stringify(h.downstream.map(e=>({type:e.type,code:e.code}))));const diagnostic=h.journal.find(e=>e.name==='voice_response_timeout');assert(diagnostic);assert.equal((diagnostic.details as {state:string}).state,'pending');
 }finally{await h.close();}
});

test('a late final from another audio item cannot unblock a failed current Qwen input',async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await beginQwenTranscriptionFailure(h,socket);h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'old-other-item',transcript:'An apple.'}));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',call_id:'late-old-final-answer',name:'submit_spoken_answer',arguments:JSON.stringify({contextKey:`${id}:1:0`,answer:'An apple.'})}));h.upstream!.send(JSON.stringify({type:'response.done'}));await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='late-old-final-answer'));assert.equal(h.tools.length,0);assert.equal(h.transcripts.length,0);await waitFor(()=>h.journal.some(e=>(e.details as {state?:string})?.state==='superseded_input'));assert.equal(h.released,0);
 }finally{await h.close();}
});
for(const failedItem of ['old-other-item','new-current-item'] as const)test(`a late Qwen transcription failure does not poison an already complete input: ${failedItem}`,async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'new-current-item'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'new-current-item'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'new-current-item',transcript:'An apple.'}));await waitFor(()=>h.transcripts.length===1);h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.failed',item_id:failedItem}));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',call_id:'complete-input-allowed',name:'submit_spoken_answer',arguments:JSON.stringify({contextKey:`${id}:1:0`,answer:'An apple.'})}));h.upstream!.send(JSON.stringify({type:'response.done'}));await waitFor(()=>h.tools.length===1);assert.equal(h.released,0);assert.equal(h.downstream.some(e=>e.type==='error'),false);
 }finally{await h.close();}
});

test('a queued native Qwen answer stays withdrawn after ASR failure and a newer complete input',async()=>{
 const h=await harness('qwen',{delayedResponses:true,delayedTool:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'old-complete-for-queue',transcript:'An apple.'}));await waitFor(()=>h.transcripts.length===1);
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',call_id:'blocking-highlight-before-failure',name:'highlight_objects',arguments:JSON.stringify({contextKey:`${id}:1:0`,objectIds:['apple']})}));await waitFor(()=>h.tools.length===1);
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'failed-while-queued'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'failed-while-queued'}));h.upstream!.send(JSON.stringify({type:'response.created'}));
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',call_id:'queued-answer-before-asr-failure',name:'submit_spoken_answer',arguments:JSON.stringify({contextKey:`${id}:1:0`,answer:'An apple.'})}));
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.failed',item_id:'failed-while-queued'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  const admitted=once(h.upstream!,'pong');h.upstream!.ping('queue-asr-failed');await admitted;socket.send(JSON.stringify({type:'text',text:'A banana.'}));await waitFor(()=>h.transcripts.length===2);h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));const newer=once(h.upstream!,'pong');h.upstream!.ping('newer-complete-before-old-tool');await newer;h.resolveTool();
  await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='blocking-highlight-before-failure'));
  const settled=once(h.upstream!,'pong');h.upstream!.ping('queue-after-asr-failure');await settled;
  const answerCalls=h.tools.filter(e=>(e as {name:string}).name==='submit_spoken_answer');h.resolveTool();
  assert.equal(answerCalls.length,0,'ASR failure must withdraw the old queued native answer');
 }finally{h.resolveTool();await h.close();}
});

test('a different Qwen audio item final before current failure stays historical and cannot complete its window',async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'current-missing-item'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'current-missing-item'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'older-other-item',transcript:'An apple.'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.failed',item_id:'current-missing-item'}));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',call_id:'before-failure-old-answer',name:'submit_spoken_answer',arguments:JSON.stringify({contextKey:`${id}:1:0`,answer:'An apple.'})}));h.upstream!.send(JSON.stringify({type:'response.done'}));await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='before-failure-old-answer'));assert.equal(h.tools.length,0);assert.equal(h.transcripts.length,0);assert(h.journal.some(e=>(e.details as {state?:string})?.state==='superseded_input'));assert.equal(h.released,0);
 }finally{await h.close();}
});

test('a queued native Qwen answer without prior input cannot borrow the first later complete input',async()=>{
 const h=await harness('qwen',{delayedResponses:true,delayedTool:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',call_id:'blocking-highlight-before-failure',name:'highlight_objects',arguments:JSON.stringify({contextKey:`${id}:1:0`,objectIds:['apple']})}));await waitFor(()=>h.tools.length===1);
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'failed-while-queued'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'failed-while-queued'}));h.upstream!.send(JSON.stringify({type:'response.created'}));
  h.upstream!.send(JSON.stringify({type:'response.function_call_arguments.done',call_id:'queued-answer-before-asr-failure',name:'submit_spoken_answer',arguments:JSON.stringify({contextKey:`${id}:1:0`,answer:'An apple.'})}));
  h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.failed',item_id:'failed-while-queued'}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  const admitted=once(h.upstream!,'pong');h.upstream!.ping('queue-asr-failed');await admitted;socket.send(JSON.stringify({type:'text',text:'A banana.'}));await waitFor(()=>h.transcripts.length===1);h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));const newer=once(h.upstream!,'pong');h.upstream!.ping('newer-complete-before-old-tool');await newer;h.resolveTool();
  await waitFor(()=>h.sent.some(e=>e.type==='conversation.item.create'&&(e.item as {call_id?:string})?.call_id==='blocking-highlight-before-failure'));
  const settled=once(h.upstream!,'pong');h.upstream!.ping('queue-after-asr-failure');await settled;
  const answerCalls=h.tools.filter(e=>(e as {name:string}).name==='submit_spoken_answer');h.resolveTool();
  assert.equal(answerCalls.length,0,'ASR failure must withdraw the old queued native answer');
 }finally{h.resolveTool();await h.close();}
});


test('Grok is an independent native 24kHz classroom route with its own canonical audio events',async()=>{
 const h=await harness('grok',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));assert.equal(h.endpoint,'wss://api.x.ai/v1/realtime?model=grok-voice-3.0');const ready=h.downstream.find(e=>e.type==='ready')!;assert.equal(ready.inputSampleRate,24000);
  const config=h.sent.find(e=>e.type==='session.update')!;assert.equal((config.session as {voice:string}).voice,'eve');assert.equal(h.sent.some(e=>e.type==='session.start'),false);
  socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(4800).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.output_audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.output_audio_transcript.done',item_id:'grok-teacher-current',transcript:'Hello, let us have a picnic.'}));h.upstream!.send(JSON.stringify({type:'response.done'}));await waitFor(()=>h.downstream.some(e=>e.type==='audio'));await waitFor(()=>h.transcripts.length===1);assert.equal(h.downstream.some(e=>e.type==='error'),false);assert.equal(h.released,0);
 }finally{await h.close();}
});
test('Grok unsupported image sharing stays unavailable without opening an OpenAI or Qwen image path',async()=>{
 const h=await harness('grok',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));socket.send(JSON.stringify({type:'vision.start',generation:1}));await waitFor(()=>h.downstream.some(e=>e.type==='vision.state'&&e.status==='unavailable'));assert.equal(h.sent.some(e=>e.type==='input_image_buffer.append'),false);assert.equal(h.downstream.some(e=>e.type==='error'),false);assert.equal(h.released,0);
 }finally{await h.close();}
});

test('Grok environment fallback never borrows OpenAI or Qwen credentials',()=>{
 const onlyOther={OPENAI_API_KEY:'fixture-openai-key',DASHSCOPE_API_KEY:'fixture-qwen-key'};const missing=withRuntimeEnv(onlyOther,()=>configFromEnvironment('grok'));assert.equal(missing.key,'');
 const configured=withRuntimeEnv({...onlyOther,XAI_API_KEY:'fixture-grok-key'},()=>configFromEnvironment('grok'));assert.equal(configured.key,'fixture-grok-key');assert.equal(configured.model,'grok-voice-3.0');
});

for(const provider of ['qwen','grok'] as const)test(`diagnostic traces associate ${provider} speech and actual response audio without packet flooding`,async()=>{
 const h=await harness(provider,{delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'greeting-response'}}));h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'greeting-response'}}));
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'diagnostic-current-child'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'diagnostic-current-child'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'diagnostic-current-child',transcript:'An apple.'}));h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'diagnostic-vad-response'}}));
  h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',response_id:'diagnostic-vad-response',item_id:'diagnostic-current-teacher',transcript:'Yes, an apple.'}));h.upstream!.send(JSON.stringify({type:'response.audio_transcript.done',item_id:'diagnostic-unbound-teacher',transcript:'Unbound teacher text.'}));
  for(let i=0;i<8;i++)h.upstream!.send(JSON.stringify({type:'response.audio.delta',response_id:'diagnostic-vad-response',delta:Buffer.alloc(2400,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'diagnostic-vad-response'}}));
  await waitFor(()=>h.downstream.some(e=>e.type==='audio'));const metadata=h.downstream.find(e=>e.type==='diagnostic.response'&&e.state==='started');assert(metadata,'First audio needs server-issued metadata.');
  assert(h.downstream.indexOf(metadata)<h.downstream.findIndex(e=>e.type==='audio'));await waitFor(()=>h.journal.some(e=>(e.details as {phase?:string})?.phase==='response_completed'&&(e.details as {spanId?:string})?.spanId===metadata.spanId));
  const facts=h.journal.filter(e=>e.name==='diagnostic_phase').map(e=>e.details as {phase:string;turnId:string;spanId:string;clock:string});const span=facts.filter(e=>e.spanId===metadata.spanId);assert.equal(span.filter(e=>e.phase==='audio_first_received').length,1);assert.equal(span.filter(e=>e.phase==='audio_first_sent').length,1);
  const input=facts.find(e=>e.phase==='input_final');assert(input);const association=h.journal.find(e=>e.name==='diagnostic_association'&&e.correlationId==='diagnostic-current-child');assert(association,'The persisted input needs an explicit diagnostic association.');assert.equal((association.details as {turnId:string}).turnId,input.turnId);assert(h.journal.some(e=>e.kind==='utterance'&&e.name==='transcript'&&e.correlationId===association.correlationId));const teacher=h.journal.find(e=>e.name==='diagnostic_association'&&e.correlationId==='diagnostic-current-teacher');assert.equal((teacher?.details as {spanId?:string})?.spanId,metadata.spanId);assert.equal(h.journal.some(e=>e.name==='diagnostic_association'&&e.correlationId==='diagnostic-unbound-teacher'),false);assert.equal(input.turnId,metadata.turnId);assert.notEqual(facts.find(e=>e.phase==='response_requested')?.turnId,input.turnId);assert.equal(h.tools.length,0);assert.equal(h.released,0);
 }finally{await h.close();}
});
test('diagnostic playback accepts only current server spans and cannot authorize tools or leak extra fields',async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done'}));await waitFor(()=>h.downstream.some(e=>e.type==='audio'));
  const metadata=h.downstream.find(e=>e.type==='diagnostic.response'&&e.state==='started');assert(metadata);const message={type:'diagnostic.playback',turnId:metadata.turnId,spanId:metadata.spanId,phase:'playback_started',elapsedMs:0,queueMs:50};
  socket.send(JSON.stringify({...message,spanId:'00000000-0000-4000-8000-000000000001'}));socket.send(JSON.stringify({...message,answer:'PRIVATE_DIAGNOSTIC_FIELD'}));socket.send(JSON.stringify(message));for(let i=0;i<3;i++)socket.send(JSON.stringify({...message,phase:'playback_sample',elapsedMs:20+i}));socket.send(JSON.stringify({...message,phase:'playback_finished',elapsedMs:50,queueMs:0}));
  await waitFor(()=>h.journal.some(e=>(e.details as {phase?:string})?.phase==='playback_finished'));const clientFacts=()=>h.journal.filter(e=>(e.details as {clock?:string})?.clock==='client');assert.equal(clientFacts().length,3);h.bumpRevision();await refreshClassroom(id);socket.send(JSON.stringify({...message,phase:'playback_sample',elapsedMs:1000}));socket.send(JSON.stringify({type:'ping',nonce:'diagnostic-invalid-old-scope'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='diagnostic-invalid-old-scope'));
  assert.equal(clientFacts().length,3);assert.equal(JSON.stringify(h.journal).includes('PRIVATE_DIAGNOSTIC_FIELD'),false);assert.equal(h.tools.length,0);assert.equal(h.released,0);assert.equal(h.downstream.some(e=>e.type==='error'),false);
 }finally{await h.close();}
});

test('excess untrusted diagnostic playback reports cannot spend the media allowance or stop live voice',async()=>{
 const h=await harness('qwen',{heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));for(let i=0;i<40;i++)socket.send(JSON.stringify({type:'diagnostic.playback',turnId:'00000000-0000-4000-8000-000000000001',spanId:'00000000-0000-4000-8000-000000000002',phase:'playback_sample',elapsedMs:i,queueMs:0}));socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));
  await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append')||h.downstream.some(e=>e.type==='error'));assert.equal(h.downstream.some(e=>e.type==='error'),false);assert(h.sent.some(e=>e.type==='input_audio_buffer.append'));assert.equal(h.journal.some(e=>(e.details as {clock?:string})?.clock==='client'),false);assert.equal(h.released,0);
 }finally{await h.close();}
});

test('GPT diagnostics start a fresh unbound stream after a real playback interruption and scope replacement',async()=>{
 const output=outputClock(),h=await harness('openai',{heartbeatMs:60000,audioClock:output.clock,gptOutputQuietMs:80});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));const emit=()=>h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));emit();await waitFor(()=>output.timers.size===1);output.advance(100);await waitFor(()=>h.downstream.some(e=>e.type==='audio'));const first=h.downstream.find(e=>e.type==='diagnostic.response'&&e.state==='started')!;assert(first);
  socket.send(pcmFrame(true));await waitFor(()=>h.sent.some(e=>e.type==='session.thinking.append'));const ack=h.sent.findLast(e=>e.type==='session.thinking.append')!;h.upstream!.send(JSON.stringify({type:'session.thinking.appended',client_event_id:ack.event_id}));finishSpokenInput(socket);await waitFor(()=>h.sent.filter(e=>e.type==='session.input_audio.append').length===13);h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(4800).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='session.commentary.append'&&String(e.content).includes('Current objective:')));emit();await waitFor(()=>output.timers.size===1);output.advance(500);await waitFor(()=>h.downstream.filter(e=>e.type==='audio').length>=2);
  const starts=()=>h.downstream.filter(e=>e.type==='diagnostic.response'&&e.state==='started');assert.equal(starts().length,2);assert.notEqual(starts()[1].spanId,first.spanId);h.bumpRevision();await refreshClassroom(id);emit();await waitFor(()=>output.timers.size===1);output.advance(500);await waitFor(()=>h.downstream.filter(e=>e.type==='audio').length>=3);assert.equal(starts().length,3);assert.notEqual(starts()[2].spanId,starts()[1].spanId);
  const streamIds=new Set(starts().map(e=>e.spanId));assert.equal(h.journal.some(e=>streamIds.has((e.details as {spanId?:string})?.spanId)&&(e.details as {phase?:string})?.phase==='response_completed'),false);assert.equal(h.released,0);
 }finally{await h.close();}
});

test('diagnostic completion waits for provider done and every server PCM tail frame sent to the browser',async()=>{
 const output=outputClock(),h=await harness('qwen',{delayedResponses:true,audioClock:output.clock,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'tail-response'}}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',response_id:'tail-response',delta:Buffer.alloc(9600,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'tail-response'}}));await waitFor(()=>output.timers.size===1);output.advance(0);await waitFor(()=>h.downstream.some(e=>e.type==='audio'));
  assert.equal(h.downstream.some(e=>e.type==='diagnostic.response'&&e.state==='completed'),false,'Generation done cannot claim the server PCM tail was delivered.');output.advance(500);await waitFor(()=>h.downstream.filter(e=>e.type==='audio').length===4);const completed=h.downstream.findLastIndex(e=>e.type==='diagnostic.response'&&e.state==='completed');assert(completed>h.downstream.findLastIndex(e=>e.type==='audio'));assert.equal(h.released,0);
 }finally{await h.close();}
});
test('diagnostic audio explicitly leaves mixed response frames unattributed while flushing both completed tails',async()=>{
 const output=outputClock(),h=await harness('qwen',{delayedResponses:true,audioClock:output.clock,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'mixed-a'}}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',response_id:'mixed-a',delta:Buffer.alloc(3600,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'mixed-a'}}));await waitFor(()=>output.timers.size===1);output.advance(0);await waitFor(()=>h.downstream.some(e=>e.type==='audio'));
  h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'mixed-b'}}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',response_id:'mixed-b',delta:Buffer.alloc(2400,0x22).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'mixed-b'}}));const barrier=once(h.upstream!,'pong');h.upstream!.ping('mixed-frames-buffered');await barrier;output.advance(500);await waitFor(()=>h.downstream.filter(e=>e.type==='audio').length===3);const audio=h.downstream.filter(e=>e.type==='audio');assert.equal(audio[1].diagnosticSpanId,null);assert.equal(typeof audio[0].diagnosticSpanId,'string');assert.equal(typeof audio[2].diagnosticSpanId,'string');assert.notEqual(audio[0].diagnosticSpanId,audio[2].diagnosticSpanId);assert.equal(h.downstream.filter(e=>e.type==='diagnostic.response'&&e.state==='completed').length,2);
 }finally{await h.close();}
});

test('diagnostic audio never assigns known response ownership to PCM mixed with unknown bytes',async()=>{
 const output=outputClock(),h=await harness('qwen',{delayedResponses:true,audioClock:output.clock,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'known-response'}}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',response_id:'known-response',delta:Buffer.alloc(1200,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',response_id:'unknown-response',delta:Buffer.alloc(2400,0x22).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'known-response'}}));const barrier=once(h.upstream!,'pong');h.upstream!.ping('unknown-frames-buffered');await barrier;output.advance(500);await waitFor(()=>h.downstream.filter(e=>e.type==='audio').length===2);assert(h.downstream.filter(e=>e.type==='audio').every(e=>e.diagnosticSpanId===null));const completed=h.downstream.findIndex(e=>e.type==='diagnostic.response'&&e.state==='completed');assert(completed>h.downstream.findIndex(e=>e.type==='audio'));assert.equal(h.released,0);
 }finally{await h.close();}
});

for(const provider of ['qwen','grok','openai'] as const)test(`${provider} silence recovery uses confirmed browser drain and prompts only once`,async()=>{
 const h=await harness(provider,{delayedResponses:true,silencePromptMs:30,responseAckMs:4000,heartbeatMs:60000});
 let inputTimer:ReturnType<typeof setInterval>|undefined;
 try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  if(provider!=='openai'){await settleNativeGreeting(h);h.upstream!.send(JSON.stringify({type:'response.created'}));}
  h.upstream!.send(JSON.stringify({type:provider==='openai'?'session.output_audio.delta':'response.audio.delta',delta:Buffer.alloc(4800,0x11).toString('base64')}));
  if(provider!=='openai')h.upstream!.send(JSON.stringify({type:'response.done'}));
  const quiet=JSON.stringify({type:'audio',audio:Buffer.alloc(provider==='qwen'?3200:4800).toString('base64')});
  inputTimer=setInterval(()=>socket.send(quiet),100);
  const initial=h.sent.filter(e=>e.type===(provider==='openai'?'session.commentary.append':'response.create')).length;
  await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));
  const latestPlayback=()=>h.downstream.findLast(e=>e.type==='audio')!.playbackId;
  assert.equal(h.journal.filter(e=>e.name==='silence_prompt').length,0,'unconfirmed browser playback must not prompt');
  const seen=new Set<string>();
  const answer=()=>{for(const event of h.downstream.filter(e=>e.type==='playback.probe'))if(!seen.has(String(event.id))){seen.add(String(event.id));socket.send(JSON.stringify({type:'playback.state',probeId:event.id,playbackId:latestPlayback(),running:true,audiblePending:false}));}};
  const receiptTimer=setInterval(answer,10);
  try{answer();await waitFor(()=>h.journal.some(e=>e.name==='silence_prompt'));}
  finally{clearInterval(receiptTimer);}
  await waitFor(()=>h.sent.filter(e=>e.type===(provider==='openai'?'session.commentary.append':'response.create')).length===initial+1);
  if(provider!=='openai'){h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.done'}));}
  await new Promise(resolve=>setTimeout(resolve,400));assert.equal(h.journal.filter(e=>e.name==='silence_prompt').length,1);
  assert.equal(h.released,0);assert(!h.downstream.some(e=>e.type==='error'));
 }finally{if(inputTimer)clearInterval(inputTimer);await h.close();}
});

test('disabling unsolicited silence prompts still lets a Qwen voice follow-up reach the browser',async()=>{
 const h=await harness('qwen',{delayedResponses:true,silencePromptEnabled:false,silencePromptMs:30,responseAckMs:5000,heartbeatMs:60000});
 let inputTimer:ReturnType<typeof setInterval>|undefined;
 let receiptTimer:ReturnType<typeof setInterval>|undefined;
 try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  await settleNativeGreeting(h);
  const upstream=h.upstream!;
  upstream.send(JSON.stringify({type:'response.created',response:{id:'lab-greeting'}}));
  upstream.send(JSON.stringify({type:'response.audio.delta',response_id:'lab-greeting',delta:Buffer.alloc(2400,0x11).toString('base64')}));
  upstream.send(JSON.stringify({type:'response.done',response:{id:'lab-greeting'}}));
  await waitFor(()=>h.downstream.some(e=>e.type==='audio'));
  const playbackId=h.downstream.findLast(e=>e.type==='audio')!.playbackId;
  const quiet=JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')});
  inputTimer=setInterval(()=>socket.send(quiet),100);
  const acknowledged=new Set<unknown>();
  receiptTimer=setInterval(()=>{
   for(const probe of h.downstream.filter(e=>e.type==='playback.probe')){
    if(acknowledged.has(probe.id))continue;
    acknowledged.add(probe.id);
    socket.send(JSON.stringify({type:'playback.state',probeId:probe.id,playbackId,running:true,audiblePending:false}));
   }
  },10);
  await new Promise(resolve=>setTimeout(resolve,2800));
  assert.equal(h.sent.filter(e=>e.type==='response.create').length,1,'the socket must not create a second response solely because playback drained');
  assert.equal(acknowledged.size,0,'the disabled silence timer must not probe playback');
  assert(!h.journal.some(e=>e.name==='silence_prompt'));

  const itemId='lab-spoken-follow-up';
  upstream.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:itemId}));
  upstream.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:itemId}));
  upstream.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:itemId,transcript:'Tell me about wings.'}));
  upstream.send(JSON.stringify({type:'response.created',response:{id:'lab-native-reply'}}));
  upstream.send(JSON.stringify({type:'response.audio.delta',response_id:'lab-native-reply',delta:Buffer.alloc(2400,0x22).toString('base64')}));
  upstream.send(JSON.stringify({type:'response.done',response:{id:'lab-native-reply'}}));
  await waitFor(()=>h.transcripts.some(e=>(e as {itemId?:string}).itemId===itemId)&&h.downstream.some(e=>e.type==='audio'&&e.playbackId!==playbackId));
  assert.equal(h.sent.filter(e=>e.type==='response.create').length,1);
  assert.equal(h.released,0);assert(!h.downstream.some(e=>e.type==='error'));
 }finally{if(inputTimer)clearInterval(inputTimer);if(receiptTimer)clearInterval(receiptTimer);await h.close();}
});

for(const provider of ['qwen','grok'] as const)test(`${provider} recovery bounds a created response that never produces output or completion`,async()=>{
 const h=await harness(provider,{delayedResponses:true,responseAckMs:4000,responseProgressMs:60,heartbeatMs:20});
 try{
  const socket=h.connect();await once(socket,'open');await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'response.created'}));
  await waitFor(()=>h.released===1&&h.downstream.some(e=>e.type==='error'));
  assert.equal(h.downstream.find(e=>e.type==='error')?.code,'response_timeout');
  assert(h.journal.some(e=>e.name==='voice_response_timeout'&&(e.details as {state?:string}).state==='active'));
 }finally{await h.close();}
});

for(const provider of ['qwen','grok'] as const)test(`${provider} recovery watchdog follows real output progress and clears on done`,async()=>{
 const h=await harness(provider,{delayedResponses:true,responseAckMs:4000,responseProgressMs:100,heartbeatMs:60000});
 try{
  const socket=h.connect();await once(socket,'open');await settleNativeGreeting(h);h.upstream!.send(JSON.stringify({type:'response.created'}));
  for(let i=0;i<4;i++){await new Promise(resolve=>setTimeout(resolve,40));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));}
  h.upstream!.send(JSON.stringify({type:'response.done'}));await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(h.released,0);assert(!h.downstream.some(e=>e.type==='error'));assert(h.downstream.some(e=>e.type==='audio'));
 }finally{await h.close();}
});

for(const change of ['mute','drawing','speech','pause','lease'] as const)test(`silence recovery rejects a pending playback receipt after ${change}`,async()=>{
 const h=await harness('qwen',{delayedResponses:true,silencePromptMs:30,responseAckMs:4000,heartbeatMs:60000});
 let inputTimer:ReturnType<typeof setInterval>|undefined;
 try{
  const socket=h.connect();await once(socket,'open');await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(4800,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  inputTimer=setInterval(()=>socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')})),100);
  await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));
  const answer=(event:Record<string,unknown>)=>socket.send(JSON.stringify({type:'playback.state',probeId:event.id,playbackId:h.downstream.findLast(e=>e.type==='audio')!.playbackId,running:true,audiblePending:false}));
  const first=h.downstream.findLast(e=>e.type==='playback.probe')!;answer(first);
  await waitFor(()=>h.downstream.filter(e=>e.type==='playback.probe').length>=2);
  const pending=h.downstream.findLast(e=>e.type==='playback.probe')!;
  if(change==='mute')socket.send(JSON.stringify({type:'mute',muted:true}));
  if(change==='drawing')socket.send(JSON.stringify({type:'interaction',eventId:'10000000-0000-4000-8000-000000000099',contextKey:`${id}:1:0`,action:'draw',strokeCount:1,pointCount:2}));
  if(change==='speech'){h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'new-speech'}));await waitFor(()=>h.journal.some(e=>(e.details as {phase?:string})?.phase==='speech_started'));}
  if(change==='pause'){h.pause();await refreshClassroom(id);}
  if(change==='lease')h.revoke();
  answer(pending);await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(h.journal.filter(e=>e.name==='silence_prompt').length,0);
  if(change==='lease')assert.equal(h.released,1);
 }finally{if(inputTimer)clearInterval(inputTimer);await h.close();}
});

test('silence recovery restarts thinking time after microphone observation is lost',async()=>{
 const h=await harness('qwen',{delayedResponses:true,silencePromptMs:1800,responseAckMs:5000,heartbeatMs:60000});
 let inputTimer:ReturnType<typeof setInterval>|undefined;
 try{
  const socket=h.connect();await once(socket,'open');await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'response.created'}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',delta:Buffer.alloc(4800,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done'}));
  const quiet=()=>socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));
  inputTimer=setInterval(quiet,100);await waitFor(()=>h.downstream.some(e=>e.type==='playback.probe'));
  const answer=(event:Record<string,unknown>)=>socket.send(JSON.stringify({type:'playback.state',probeId:event.id,playbackId:h.downstream.findLast(e=>e.type==='audio')!.playbackId,running:true,audiblePending:false}));
  answer(h.downstream.findLast(e=>e.type==='playback.probe')!);await new Promise(resolve=>setTimeout(resolve,50));
  clearInterval(inputTimer);inputTimer=undefined;const probes=h.downstream.filter(e=>e.type==='playback.probe').length;
  await new Promise(resolve=>setTimeout(resolve,900));inputTimer=setInterval(quiet,100);
  await waitFor(()=>h.downstream.filter(e=>e.type==='playback.probe').length>probes);
  answer(h.downstream.findLast(e=>e.type==='playback.probe')!);await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(h.journal.filter(e=>e.name==='silence_prompt').length,0,'lost input observation is not confirmed thinking time');
 }finally{if(inputTimer)clearInterval(inputTimer);await h.close();}
});

for(const output of ['none','silent','text'] as const)test(`GPT recovery bounds an explicit speech request with ${output} but no audible output`,async()=>{
 const h=await harness('openai',{responseProgressMs:120,heartbeatMs:60000});
 let timer:ReturnType<typeof setInterval>|undefined;
 try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  if(output==='silent')timer=setInterval(()=>h.upstream?.readyState===WebSocket.OPEN&&h.upstream.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(2400).toString('base64')})),20);
  if(output==='text')h.upstream!.send(JSON.stringify({type:'session.output_transcript.delta',delta:'Hello.'}));
  await waitFor(()=>h.released===1&&h.downstream.some(e=>e.type==='error'));
  assert.equal(h.downstream.find(e=>e.type==='error')?.code,'response_timeout');
  assert(h.journal.some(e=>e.name==='voice_response_timeout'&&(e.details as {state?:string}).state==='gpt_first_audio'));
 }finally{if(timer)clearInterval(timer);await h.close();}
});

test('GPT recovery clears the first-audio deadline on real voice and on learner interruption',async()=>{
 for(const action of ['voice','interrupt'] as const){
  const h=await harness('openai',{responseProgressMs:120,heartbeatMs:60000});
  try{
   const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
   if(action==='voice')h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));
   else socket.send(pcmFrame(true));
   await new Promise(resolve=>setTimeout(resolve,180));assert.equal(h.released,0);assert(!h.downstream.some(e=>e.type==='error'));
  }finally{await h.close();}
 }
});

test('native recovery retains learner cancellation reason while waiting for response.created',async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000});
 try{
  const socket=h.connect();await once(socket,'open');await settleNativeGreeting(h);
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started'}));
  await waitFor(()=>h.journal.some(e=>e.name==='voice_response_cancel'));
  h.upstream!.send(JSON.stringify({type:'response.created'}));
  await waitFor(()=>h.sent.some(e=>e.type==='response.cancel'));
  const states=h.journal.filter(e=>e.name==='voice_response_cancel').map(e=>(e.details as {state?:string}).state);
  assert(states.length>=2);assert(states.every(state=>state==='learner_speech'));
 }finally{await h.close();}
});

for(const next of ['no-native-reply','native-reply','native-before-configuration-ack','new-speech','new-task','explicit-wait'] as const)test(`Qwen overlapping automatic replies recover only the latest completed input: ${next}`,async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000,nativeApplicationInputs:true,delayOverlapConfiguration:next==='native-before-configuration-ack'});
 try{
  const socket=h.connect();await once(socket,'open');await settleNativeGreeting(h);
  const vendor=(e:unknown)=>h.upstream!.send(JSON.stringify(e));
  const speech=(type:string,item_id:string)=>vendor({type:`input_audio_buffer.speech_${type}`,item_id});
  const response=(type:string,id:string,status?:string)=>vendor({type:`response.${type}`,response:{id,status}});
  const audio=(response_id:string,level:number)=>vendor({type:'response.audio.delta',response_id,delta:Buffer.alloc(2400,level).toString('base64')});
  response('created','overlap-greeting');response('done','overlap-greeting','completed');
  speech('started','turn-a');speech('stopped','turn-a');speech('started','turn-b');
  vendor({type:'conversation.item.input_audio_transcription.completed',item_id:'turn-a',transcript:'It looks like a plane.'});
  speech('stopped','turn-b');vendor({type:'conversation.item.input_audio_transcription.completed',item_id:'turn-b',transcript:next==='explicit-wait'?'Please wait.':'Tell me about wings.'});
  response('created','ambiguous-native');await waitFor(()=>h.sent.some(e=>e.type==='response.cancel'));
  audio('ambiguous-native',0x11);response('done','ambiguous-native','cancelled');
  await waitFor(()=>h.journal.some(e=>e.name==='voice_response_cancel_ack'));
  if(next==='native-reply'){response('created','current-native');audio('current-native',0x22);response('done','current-native','completed');}
  if(next==='native-before-configuration-ack'){
   await waitFor(()=>h.sent.some(e=>e.type==='session.update'&&JSON.stringify(e).includes('latest completed learner utterance')));
   response('created','current-native');audio('current-native',0x22);response('done','current-native','completed');vendor({type:'session.updated'});
  }
  if(next==='new-speech')speech('started','turn-c');
  if(next==='new-task'){h.advance();await refreshClassroom(id);await waitFor(()=>h.sent.filter(e=>e.type==='response.create').length===2);}
  if(next==='no-native-reply'){
   await waitFor(()=>h.sent.filter(e=>e.type==='response.create').length===2);
   assert(h.sent.some(e=>e.type==='response.create'&&JSON.stringify(e).includes('latest completed learner utterance')));
   assert.equal(h.transcripts.length,1);assert.equal((h.transcripts[0] as {itemId:string}).itemId,'turn-b');
   assert.equal(h.tools.length,1);assert.equal((h.tools[0] as {name:string}).name,'delegate');
   response('created','overlap-fallback');audio('overlap-fallback',0x22);
   vendor({type:'response.function_call_arguments.done',response_id:'overlap-fallback',call_id:'false-tool',name:'submit_spoken_answer',arguments:JSON.stringify({contextKey:`${id}:1:0`,answer:'Apple.'})});
   response('done','overlap-fallback','completed');
   await waitFor(()=>h.journal.some(e=>e.correlationId==='false-tool'&&e.status==='rejected'));assert.equal(h.tools.length,1);
  }
  if(next==='no-native-reply'||next==='native-reply'||next==='native-before-configuration-ack'){
   await waitFor(()=>h.downstream.some(e=>e.type==='audio'));
   assert(h.downstream.filter(e=>e.type==='audio').every(e=>Buffer.from(String(e.audio),'base64')[0]===0x22));
  }
  await new Promise(resolve=>setTimeout(resolve,750));
  assert.equal(h.sent.filter(e=>e.type==='response.create').length,next==='no-native-reply'||next==='new-task'?2:1);
  assert.equal(h.journal.filter(e=>e.name==='voice_overlap_reply').length,next==='no-native-reply'?1:0);
  assert.equal(h.sent.filter(e=>e.type==='response.cancel').length,1);
  assert.equal(h.downstream.some(e=>e.type==='error'),false);
 }finally{await h.close();}
});

test('GPT recovery does not start a first-audio deadline while output is still gated',async()=>{
 const h=await harness('openai',{responseProgressMs:120,gptOutputWaitMs:2000,heartbeatMs:60000});
 try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));
  h.advance();await refreshClassroom(id);
  await new Promise(resolve=>setTimeout(resolve,180));assert.equal(h.released,0);assert(!h.downstream.some(e=>e.type==='error'));
 }finally{await h.close();}
});

for(const provider of ['qwen','grok'] as const)test(`latency ${provider} binds captured speech to native response and browser audible receipt`,async()=>{
 const h=await harness(provider,{delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));
  h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'greeting'}}));h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'greeting'}}));const barrier=once(h.upstream!,'pong');h.upstream!.ping('latency_greeting');await barrier;
  const inputId='10000000-0000-4000-8000-000000000081',audio=Buffer.alloc(provider==='qwen'?3200:4800,0x11).toString('base64');socket.send(JSON.stringify({type:'audio',audio,latencyInputId:inputId,audioSequence:0}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'latency-input',...(provider==='qwen'?{audio_start_ms:0}:{})}));socket.send(JSON.stringify({type:'diagnostic.input',inputId,firstSequence:0,lastVoiceSequence:0,phase:'stopped',silenceMs:100}));socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(provider==='qwen'?3200:4800).toString('base64'),latencyInputId:inputId,audioSequence:1}));socket.send(JSON.stringify({type:'ping',nonce:'latency_stop'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='latency_stop'));
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'latency-input'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'latency-input',transcript:'Tell me a story.'}));h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'latency-reply'}}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',response_id:'latency-reply',delta:Buffer.alloc(2400,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'latency-reply'}}));
  await waitFor(()=>h.downstream.some(e=>e.type==='diagnostic.latency'&&e.state==='bound'));const bound=h.downstream.find(e=>e.type==='diagnostic.latency'&&e.state==='bound')!;assert.equal(bound.inputId,inputId);assert.equal(bound.lastVoiceSequence,0);assert.equal(bound.basis,'provider_turn');assert(h.downstream.some(e=>e.type==='audio'&&e.latencyMeasurementId===bound.measurementId));assert(h.journal.some(e=>e.name==='transcript'&&(e.details as Record<string,unknown>).measurementId===bound.measurementId));socket.send(JSON.stringify({type:'diagnostic.latency',measurementId:bound.measurementId,phase:'playback_started',waitMs:650,playbackMs:25}));await waitFor(()=>h.journal.some(e=>(e.details as Record<string,unknown>).latencyStage==='playback_started'));assert.equal(h.released,0);
 }finally{await h.close();}
});
test('latency malformed and excessive optional reports do not stop classroom media',async()=>{const h=await harness('qwen',{heartbeatMs:60000});try{const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));for(let i=0;i<40;i++)socket.send(JSON.stringify({type:'diagnostic.latency',measurementId:'invalid',raw:'private',waitMs:i}));socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append')||h.downstream.some(e=>e.type==='error'));assert(!h.downstream.some(e=>e.type==='error'));assert(h.sent.some(e=>e.type==='input_audio_buffer.append'));}finally{await h.close();}});

test('latency GPT uses the explicit resumed application window without inventing provider response boundaries',async()=>{
 const output=outputClock(),h=await harness('openai',{heartbeatMs:60000,audioClock:output.clock,gptOutputQuietMs:80});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.downstream.some(e=>e.type==='ready'));const inputId='10000000-0000-4000-8000-000000000083';socket.send(JSON.stringify({...JSON.parse(pcmFrame(true)),latencyInputId:inputId,audioSequence:0}));await waitFor(()=>h.sent.some(e=>e.type==='session.thinking.append'));const ack=h.sent.findLast(e=>e.type==='session.thinking.append')!;h.upstream!.send(JSON.stringify({type:'session.thinking.appended',client_event_id:ack.event_id}));socket.send(JSON.stringify({type:'diagnostic.input',inputId,firstSequence:0,lastVoiceSequence:0,phase:'stopped',silenceMs:100}));for(let seq=1;seq<=12;seq++)socket.send(JSON.stringify({...JSON.parse(pcmFrame(false)),latencyInputId:inputId,audioSequence:seq}));await waitFor(()=>h.sent.filter(e=>e.type==='session.input_audio.append').length===13);h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(4800).toString('base64')}));await waitFor(()=>h.sent.some(e=>e.type==='session.commentary.append'&&String(e.content).includes('Current objective:')));
  h.upstream!.send(JSON.stringify({type:'session.output_audio.delta',delta:Buffer.alloc(2400,0x11).toString('base64')}));await waitFor(()=>output.timers.size===1);output.advance(100);await waitFor(()=>h.downstream.some(e=>e.type==='diagnostic.latency'&&e.state==='bound'));const bound=h.downstream.find(e=>e.type==='diagnostic.latency'&&e.state==='bound')!;assert.equal(bound.basis,'application_window');assert.equal(bound.lastVoiceSequence,0);assert(h.downstream.some(e=>e.type==='audio'&&e.latencyMeasurementId===bound.measurementId));assert(!h.journal.some(e=>(e.details as Record<string,unknown>)?.latencyStage==='response_started'));socket.send(JSON.stringify({type:'diagnostic.latency',measurementId:bound.measurementId,phase:'playback_started',waitMs:1380}));await waitFor(()=>h.journal.some(e=>(e.details as Record<string,unknown>)?.latencyStage==='playback_started'));assert.equal(h.released,0);
 }finally{await h.close();}
});
for(const mode of ['receipt','missing','wrong'] as const)test(`latency automatic advance only preserves the stopped capture with a checked receipt: ${mode}`,async()=>{
 const h=await harness('qwen',{spokenAdvance:mode,delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'advance-greeting'}}));h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'advance-greeting'}}));const first=once(h.upstream!,'pong');h.upstream!.ping('advance_greeting');await first;const inputId='10000000-0000-4000-8000-000000000084';socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200,0x11).toString('base64'),latencyInputId:inputId,audioSequence:0}));await waitFor(()=>h.sent.some(e=>e.type==='input_audio_buffer.append'));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'advance-input',audio_start_ms:0}));socket.send(JSON.stringify({type:'diagnostic.input',inputId,firstSequence:0,lastVoiceSequence:0,phase:'stopped',silenceMs:100}));socket.send(JSON.stringify({type:'ping',nonce:'advance_stopped'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='advance_stopped'));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'advance-input'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'advance-input',transcript:'Apple.'}));h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'advance-native'}}));await waitFor(()=>h.transcripts.length===1);nativeSpoken(h,'latency-advance');h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'advance-native'}}));await waitFor(()=>Boolean(schedulerResult(h,'latency-advance')));await waitFor(()=>h.sent.filter(e=>e.type==='response.create').length>=2);h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'advance-cue'}}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',response_id:'advance-cue',delta:Buffer.alloc(2400,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'advance-cue'}}));await waitFor(()=>h.downstream.some(e=>e.type==='audio'));const bound=h.downstream.find(e=>e.type==='diagnostic.latency'&&e.state==='bound');assert.equal(Boolean(bound),mode==='receipt');if(bound){socket.send(JSON.stringify({type:'diagnostic.latency',measurementId:bound.measurementId,phase:'playback_started',waitMs:870}));await waitFor(()=>h.journal.some(e=>(e.details as Record<string,unknown>)?.latencyStage==='playback_started'));}assert.equal(h.released,0);
 }finally{await h.close();}
});
test('latency never binds an offset-less late native VAD after two local capture episodes',async()=>{
 const h=await harness('qwen',{delayedResponses:true,heartbeatMs:60000});try{
  const socket=h.connect();await once(socket,'open');await waitFor(()=>h.sent.some(e=>e.type==='response.create'));h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'overlap-greeting'}}));h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'overlap-greeting'}}));const barrier=once(h.upstream!,'pong');h.upstream!.ping('overlap_greeting');await barrier;
  for(const [inputId,seq]of [['10000000-0000-4000-8000-000000000085',0],['10000000-0000-4000-8000-000000000086',2]]as const){socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200,0x11).toString('base64'),latencyInputId:inputId,audioSequence:seq}));socket.send(JSON.stringify({type:'diagnostic.input',inputId,firstSequence:seq,lastVoiceSequence:seq,phase:'stopped',silenceMs:100}));socket.send(JSON.stringify({type:'audio',audio:Buffer.alloc(3200).toString('base64'),latencyInputId:inputId,audioSequence:seq+1}));}socket.send(JSON.stringify({type:'ping',nonce:'overlap_captured'}));await waitFor(()=>h.downstream.some(e=>e.type==='pong'&&e.nonce==='overlap_captured'));
  h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_started',item_id:'old-first-input'}));h.upstream!.send(JSON.stringify({type:'input_audio_buffer.speech_stopped',item_id:'old-first-input'}));h.upstream!.send(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',item_id:'old-first-input',transcript:'Tell me a story.'}));h.upstream!.send(JSON.stringify({type:'response.created',response:{id:'old-first-response'}}));h.upstream!.send(JSON.stringify({type:'response.audio.delta',response_id:'old-first-response',delta:Buffer.alloc(2400,0x11).toString('base64')}));h.upstream!.send(JSON.stringify({type:'response.done',response:{id:'old-first-response'}}));await waitFor(()=>h.downstream.some(e=>e.type==='audio'));assert(!h.downstream.some(e=>e.type==='diagnostic.latency'&&e.state==='bound'));assert(h.downstream.filter(e=>e.type==='audio').every(e=>e.latencyMeasurementId===null));assert(h.journal.some(e=>(e.details as Record<string,unknown>)?.latencyStage==='unmeasured'&&(e.details as Record<string,unknown>)?.state==='playback_unbound'));assert.equal(h.released,0);
 }finally{await h.close();}
});
