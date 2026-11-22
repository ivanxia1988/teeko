import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { decodePcm16, MAX_PCM_MESSAGE_BYTES, PcmVoiceAudio, pcmBytesToBase64, type PcmAudioDependencies } from '../lib/voice-audio';

function pcm(samples: number[]) {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  samples.forEach((value, index) => view.setInt16(index * 2, value, true));
  return pcmBytesToBase64(bytes);
}
function tone(duration: number, rate = 24000, amplitude = 16000) { return pcm(Array.from({ length: Math.round(duration * rate) }, () => amplitude)); }

test('PCM helpers preserve signed little-endian samples and reject malformed or oversized input before allocation', () => {
  assert.deepEqual(Array.from(decodePcm16(pcm([-32768, -16384, 0, 16384, 32767]))), [-1, -.5, 0, .5, 32767 / 32768]);
  for (const invalid of ['', 'a', '!!!!', 'AA==', 'AAA===', 'data:audio/wav;base64,AAAA', 'A'.repeat(Math.ceil(MAX_PCM_MESSAGE_BYTES / 3) * 4 + 4)]) assert.throws(() => decodePcm16(invalid));
  assert.throws(() => pcmBytesToBase64(new Uint8Array(MAX_PCM_MESSAGE_BYTES + 1)));
});

const workletCode = readFileSync(new URL('../public/voice-capture.worklet.js', import.meta.url), 'utf8');
type CaptureEvent={data:{type:string;audio?:ArrayBuffer;level?:number;at?:number;epoch?:number;muted?:boolean}};
type CaptureProcessor={port:{onmessage:(event:CaptureEvent)=>void};process(input:Float32Array[][],output:Float32Array[][]):boolean};
type CaptureConstructor=new(options:{processorOptions:{sampleRate:number;frameMs:number}})=>CaptureProcessor;
function captureHarness(nativeRate: number, outputRate: number, frameMs: number) {
  let Processor!:CaptureConstructor;
  const frames: { type: string; audio: ArrayBuffer; level: number; at: number; epoch: number }[] = [];
  const globals = {
    sampleRate: nativeRate, currentTime: 0, Float32Array, ArrayBuffer, DataView, Math, Number,
    AudioWorkletProcessor: class { port = { onmessage: null as ((event:CaptureEvent) => void) | null, postMessage: (data:unknown) => frames.push(data as typeof frames[number]) }; },
    registerProcessor: (_name: string, klass:unknown) => { Processor = klass as CaptureConstructor; },
  };
  runInNewContext(workletCode, globals);
  const processor = new Processor({ processorOptions: { sampleRate: outputRate, frameMs } });
  let position = 0;
  const process = (input: Float32Array, sizes: number[]) => {
    let offset = 0, block = 0;
    while (offset < input.length) {
      const size = Math.min(sizes[block++ % sizes.length], input.length - offset);
      globals.currentTime = position / nativeRate;
      const output = new Float32Array(size).fill(1);
      processor.process([[input.subarray(offset, offset + size)]], [[output]]);
      assert(output.every(value => value === 0), 'microphone graph output must be silent');
      offset += size; position += size;
    }
  };
  return { frames, processor, process };
}
function joinedPcm(frames: { audio: ArrayBuffer }[]) {
  const bytes = new Uint8Array(frames.reduce((count, frame) => count + frame.audio.byteLength, 0));
  let offset = 0;
  for (const frame of frames) { bytes.set(new Uint8Array(frame.audio), offset); offset += frame.audio.byteLength; }
  return bytes;
}

