/** Browser PCM audio only. Transport and MediaStream track ownership stay outside. */
import type { ClassroomVoiceErrorCode } from './classroom-voice-errors';
import { AUDIO_DIAGNOSTIC_WINDOW_MS,type AudioContinuityStats } from './classroom-audio-diagnostics';
export type PcmCaptureMetrics={atMs:number;frameMs:number;level:number};
export type PcmAudiblePlayback={measurementId:string;atMs:number};
export type PcmUnavailablePlayback={measurementId:string;reason:'playback_clock'};
export type PcmPlaybackMetrics={tag:string;running:boolean;playing:boolean;audibleEnded?:true;pending:boolean;queueMs:number};
export type PcmPlaybackState={running:boolean;audiblePending:boolean};
export type PcmVoiceAudioOptions = {
  inputSampleRate: number;
  frameMs: number;
  onFrame: (audioBase64: string,metrics?:PcmCaptureMetrics) => void;
  onAudiblePlayback?:(event:PcmAudiblePlayback)=>void;
  onPlaybackUnavailable?:(event:PcmUnavailablePlayback)=>void;
  onLevel: (role: 'child' | 'teacher', level: number) => void;
  onQueue?: (milliseconds: number) => void;
  onPlaybackState?:(state:PcmPlaybackState)=>void;
  onPlaybackMetrics?:(state:PcmPlaybackMetrics)=>void;
  onAudioDiagnostics?:(stats:AudioContinuityStats)=>void;
  onIssue?: (message: string, code?: ClassroomVoiceErrorCode) => void;
};
export type PcmAudioDependencies = {
  context: () => AudioContext;
  worklet: (context: AudioContext, options: AudioWorkletNodeOptions) => AudioWorkletNode;
  every: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  clear: (timer: ReturnType<typeof setInterval>) => void;
  now:()=>number;
};
export const MAX_PCM_MESSAGE_BYTES = 192_000;
export const MAX_PLAYBACK_QUEUE_SECONDS = 2;
const MAX_PLAYBACK_SOURCES = 256;
const MAX_CAPTURE_BACKLOG_SECONDS = .5;
const validRate = (value: number) => Number.isInteger(value) && value >= 8000 && value <= 48000;

export function pcmBytesToBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (bytes.length > MAX_PCM_MESSAGE_BYTES) throw new Error('PCM message is too large.');
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}

/** Provider output must be mono signed little-endian PCM16, never a media file. */
export function decodePcm16(base64: string): Float32Array<ArrayBuffer> {
  if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(MAX_PCM_MESSAGE_BYTES / 3) * 4 || base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Invalid PCM message.');
  let binary: string;
  try { binary = atob(base64); } catch { throw new Error('Invalid PCM encoding.'); }
  if (!binary.length || binary.length > MAX_PCM_MESSAGE_BYTES || binary.length % 2) throw new Error('Invalid PCM byte count.');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer), values = new Float32Array(bytes.length / 2);
  for (let i = 0; i < values.length; i++) values[i] = view.getInt16(i * 2, true) / 32768;
  return values;
}

type Playback = { source: AudioBufferSourceNode; samples: Float32Array<ArrayBuffer>; rate: number; start: number; end: number;audible:boolean;firstAudibleAt:number|null;receivedAtMs:number;receivedAudioAt:number;latencyId?:string;tag?:string };
type AudioWindow={at:number;lastStateAt:number;running:boolean;stats:AudioContinuityStats};
const diagnosticNumber=(value:number,max=60000)=>Math.min(max,Math.max(0,Math.round(value)));