test('the actual capture worklet continuously resamples 44.1/48k render quanta into exact 20/100ms PCM frames', () => {
  for (const rate of [44100, 48000]) for (const frameMs of [20, 100]) {
    const samples = Float32Array.from({ length: rate }, (_, index) => .5 * Math.sin(2 * Math.PI * 1000 * index / rate));
    const a = captureHarness(rate, 16000, frameMs), b = captureHarness(rate, 16000, frameMs);
    a.process(samples, [128]); b.process(samples, [37, 111, 256, 19]);
    assert.equal(a.frames.length, 1000 / frameMs);
    assert(a.frames.every(frame => frame.audio.byteLength === 16000 * frameMs / 1000 * 2));
    assert.deepEqual(joinedPcm(a.frames), joinedPcm(b.frames), 'block boundaries must not alter output');
    const output = decodePcm16(pcmBytesToBase64(joinedPcm(a.frames))), rms = Math.sqrt(output.subarray(100).reduce((sum, value) => sum + value ** 2, 0) / (output.length - 100));
    assert(rms > .33 && rms < .37, `1kHz speech-band amplitude must survive, got ${rms}`);
  }
});

test('capture anti-aliases downsampling and mute drops partial old speech rather than replaying it on resume', () => {
  const high = captureHarness(48000, 16000, 20);
  high.process(Float32Array.from({ length: 48000 }, (_, index) => .5 * Math.sin(2 * Math.PI * 12000 * index / 48000)), [128]);
  const filtered = decodePcm16(pcmBytesToBase64(joinedPcm(high.frames))).subarray(100);
  const rms = Math.sqrt(filtered.reduce((sum, value) => sum + value ** 2, 0) / filtered.length);
  assert(rms < .03, `out-of-band signal must not alias into 4kHz, got ${rms}`);
  const muted = captureHarness(16000, 16000, 20);
  muted.process(new Float32Array(160).fill(.7), [128]); assert.equal(muted.frames.length, 0);
  muted.processor.port.onmessage({ data: { type: 'mute', muted: true, epoch: 1 } });
  muted.process(new Float32Array(1600).fill(.7), [128]); assert.equal(muted.frames.length, 0);
  muted.processor.port.onmessage({ data: { type: 'mute', muted: false, epoch: 2 } });
  muted.process(new Float32Array(320).fill(.2), [128]); assert.equal(muted.frames.length, 1);
  assert.equal(muted.frames[0].epoch, 2);
  const resumed = decodePcm16(pcmBytesToBase64(muted.frames[0].audio)); assert(resumed.every(value => value > .19 && value < .21));
  muted.processor.port.onmessage({ data: { type: 'stop' } });
  assert.equal(muted.processor.process([[new Float32Array(128)]], [[new Float32Array(128)]]), false);
});

class FakeSource {
  buffer:unknown; onended: (() => void) | null = null; startedAt: number | null = null; stopped = false; disconnected = false;
  connect() {} start(at: number) { this.startedAt = at; } stop() { this.stopped = true; } disconnect() { this.disconnected = true; }
}
function audioHarness(options: { addModule?: () => Promise<void>;now?:()=>number;onAudioDiagnostics?:()=>void } = {}) {
  const sources: FakeSource[] = [], messages:Record<string,unknown>[] = [], issues: string[] = [], frames: string[] = [], levels: [string, number][] = [], queues: number[] = [];
  let tick: (() => void) | null = null, cleared = 0, trackStops = 0, moduleCalls = 0;
  const capture = { port: { onmessage: null as ((event:CaptureEvent) => void) | null, postMessage: (message:Record<string,unknown>) => messages.push(message), close() {} }, onprocessorerror: null, connect() {}, disconnect() {} };
  const context = {
    currentTime: 0, state: 'running', closeCalls: 0, resumeCalls: 0, destination: {},onstatechange:null as (()=>void)|null,
    audioWorklet: { addModule: async () => { moduleCalls++; await options.addModule?.(); } },
    resume: async () => { context.resumeCalls++; context.state = 'running'; },
    close: async () => { context.closeCalls++; context.state = 'closed'; },
    createBuffer: (_channels: number, size: number, rate: number) => ({ duration: size / rate, copyToChannel: (values: Float32Array) => assert.equal(values.length, size) }),
    createBufferSource: () => { const source = new FakeSource(); sources.push(source); return source; },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
  };
  const dependencies: Partial<PcmAudioDependencies> = {
    context: () => context as unknown as AudioContext,
    worklet: () => capture as unknown as AudioWorkletNode,
    every: callback => { tick = callback; return 1 as unknown as ReturnType<typeof setInterval>; },
    clear: () => { cleared++; tick = null; },
    now:options.now??(()=>context.currentTime*1000),
  };
  const playbackStates:{running:boolean;audiblePending:boolean}[]=[],metrics:import('../lib/voice-audio').PcmPlaybackMetrics[]=[],audioDiagnostics:import('../lib/classroom-audio-diagnostics').AudioContinuityStats[]=[];
  const unavailable:import('../lib/voice-audio').PcmUnavailablePlayback[]=[];const audible:import('../lib/voice-audio').PcmAudiblePlayback[]=[],captureMetrics:import('../lib/voice-audio').PcmCaptureMetrics[]=[];
  const audio = new PcmVoiceAudio({ inputSampleRate: 16000, frameMs: 20, onFrame: (frame,metrics) => {frames.push(frame);if(metrics)captureMetrics.push(metrics);}, onLevel: (role, level) => levels.push([role, level]), onQueue: value => queues.push(value), onIssue: message => issues.push(message),onPlaybackState:state=>playbackStates.push(state),onPlaybackMetrics:state=>metrics.push(state),onAudiblePlayback:event=>audible.push(event),onPlaybackUnavailable:event=>unavailable.push(event),onAudioDiagnostics:state=>{audioDiagnostics.push(state);options.onAudioDiagnostics?.();} }, dependencies);
  const stream = { getTracks: () => [{ stop: () => { trackStops++; } }] } as unknown as MediaStream;
  return { audio, stream, capture, context, sources, messages, issues, frames, levels, queues, playbackStates,metrics,audioDiagnostics,audible,unavailable,captureMetrics,tick: () => tick?.(), get cleared() { return cleared; }, get trackStops() { return trackStops; }, get moduleCalls() { return moduleCalls; } };
}

test('audio continuity emits bounded five-second windows without logging individual chunks or PCM',()=>{
 const h=audioHarness();
 for(let i=0;i<100;i++){h.context.currentTime=i*.05;h.audio.playChunk(tone(.05,24000,i%2?0:16000),24000,'same-stream');h.tick();}
 assert.equal(h.audioDiagnostics.length,0);
 h.context.currentTime=5;h.tick();assert.equal(h.audioDiagnostics.length,1);
 const stats=h.audioDiagnostics[0];assert.equal(stats.boundary,'browser');assert.equal(stats.windowMs,5000);assert.equal(stats.chunkCount,100);assert.equal(stats.audioMs,5000);assert.equal(stats.audibleChunkCount,50);assert.equal(stats.maxArrivalGapMs,50);assert.equal(stats.playbackGapCount,0);assert.equal(stats.playbackGapMs,0);assert.equal(stats.suspendedMs,0);
 assert(Object.values(stats).every(value=>typeof value==='number'||value==='browser'));
 h.context.currentTime=20;h.tick();assert.equal(h.audioDiagnostics.length,1,'natural silence cannot create repeated empty windows');h.audio.close();
});

test('late chunks measure an observed scheduling gap but first chunks and explicit interruptions do not',()=>{
 const h=audioHarness();h.audio.playChunk(tone(.05),24000,'same');h.context.currentTime=.09;h.audio.playChunk(tone(.05),24000,'same');h.audio.cancelPlayback();
 assert.equal(h.audioDiagnostics.length,1);assert.equal(h.audioDiagnostics[0].chunkCount,2);assert.equal(h.audioDiagnostics[0].maxArrivalGapMs,90);assert.equal(h.audioDiagnostics[0].playbackGapCount,1);assert.equal(h.audioDiagnostics[0].playbackGapMs,40);assert.equal(h.audioDiagnostics[0].maxPlaybackGapMs,40);
 h.context.currentTime=30;h.audio.playChunk(tone(.05),24000,'same');h.audio.close();
 assert.equal(h.audioDiagnostics[1].chunkCount,1);assert.equal(h.audioDiagnostics[1].maxArrivalGapMs,0);assert.equal(h.audioDiagnostics[1].playbackGapCount,0);assert.deepEqual(h.issues,[]);
});