export class PcmVoiceAudio {
  private readonly options: PcmVoiceAudioOptions;
  private readonly dependencies: PcmAudioDependencies;
  private readonly context: AudioContext;
  private input: MediaStreamAudioSourceNode | null = null;
  private capture: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private captureStarting = false;
  private closed = false;
  private failed = false;
  private muted = false;
  private captureEpoch = 0;
  private lastCaptureAt = -Infinity;
  private playback = new Map<AudioBufferSourceNode, Playback>();
  private nextAt = 0;
  private metricTags=new Set<string>();
  private readonly heardMeasurements=new Set<string>();
  private audioWindow:AudioWindow|null=null;
  private audioContinuity:{at:number;end:number;tag:string|undefined}|null=null;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(options: PcmVoiceAudioOptions, dependencies: Partial<PcmAudioDependencies> = {}) {
    if (!validRate(options.inputSampleRate) || !Number.isFinite(options.frameMs) || options.frameMs < 10 || options.frameMs > 250 || !Number.isInteger(options.inputSampleRate * options.frameMs / 1000)) throw new Error('不支持当前语音采样配置。');
    this.options = options;
    this.dependencies = {
      context: () => {
        if (typeof AudioContext === 'undefined') throw new Error('当前浏览器不支持实时 PCM 语音，请更换浏览器。');
        return new AudioContext({ latencyHint: 'interactive' });
      },
      worklet: (context, configuration) => new AudioWorkletNode(context, 'littleleaf-pcm-capture', configuration),
      every: (callback, milliseconds) => setInterval(callback, milliseconds),
      clear: timer => clearInterval(timer),
      now:()=>performance.now(),
      ...dependencies,
    };
    // Construct synchronously from the connect gesture so autoplay policy can
    // authorize audio. A later getUserMedia/addModule continuation is too late.
    this.context = this.dependencies.context();
    this.context.onstatechange=()=>{this.observeAudioClock();this.audioContinuity=null;this.reportAudiblePlayback();};
    void this.context.resume().catch(() => {});
  }
  private ensureTimer() {
    if (this.timer === null) this.timer = this.dependencies.every(() => this.tick(), 40);
  }
  private issue(message: string, code: ClassroomVoiceErrorCode = 'audio_capture_failed') {
    if (this.failed || this.closed) return;
    this.failed = true; this.close(); this.options.onIssue?.(message, code);
  }
  async startCapture(stream: MediaStream): Promise<void> {
    if (this.closed) throw new Error('语音采集已经结束，请重新连接。');
    if (this.capture || this.captureStarting) throw new Error('语音采集已经开启。');
    this.captureStarting = true;
    try {
      if (!this.context.audioWorklet) throw new Error('AudioWorklet unavailable.');
      await this.context.resume();
      await this.context.audioWorklet.addModule('/voice-capture.worklet.js');
      if (this.closed) throw new Error('Capture closed while loading.');
      const capture = this.dependencies.worklet(this.context, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, processorOptions: { sampleRate: this.options.inputSampleRate, frameMs: this.options.frameMs } });
      this.capture = capture;
      capture.onprocessorerror = () => this.issue('实时语音采集发生异常，请重新连接。');
      capture.port.onmessage = event => {
        if (this.closed || this.muted || event.data?.type !== 'frame' || event.data.epoch !== this.captureEpoch) return;
        const frame = event.data.audio;
        const expectedBytes = this.options.inputSampleRate * this.options.frameMs / 1000 * 2;
        if (!(frame instanceof ArrayBuffer) || frame.byteLength !== expectedBytes) { this.issue('语音采集返回了异常音频帧，请重新连接。', 'invalid_audio'); return; }
        if (typeof event.data.at === 'number' && this.context.currentTime - event.data.at > MAX_CAPTURE_BACKLOG_SECONDS) { this.issue('浏览器音频采集积压，已停止发送以免突发上传旧声音，请重新连接。', 'audio_capture_backlog'); return; }
        this.lastCaptureAt = this.context.currentTime;
        const level = typeof event.data.level === 'number' && Number.isFinite(event.data.level) ? Math.max(0, Math.min(1, event.data.level)) : 0;
        this.options.onLevel('child', level);
        try { this.options.onFrame(pcmBytesToBase64(frame),this.captureMetrics(event.data.at,event.data.level)); }
        catch { this.issue('实时语音发送失败，请重新连接。', 'transport_error'); }
      };
      this.input = this.context.createMediaStreamSource(stream);
      this.sink = this.context.createGain(); this.sink.gain.value = 0;
      this.input.connect(capture); capture.connect(this.sink); this.sink.connect(this.context.destination);
      capture.port.postMessage({ type: 'mute', muted: this.muted, epoch: this.captureEpoch });
      this.ensureTimer();
    } catch {
      if (!this.closed) this.issue('无法启动实时 PCM 采集，请确认浏览器支持 AudioWorklet 并重新连接。');
      throw new Error('无法启动实时 PCM 语音采集。');
    } finally { this.captureStarting = false; }
  }
  playChunk(base64: string, sampleRate: number, tag?:string,latencyId?:string): void {
    if (this.closed) return;
    try {
      if (!validRate(sampleRate)) throw new Error('Invalid audio sample rate.');
      const samples = decodePcm16(base64), now = this.context.currentTime;
      const start = Math.max(now + .015, this.nextAt), end = start + samples.length / sampleRate;
      if (end - now > MAX_PLAYBACK_QUEUE_SECONDS || this.playback.size >= MAX_PLAYBACK_SOURCES) {
        this.issue('老师声音积压超过安全播放范围，已停止本次音频，请重新连接或切换网络。', 'audio_playback_backlog'); return;
      }
      const buffer = this.context.createBuffer(1, samples.length, sampleRate); buffer.copyToChannel(samples, 0);
      const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
      // A brief future sound must not disappear in a mostly silent chunk's average.
      const firstVoice=samples.findIndex(sample=>Math.abs(sample)>=.015);
      const entry: Playback = { source, samples, rate: sampleRate, start, end,audible:firstVoice>=0,firstAudibleAt:firstVoice<0?null:start+firstVoice/sampleRate,receivedAtMs:this.dependencies.now(),receivedAudioAt:now,...(latencyId?{latencyId}:{}),...(tag?{tag}: {}) };
      this.playback.set(source, entry); this.nextAt = end;
      source.onended = () => {
        this.reportAudiblePlayback();this.playback.delete(source);try{source.disconnect();}catch{}
        // A short sound may finish between polls. Stops detach this natural-end callback.
        const audibleEnded=entry.firstAudibleAt!==null&&this.context.currentTime>=entry.firstAudibleAt?entry.tag:undefined;
        this.reportPlayback(audibleEnded);
      };
      source.start(start);
      this.observeAudioChunk(entry);
      this.options.onQueue?.(Math.max(0, end - now) * 1000); this.ensureTimer();
      this.reportPlayback();
    } catch { this.issue('老师音频格式异常，已停止播放，请重新连接。', 'invalid_audio'); }
  }
  private tick() {
    if (this.closed) return;
    this.observeAudioClock();
    if(this.audioWindow&&this.dependencies.now()-this.audioWindow.at>=AUDIO_DIAGNOSTIC_WINDOW_MS)this.flushAudioDiagnostics(false);
    this.reportAudiblePlayback();
    const now = this.context.currentTime;
    if (this.muted || this.context.state !== 'running' || now - this.lastCaptureAt > .25) this.options.onLevel('child', 0);
    let energy = 0, count = 0;
    for (const entry of this.playback.values()) {
      if (entry.end <= now) { this.playback.delete(entry.source); try { entry.source.disconnect(); } catch {} continue; }
      if (this.context.state !== 'running' || now < entry.start) continue;
      const first = Math.max(0, Math.floor((now - entry.start) * entry.rate));
      const last = Math.min(entry.samples.length, first + Math.round(entry.rate * .02));
      for (let i = first; i < last; i++) { energy += entry.samples[i] ** 2; count++; }
    }
    // The clock reaches a scheduled sample only when WebAudio is running. Network
    // arrival alone is never treated as the teacher having audibly begun speaking.
    this.options.onLevel('teacher', count ? Math.sqrt(energy / count) : 0);
    this.options.onQueue?.(Math.max(0, this.nextAt - now) * 1000);
    this.reportPlayback();
  }
  private captureMetrics(at:unknown,level:unknown):PcmCaptureMetrics|undefined{
    if(this.context.state!=='running'||typeof at!=='number'||!Number.isFinite(at)||typeof level!=='number'||!Number.isFinite(level)||level<0||level>1)return;
    const age=this.context.currentTime-(at+1/this.options.inputSampleRate);
    if(age<-.05||age>MAX_CAPTURE_BACKLOG_SECONDS)return;
    const atMs=this.dependencies.now()-Math.max(0,age)*1000;
    return Number.isFinite(atMs)?{atMs,frameMs:this.options.frameMs,level}:undefined;
  }
  private reportAudiblePlayback(){
    if(this.closed||!this.options.onAudiblePlayback)return;
    const audioNow=this.context.currentTime;
    for(const entry of this.playback.values()){
      const id=entry.latencyId,first=entry.firstAudibleAt;
      if(!id||first===null||this.heardMeasurements.has(id))continue;
      const nowMs=this.dependencies.now(),clockGapMs=Math.abs(nowMs-entry.receivedAtMs-(audioNow-entry.receivedAudioAt)*1000);
      if(this.context.state!=='running'||clockGapMs>50){this.heardMeasurements.add(id);while(this.heardMeasurements.size>128)this.heardMeasurements.delete(this.heardMeasurements.values().next().value!);entry.latencyId=undefined;try{this.options.onPlaybackUnavailable?.({measurementId:id,reason:'playback_clock'});}catch{/* Optional measurement cannot stop playback. */}continue;}
      if(audioNow<first)continue;
      const atMs=nowMs-(audioNow-first)*1000;
      if(!Number.isFinite(atMs)||atMs<entry.receivedAtMs){entry.latencyId=undefined;continue;}
      this.heardMeasurements.add(id);while(this.heardMeasurements.size>128)this.heardMeasurements.delete(this.heardMeasurements.values().next().value!);
      try{this.options.onAudiblePlayback({measurementId:id,atMs});}catch{/* Optional measurement cannot stop playback. */}
    }
  }
  private reportPlayback(audibleEnded?:string){
    if(this.options.onPlaybackMetrics){
      const now=this.context.currentTime,running=!this.closed&&this.context.state==='running';
      const grouped=new Map<string,{playing:boolean;end:number}>();
      for(const entry of this.playback.values())if(entry.tag&&entry.end>now){
        const current=grouped.get(entry.tag)??{playing:false,end:now};
        current.playing ||= running&&entry.firstAudibleAt!==null&&entry.firstAudibleAt<=now;current.end=Math.max(current.end,entry.end);grouped.set(entry.tag,current);
      }
      for(const tag of new Set([...this.metricTags,...grouped.keys(),...(audibleEnded?[audibleEnded]:[])])){
        const value=grouped.get(tag);
        this.options.onPlaybackMetrics({tag,running,playing:value?.playing??false,...(running&&audibleEnded===tag?{audibleEnded:true as const}:{}),pending:!!value,queueMs:Math.round(Math.max(0,(value?.end??now)-now)*1000)});
      }
      this.metricTags=new Set(grouped.keys());
    }
    this.options.onPlaybackState?.({running:!this.closed&&this.context.state==='running',audiblePending:[...this.playback.values()].some(entry=>entry.audible&&entry.end>this.context.currentTime)});
  }
  private observeAudioClock(){
    const window=this.audioWindow;if(!window)return;
    const now=this.dependencies.now();
    if(!Number.isFinite(now)||now<window.lastStateAt){this.audioWindow=null;this.audioContinuity=null;return;}
    if(!window.running)window.stats.suspendedMs=diagnosticNumber((window.stats.suspendedMs??0)+now-window.lastStateAt);
    const running=this.context.state==='running';
    if(running!==window.running)this.audioContinuity=null;
    window.lastStateAt=now;window.running=running;
    const queue=diagnosticNumber((this.nextAt-this.context.currentTime)*1000,12000);
    window.stats.minQueueMs=Math.min(window.stats.minQueueMs??queue,queue);window.stats.maxQueueMs=Math.max(window.stats.maxQueueMs??queue,queue);
  }
  private observeAudioChunk(entry:Playback){
    if(!this.options.onAudioDiagnostics)return;
    this.observeAudioClock();
    const now=entry.receivedAtMs;if(!Number.isFinite(now))return;
    if(this.audioWindow&&now-this.audioWindow.at>=AUDIO_DIAGNOSTIC_WINDOW_MS)this.flushAudioDiagnostics(false);
    const running=this.context.state==='running',queue=diagnosticNumber((entry.end-entry.receivedAudioAt)*1000,12000);
    this.audioWindow??={at:now,lastStateAt:now,running,stats:{boundary:'browser',windowMs:0,chunkCount:0,audioMs:0,audibleChunkCount:0,maxArrivalGapMs:0,playbackGapCount:0,playbackGapMs:0,maxPlaybackGapMs:0,minQueueMs:queue,maxQueueMs:queue,suspendedMs:0}};
    const stats=this.audioWindow.stats,previous=this.audioContinuity;
    stats.chunkCount=diagnosticNumber(stats.chunkCount+1,12000);stats.audioMs=diagnosticNumber(stats.audioMs+entry.samples.length/entry.rate*1000,120000);if(entry.audible)stats.audibleChunkCount=diagnosticNumber(stats.audibleChunkCount+1,stats.chunkCount);
    if(running&&previous&&previous.tag===entry.tag&&now>=previous.at){
      stats.maxArrivalGapMs=Math.max(stats.maxArrivalGapMs,diagnosticNumber(now-previous.at));
      // A later chunk proves a scheduling gap; an idle natural ending alone does not.
      const gap=diagnosticNumber((entry.start-previous.end)*1000);
      if(gap>1){stats.playbackGapCount=diagnosticNumber((stats.playbackGapCount??0)+1,12000);stats.playbackGapMs=diagnosticNumber((stats.playbackGapMs??0)+gap);stats.maxPlaybackGapMs=Math.max(stats.maxPlaybackGapMs??0,gap);}
    }
    stats.minQueueMs=Math.min(stats.minQueueMs??queue,queue);stats.maxQueueMs=Math.max(stats.maxQueueMs??queue,queue);
    this.audioContinuity=running?{at:now,end:entry.end,tag:entry.tag}:null;
  }
  /** Diagnostic boundaries do not clear or otherwise change the audio queue. */
  flushAudioDiagnostics(reset=true):void{
    this.observeAudioClock();const window=this.audioWindow;this.audioWindow=null;
    if(reset)this.audioContinuity=null;
    if(!window||!window.stats.chunkCount)return;
    window.stats.windowMs=diagnosticNumber(this.dependencies.now()-window.at);
    try{this.options.onAudioDiagnostics?.(window.stats);}catch{/* Optional diagnostics must not interrupt sound. */}
  }
  cancelPlayback(): void {
    this.flushAudioDiagnostics();
    for (const { source } of this.playback.values()) { source.onended = null; try { source.stop(); } catch {} try { source.disconnect(); } catch {} }
    this.playback.clear();this.heardMeasurements.clear(); this.nextAt = this.context.currentTime;
    this.options.onLevel('teacher', 0); this.options.onQueue?.(0);
    this.reportPlayback();
  }
  mute(value: boolean): void {
    if (this.closed) return;
    this.muted = value; this.captureEpoch++;
    this.capture?.port.postMessage({ type: 'mute', muted: value, epoch: this.captureEpoch });
    this.lastCaptureAt = -Infinity; this.options.onLevel('child', 0);
  }
  async resume(): Promise<void> {
    if (this.closed) return;
    try { await this.context.resume(); } catch { this.issue('浏览器暂停了语音播放，请重新连接后允许播放声音。', 'audio_playback_failed'); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.captureEpoch++;this.context.onstatechange=null;
    if (this.timer !== null) this.dependencies.clear(this.timer); this.timer = null;
    this.cancelPlayback();
    if (this.capture) {
      this.capture.onprocessorerror = null; this.capture.port.onmessage = null;
      try { this.capture.port.postMessage({ type: 'stop' }); this.capture.port.close(); } catch {}
      try { this.capture.disconnect(); } catch {} this.capture = null;
    }
    try { this.input?.disconnect(); } catch {} this.input = null;
    try { this.sink?.disconnect(); } catch {} this.sink = null;
    this.options.onLevel('child', 0);
    // The transport owns and stops stream.getTracks(); closing this graph never
    // claims ownership of a caller's MediaStream or its shared microphone tracks.
    void this.context.close().catch(() => {});
  }
}