test('suspended WebAudio is measured separately and cannot become a false arrival or playback gap',()=>{
 let wall=0;const h=audioHarness({now:()=>wall});h.audio.playChunk(tone(.05),24000,'same');wall=20;h.context.currentTime=.02;h.context.state='suspended';h.context.onstatechange?.();
 wall=220;h.context.state='running';h.context.onstatechange?.();wall=240;h.context.currentTime=.04;h.audio.playChunk(tone(.05),24000,'same');h.audio.close();
 assert.equal(h.audioDiagnostics.length,1);assert.equal(h.audioDiagnostics[0].suspendedMs,200);assert.equal(h.audioDiagnostics[0].playbackGapCount,0);assert.equal(h.audioDiagnostics[0].maxArrivalGapMs,0);
});

test('new diagnostic streams and diagnostic callback failures never alter playback',()=>{
 const h=audioHarness();h.audio.playChunk(tone(.05),24000,'first');h.context.currentTime=1;h.audio.playChunk(tone(.05),24000,'second');h.audio.close();assert.equal(h.audioDiagnostics[0].playbackGapCount,0);
 const s=audioHarness({onAudioDiagnostics:()=>{throw new Error('diagnostic-only');}});s.audio.playChunk(tone(.05),24000);s.audio.cancelPlayback();s.audio.playChunk(tone(.05),24000);assert.deepEqual(s.issues,[]);assert.equal(s.sources.length,2);s.audio.close();
});

test('window rollover retains continuity, while an explicit diagnostic boundary preserves sound and resets attribution',()=>{
 const h=audioHarness();for(let i=0;i<100;i++){h.context.currentTime=i*.05;h.audio.playChunk(tone(.05),24000,'stream');h.tick();}
 h.context.currentTime=5;h.tick();h.context.currentTime=5.1;h.audio.playChunk(tone(.05),24000,'stream');h.audio.flushAudioDiagnostics();assert.equal(h.audioDiagnostics[1].playbackGapCount,1);assert.equal(h.audioDiagnostics[1].maxPlaybackGapMs,100);
 assert(!h.sources.at(-1)!.stopped,'flushing observation never cuts the teacher sound');h.context.currentTime=6;h.audio.playChunk(tone(.05),24000,'stream');h.audio.close();assert.equal(h.audioDiagnostics[2].playbackGapCount,0);
});

test('a backgrounded browser emits bounded paused-clock data without claiming a playback gap',()=>{
 let now=0;const h=audioHarness({now:()=>now});h.audio.playChunk(tone(.05),24000,'stream');h.context.state='suspended';h.context.onstatechange?.();now=600000;h.tick();
 assert.equal(h.audioDiagnostics.length,1);assert.equal(h.audioDiagnostics[0].windowMs,60000);assert.equal(h.audioDiagnostics[0].suspendedMs,60000);assert.equal(h.audioDiagnostics[0].playbackGapCount,0);h.audio.close();
});

test('playback uses the audio clock, preserves contiguous scheduling and cancels every future source on interruption', () => {
  const h = audioHarness();
  assert.equal(h.context.resumeCalls, 1);
  h.audio.playChunk(tone(.1), 24000); h.audio.playChunk(tone(.1), 24000);
  assert.equal(h.sources[0].startedAt, .015); assert.equal(h.sources[1].startedAt, .115);
  assert.equal(h.levels.length, 0, 'receiving a chunk is not audible teacher speech');
  h.tick(); assert.equal(h.levels.at(-1)?.[1], 0);
  h.context.currentTime = .035; h.tick(); assert(h.levels.at(-1)![1] > .45);
  h.audio.cancelPlayback(); assert(h.sources.every(source => source.stopped && source.disconnected));
  assert.equal(h.queues.at(-1), 0); assert.equal(h.levels.at(-1)?.[1], 0);
  h.context.currentTime = 1; h.audio.playChunk(tone(.1), 24000); assert.equal(h.sources[2].startedAt, 1.015);
  h.context.currentTime = 2; h.tick(); assert.equal(h.levels.at(-1)?.[1], 0); assert.deepEqual(h.issues, [], 'ordinary silence is never an underrun/stutter');
  h.audio.close(); assert.equal(h.context.closeCalls, 1); assert.equal(h.cleared, 1); assert.equal(h.trackStops, 0);
});

test('suspended audio reports zero teacher level and queue overflow explicitly terminates playback', async () => {
  const h = audioHarness(); h.audio.playChunk(tone(.1), 24000);
  h.context.state = 'suspended'; h.context.currentTime = .03; h.tick(); assert.equal(h.levels.at(-1)?.[1], 0);
  await h.audio.resume(); h.tick(); assert(h.levels.at(-1)![1] > .45);
  h.audio.cancelPlayback();
  for (let i = 0; i < 20; i++) h.audio.playChunk(tone(.1), 24000);
  assert.equal(h.issues.length, 1); assert.match(h.issues[0], /积压/); assert.equal(h.context.closeCalls, 1);
  assert(h.sources.every(source => source.stopped && source.disconnected));
  h.audio.playChunk(tone(.1), 24000); assert.equal(h.issues.length, 1, 'failure must not restart or retry billed media');
});

test('capture epochs reject queued pre-mute frames and close releases nodes without owning microphone tracks', async () => {
  const h = audioHarness(); await h.audio.startCapture(h.stream); assert.equal(h.moduleCalls, 1);
  const message = (epoch: number) => ({ data: { type: 'frame', audio: new ArrayBuffer(640), level: .1, at: h.context.currentTime, epoch } });
  h.capture.port.onmessage?.(message(0)); assert.equal(h.frames.length, 1);
  h.audio.mute(true); h.capture.port.onmessage?.(message(0)); assert.equal(h.frames.length, 1);
  h.audio.mute(false); h.capture.port.onmessage?.(message(0)); h.capture.port.onmessage?.(message(1)); assert.equal(h.frames.length, 1);
  h.capture.port.onmessage?.(message(2)); assert.equal(h.frames.length, 2);
  assert.deepEqual(h.messages.slice(-2).map(message => [message.muted, message.epoch]), [[true, 1], [false, 2]]);
  h.audio.close(); h.audio.close(); assert.equal(h.context.closeCalls, 1); assert.equal(h.trackStops, 0); assert.equal(h.capture.port.onmessage, null);
});

test('old capture backlogs and malformed output fail visibly rather than sending bursts or allocating unbounded memory', async () => {
  const h = audioHarness(); await h.audio.startCapture(h.stream); h.context.currentTime = 1;
  h.capture.port.onmessage?.({ data: { type: 'frame', audio: new ArrayBuffer(640), level: .1, at: 0, epoch: 0 } });
  assert.equal(h.frames.length, 0); assert.equal(h.issues.length, 1); assert.match(h.issues[0], /积压/);
  const bad = audioHarness(); bad.audio.playChunk('AA==', 24000); assert.equal(bad.issues.length, 1); assert.match(bad.issues[0], /格式/); assert.equal(bad.context.closeCalls, 1);
});

test('closing while the worklet module loads cannot attach a late live microphone graph', async () => {
  let release: (() => void) | undefined;
  const h = audioHarness({ addModule: () => new Promise<void>(resolve => { release = resolve; }) });
  const loading = h.audio.startCapture(h.stream); await Promise.resolve(); await Promise.resolve();
  assert(release); h.audio.close(); release(); await assert.rejects(loading);
  assert.equal(h.capture.port.onmessage, null); assert.equal(h.context.closeCalls, 1); assert.equal(h.trackStops, 0);
});

test('playback readiness requires running WebAudio and no audible scheduled samples',()=>{
 const h=audioHarness();h.audio.playChunk(tone(.1),24000);assert.deepEqual(h.playbackStates.at(-1),{running:true,audiblePending:true});
 h.context.state='suspended';h.tick();assert.deepEqual(h.playbackStates.at(-1),{running:false,audiblePending:true});
 h.audio.cancelPlayback();assert.deepEqual(h.playbackStates.at(-1),{running:false,audiblePending:false});
 h.context.state='running';h.audio.playChunk(tone(.1,24000,0),24000);h.tick();assert.deepEqual(h.playbackStates.at(-1),{running:true,audiblePending:false});
 h.audio.playChunk(tone(.1),24000);h.context.currentTime=1;h.tick();assert.deepEqual(h.playbackStates.at(-1),{running:true,audiblePending:false});h.audio.close();
 assert.deepEqual(h.playbackStates.at(-1),{running:false,audiblePending:false});
});

test('a future short voiced burst cannot be reported as a quiet playback queue',()=>{
 const h=audioHarness(),samples=Array(2400).fill(0);samples[2300]=2000;h.audio.playChunk(pcm(samples),24000);
 assert.deepEqual(h.playbackStates.at(-1),{running:true,audiblePending:true});h.audio.close();
});

 test('diagnostic playback is tagged per response and starts only on the running audio clock',()=>{
 const h=audioHarness();h.audio.playChunk(tone(.1),24000,'span-a');assert.deepEqual(h.metrics.at(-1),{tag:'span-a',running:true,playing:false,pending:true,queueMs:115});
 h.context.state='suspended';h.context.currentTime=.03;h.tick();assert.equal(h.metrics.at(-1)?.playing,false);
 h.context.state='running';h.tick();assert.equal(h.metrics.at(-1)?.playing,true);
 h.audio.playChunk(tone(.1),24000,'span-b');assert.equal(h.metrics.filter(m=>m.tag==='span-b').at(-1)?.playing,false);
 h.context.currentTime=.15;h.tick();assert.equal(h.metrics.filter(m=>m.tag==='span-a').at(-1)?.pending,false);assert.equal(h.metrics.filter(m=>m.tag==='span-b').at(-1)?.playing,true);
 h.audio.cancelPlayback();assert.equal(h.metrics.at(-1)?.pending,false);h.audio.close();
 });

test('diagnostic playback ignores leading silence until the first audible sample of a tagged reply',()=>{
 const h=audioHarness(),samples=Array(2400).fill(0);samples[1200]=2400;
 h.audio.playChunk(tone(.05,24000,0),24000,'point-reply');
 h.audio.playChunk(pcm(samples),24000,'point-reply');
 h.context.currentTime=.035;h.tick();assert.equal(h.metrics.at(-1)?.playing,false);
 h.context.currentTime=.085;h.tick();assert.equal(h.metrics.at(-1)?.playing,false);
 h.context.currentTime=.120;h.tick();assert.equal(h.metrics.at(-1)?.playing,true);
 h.audio.close();
});

test('a tagged audible burst ending between clock polls is measured on natural completion only',()=>{
 const h=audioHarness();h.audio.playChunk(tone(.010),24000,'short-reply');
 h.context.currentTime=.030;h.sources[0].onended?.();
 assert.deepEqual(h.metrics.at(-1),{tag:'short-reply',running:true,playing:false,audibleEnded:true,pending:false,queueMs:0});
 h.audio.playChunk(tone(.010,24000,0),24000,'silence');
 h.context.currentTime=.08;h.sources[1].onended?.();
 assert(!h.metrics.some(m=>m.tag==='silence'&&m.audibleEnded));
 h.audio.playChunk(tone(.010),24000,'cancelled');h.audio.cancelPlayback();
 assert.equal(h.sources[2].onended,null);assert(!h.metrics.some(m=>m.tag==='cancelled'&&m.audibleEnded));h.audio.close();
});

test('latency audio starts at the first voiced sample, ignoring leading or entirely silent PCM',()=>{
 const silent=audioHarness();silent.audio.playChunk(tone(.1,24000,0),24000,undefined,'measure-silent');silent.context.currentTime=.1;silent.tick();assert.equal(silent.audible.length,0);silent.audio.close();
 const h=audioHarness(),values=Array(2400).fill(0);for(let i=1200;i<values.length;i++)values[i]=10000;
 h.audio.playChunk(pcm(values),24000,undefined,'measure-a');h.context.currentTime=.04;h.tick();assert.equal(h.audible.length,0);
 h.context.currentTime=.08;h.tick();assert.equal(h.audible.length,1);assert.equal(h.audible[0].measurementId,'measure-a');assert.equal(Math.round(h.audible[0].atMs),65);
 h.context.currentTime=.1;h.tick();assert.equal(h.audible.length,1);h.audio.close();
});
test('latency audio cannot report suspended, unknown, or cancelled playback as a first voice',()=>{
 const h=audioHarness();h.audio.playChunk(tone(.1),24000,undefined,'measure-a');h.context.state='suspended';h.tick();assert.equal(h.audible.length,0);
 h.audio.cancelPlayback();h.context.state='running';h.context.currentTime=.1;h.tick();assert.equal(h.audible.length,0);
 h.audio.playChunk(tone(.1),24000);h.context.currentTime=.2;h.tick();assert.equal(h.audible.length,0);h.audio.close();
});
test('latency capture metrics use validated frame timestamps and real frame level, not display-level clearing',async()=>{
 const h=audioHarness();await h.audio.startCapture(h.stream);h.context.currentTime=.1;
 h.capture.port.onmessage?.({data:{type:'frame',audio:new ArrayBuffer(640),level:.1,at:.08,epoch:0}});
 assert.equal(h.captureMetrics.length,1);assert(Math.abs(h.captureMetrics[0].atMs-80.0625)<.01);assert.equal(h.captureMetrics[0].level,.1);assert.equal(h.captureMetrics[0].frameMs,20);
 h.context.currentTime=.4;h.tick();assert.equal(h.captureMetrics.length,1);h.audio.mute(true);h.capture.port.onmessage?.({data:{type:'frame',audio:new ArrayBuffer(640),level:.1,at:.4,epoch:0}});assert.equal(h.captureMetrics.length,1);h.audio.close();
});

test('a discontinuous AudioContext clock cannot backdate first voice through a suspended period',()=>{
 let now=0;const h=audioHarness({now:()=>now});h.audio.playChunk(tone(.1),24000,undefined,'measure-clock');
 now=1050;h.context.currentTime=.05;h.tick();assert.equal(h.audible.length,0);assert.deepEqual(h.unavailable,[{measurementId:'measure-clock',reason:'playback_clock'}]);
 h.tick();assert.equal(h.unavailable.length,1);h.audio.close();
});
test('a context suspension between polling ticks discards the pending measurement even after immediate resume',()=>{
 const h=audioHarness();h.audio.playChunk(tone(.1),24000,undefined,'measure-paused');
 h.context.state='suspended';h.context.onstatechange?.();h.context.state='running';h.context.currentTime=.05;h.tick();
 assert.equal(h.audible.length,0);assert.deepEqual(h.unavailable,[{measurementId:'measure-paused',reason:'playback_clock'}]);h.audio.close();
});
