import type {ClassroomBoardInput} from './classroom-board';
import type { ClassroomSnapshot } from './classroom-contract';
import {ClassroomConnectionSamples,CLASSROOM_CONNECTION_INTERVAL_MS,CLASSROOM_CONNECTION_TIMEOUT_MS,isClassroomConnectionQuality,type ClassroomConnectionUpdate} from './classroom-connection';
import { PcmVoiceAudio, type PcmVoiceAudioOptions,type PcmPlaybackState,type PcmPlaybackMetrics } from './voice-audio';
import { classroomVoiceFailure, type ClassroomVoiceErrorCode, type ClassroomVoiceFailure } from './classroom-voice-errors';
import {ClassroomCameraFrames,CLASSROOM_CAMERA_FRAME_BASE64,type ClassroomCameraFrameOwner} from './classroom-camera-frames';
import {CLASSROOM_VISION_MAX_BASE64,type ClassroomVisionState} from './classroom-vision';
import {ClassroomChalkClientChannel} from './classroom-chalk-channel';
import type {ClassroomChalkWriting} from './domain/classroom-chalk';
import {captureClassroomToolState} from './classroom-tool-state';
import {ClassroomLatencyClient} from './classroom-latency-client';
import {captureClassroomPoint,type ClassroomPointInput} from './classroom-point';
import {CLASSROOM_POINT_REASONS,type ClassroomPointReason} from './classroom-point-diagnostics';
import {reportClassroomPointObservation,flushClassroomPointObservations,type ClassroomPointObservation} from './classroom-point-diagnostics-client';
import {audioContinuityReportSchema,type AudioContinuityStats} from './classroom-audio-diagnostics';

export type ClassroomAnnotationInput={contextKey:string;action:'draw'|'undo';strokeCount:number;pointCount:number};

const RECOVERY_NOTICE='语音连接正在恢复，请稍等片刻，再继续说话。';

type VoiceState = 'connecting' | 'connected' | 'closed' | 'error';
type AudioOwner = Pick<PcmVoiceAudio, 'startCapture' | 'playChunk' | 'cancelPlayback' | 'mute' | 'resume' | 'close'> & Partial<Pick<PcmVoiceAudio,'flushAudioDiagnostics'>>;
export type ClassroomVoiceClientOptions = {
  classroomId: string; provider: 'qwen' | 'openai' | 'grok';
  onState(state: VoiceState): void;
  onSnapshot(snapshot: ClassroomSnapshot): void;
  onLevel(role: 'child' | 'teacher', level: number): void;
  onError(message: string): void;
  onFailure?(failure: ClassroomVoiceFailure): void;
  onPlaybackQueue?(milliseconds: number): void;
  onVisionState?(state:ClassroomVisionState):void;
  onConnectionQuality?(update:ClassroomConnectionUpdate):void;
  onChalk?(writing:ClassroomChalkWriting|null):void;
};
export type ClassroomVoiceClientDependencies = {
  media(): Promise<MediaStream>;
  socket(url: string): WebSocket;
  origin(): string;
  audio(options: PcmVoiceAudioOptions): AudioOwner;
  startupMs: number; closeMs: number;
  frames?():ClassroomCameraFrameOwner;
  now?():number;
  chalkNow?():number;
  pointDiagnostics?(event:ClassroomPointObservation):void;
};

/** One explicitly started microphone and server-owned connection. No stored audio or credentials. */
export class ClassroomVoiceClient {
  private readonly dependencies: ClassroomVoiceClientDependencies;
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private audio: AudioOwner | null = null;
  private stopped = false;
  private started = false;
  private ready = false;
  private recoveryChecking=false;
  private lastClientError='';
  private muted = false;
  private startup: ReturnType<typeof setTimeout> | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((reason: Error) => void) | null = null;
  private closeResolve: (() => void) | null = null;
  private closing: Promise<void> | null = null;
  private connectionSamples=new ClassroomConnectionSamples();
  private connectionTimer:ReturnType<typeof setInterval>|null=null;
  private connectionTimeout:ReturnType<typeof setTimeout>|null=null;
  private connectionPending:{nonce:string;sentAt:number}|null=null;
  private connectionSequence=0;
  private boardGeneration=0;
  private boardSequence=0;
  private boardContext='';
  private boardLastSent=-Infinity;
  private visionGeneration=0;
  private visionActive=false;
  private visionSequence=0;
  private frames:ClassroomCameraFrameOwner|null=null;
  private visionStartup:ReturnType<typeof setTimeout>|null=null;
  private diagnosticSpan:string|null=null;
  private audioDiagnosticContext:string|null=null;
  private audioDiagnosticSequence=0;
  private diagnosticResponses=new Map<string,{turnId:string;at:number;started:boolean;completed:boolean;lastSample:number;metrics:PcmPlaybackMetrics|null}>();
  private playbackProbe:string|null=null;
  private playbackId=0;
  private playbackKnown=true;
  private playbackState:PcmPlaybackState|null=null;
  private chalkSnapshot:ClassroomSnapshot|null=null;
  private pointPending:{eventId:string;scope:string;timer:ReturnType<typeof setTimeout>;observation:Pick<ClassroomPointObservation,'pointId'|'context'|'objectId'>}|null=null;
  private readonly chalk:ClassroomChalkClientChannel;
  private readonly latency:ClassroomLatencyClient;
  private latencyScope:{session:string;course:string;epoch:number;task:string;status:string}|null=null;
  constructor(private readonly options: ClassroomVoiceClientOptions, dependencies: Partial<ClassroomVoiceClientDependencies> = {}) {
    this.dependencies = {
      media: () => {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器无法使用麦克风，请使用 HTTPS 或本机页面。');
        return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      },
      socket: url => new WebSocket(url), origin: () => location.origin,
      audio: audioOptions => new PcmVoiceAudio(audioOptions), startupMs: 25000, closeMs: 3500,
      ...dependencies,
    };
    this.latency=new ClassroomLatencyClient({now:()=>this.connectionNow(),id:()=>globalThis.crypto.randomUUID(),send:message=>this.ready&&!this.stopped&&this.send(message)});
    this.chalk=new ClassroomChalkClientChannel({now:this.dependencies.chalkNow,current:()=>{
      try{const captured=this.chalkSnapshot&&captureClassroomToolState(this.chalkSnapshot);return captured&&captured.ok?captured.snapshot:null;}catch{return null;}
    },send:message=>this.send(message),onWriting:writing=>this.options.onChalk?.(writing)});
  }
  async start(): Promise<void> {
    if (this.started || this.stopped) throw new Error('本次语音连接已经使用，请重新连接。');
    this.started = true; this.options.onState('connecting');
    try {
      // Build WebAudio before awaiting microphone permission, while the click still authorizes playback.
      this.audio = this.dependencies.audio({ inputSampleRate: this.options.provider === 'qwen' ? 16000 : 24000, frameMs: 100,
        onFrame: (audio,metrics) => {
          if(!this.ready||this.stopped||this.muted)return;
          const metadata=this.recoveryChecking?undefined:this.latency.capture(metrics);
          if(!this.send({type:'audio',audio,...metadata}))this.fail('声音发送积压，连接已停止，请重新连接。','input_rate_limited');
        },
        onAudiblePlayback:event=>{if(this.ready&&!this.stopped&&!this.muted)this.latency.audible(event);},
        onPlaybackUnavailable:event=>{if(this.ready&&!this.stopped)this.latency.unavailable(event);},
        onLevel: (role, level) => { if (!this.stopped) this.options.onLevel(role, level); },
        onQueue: milliseconds => { if (!this.stopped) this.options.onPlaybackQueue?.(milliseconds); },
        onPlaybackState:state=>{this.playbackState=state;this.reportPlayback();},
        onPlaybackMetrics:state=>this.reportDiagnosticPlayback(state),
        onAudioDiagnostics:stats=>this.reportAudioDiagnostics(stats),
        onIssue: (message, code) => this.fail(message, code ?? 'audio_capture_failed'),
      });
      const stream = await this.dependencies.media();
      if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const url = new URL(`/ws/classrooms/${encodeURIComponent(this.options.classroomId)}`, this.dependencies.origin());
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      this.socket = this.dependencies.socket(url.href);
      const completion = new Promise<void>((resolve, reject) => { this.startResolve = resolve; this.startReject = reject; });
      this.startup = setTimeout(() => this.fail('语音连接超时，请重试。', 'startup_timeout'), this.dependencies.startupMs);
      this.socket.onmessage = event => { void this.receive(event.data); };
      this.socket.onerror = () => this.fail('语音连接未成功，请检查网络后重试。');
      this.socket.onclose = () => {
        this.closeResolve?.();
        if (!this.stopped) this.fail('语音连接已断开，请重新连接。');
      };
      await completion;
    } catch (error) {
      if (!this.stopped) this.fail(error instanceof Error && error.message.includes('当前浏览器') ? error.message : '无法打开麦克风或连接语音服务，请检查权限后重试。', 'microphone_denied');
      throw error;
    }
  }
  private send(event: unknown) {
    if (!this.socket || this.socket.readyState !== 1 || this.socket.bufferedAmount > 64_000) return false;
    try { this.socket.send(JSON.stringify(event)); return true; } catch { return false; }
  }
  private async receive(raw: unknown) {
    if (this.stopped || typeof raw !== 'string' || raw.length > 512_000) return;
    let event: Record<string, unknown>;
    try { event = JSON.parse(raw) as Record<string, unknown>; if (!event || typeof event !== 'object') return; } catch { this.fail('语音服务响应异常，请重新连接。'); return; }
    if (event.type === 'ready') {
      if (this.ready) return;
      if (event.inputSampleRate !== (this.options.provider === 'qwen' ? 16000 : 24000) || event.outputSampleRate !== 24000) { this.fail('语音采样配置不一致，请重新连接。', 'invalid_audio'); return; }
      this.ready = true;
      try {
        await this.audio?.startCapture(this.stream!);
        if (this.stopped) return;
        this.audio?.mute(this.muted);
        if (this.startup) clearTimeout(this.startup); this.startup = null;
        this.send({type:'client.capabilities',diagnosticsVersion:1,pointVersion:1});this.options.onState('connected'); this.startConnectionChecks(); this.startResolve?.(); this.startResolve = null; this.startReject = null;
      } catch { if (!this.stopped) this.fail('无法启动麦克风采集，请重新连接。', 'audio_capture_failed'); }
    } else if(event.type==='pong'){
      const pending=this.connectionPending;
      if(!this.ready||!pending||event.nonce!==pending.nonce)return;
      this.connectionPending=null;if(this.connectionTimeout)clearTimeout(this.connectionTimeout);this.connectionTimeout=null;
      const quality=this.connectionSamples.record(this.connectionNow()-pending.sentAt);
      this.options.onConnectionQuality?.({link:'device',quality});
    } else if(event.type==='connection.quality'){
      if(this.ready&&event.link==='teacher'&&isClassroomConnectionQuality(event.quality))this.options.onConnectionQuality?.({link:'teacher',quality:event.quality});
    } else if(event.type==='board.state'){
      if(this.boardContext&&event.generation===this.boardGeneration&&(event.status==='error'||event.status==='unavailable'))this.reportError('教材笔迹暂时无法传给老师；语音仍可继续，请重新连接后再试。');
    } else if(event.type==='voice.recovery'){
      if(!this.ready||Object.keys(event).length!==2||(event.state!=='checking'&&event.state!=='recovered'))return;
      if(event.state==='checking'){
        if(this.recoveryChecking)return;
        this.audio?.flushAudioDiagnostics?.();this.recoveryChecking=true;this.latency.reset();this.clearDiagnosticPlayback();this.reportError(RECOVERY_NOTICE);
      }else if(this.recoveryChecking){
        this.audio?.flushAudioDiagnostics?.();this.recoveryChecking=false;this.latency.reset();this.clearDiagnosticPlayback();if(this.lastClientError===RECOVERY_NOTICE)this.reportError('');
      }
    } else if(event.type==='point.result'){
      this.receivePointResult(event);
    } else if(event.type==='vision.state'){
      if(!this.visionActive||event.generation!==this.visionGeneration||!['off','starting','sharing','error','unavailable'].includes(String(event.status)))return;
      const status=event.status as ClassroomVisionState['status'];
      if(status!=='starting'&&this.visionStartup){clearTimeout(this.visionStartup);this.visionStartup=null;}
      if(status==='off'||status==='error'||status==='unavailable'){this.frames?.stop();this.frames=null;this.visionActive=false;}
      this.publishVision(status);
    } else if(event.type==='diagnostic.latency'){
      if(this.ready&&!this.recoveryChecking)this.latency.receive(event);
    } else if(event.type==='diagnostic.response'){
      if(!this.recoveryChecking)this.receiveDiagnosticResponse(event);
    } else if(event.type==='playback.probe'){
      if(this.ready&&Object.keys(event).length===2&&typeof event.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(event.id)){this.playbackProbe=event.id;this.reportPlayback();}
    } else if(typeof event.type==='string'&&event.type.startsWith('chalk.')){
      if(this.ready&&!this.startResolve&&this.options.onChalk)this.chalk.receive(event);
    } else if (event.type === 'audio' && this.ready && typeof event.audio === 'string' && event.sampleRate === 24000){
      const tag=event.diagnosticSpanId===undefined?this.diagnosticSpan:typeof event.diagnosticSpanId==='string'&&this.diagnosticResponses.has(event.diagnosticSpanId)?event.diagnosticSpanId:null;
      // Unknown mixed tails may still contain an earlier span. Its completion is no longer measurable.
      if(event.diagnosticSpanId!==undefined&&tag===null)this.clearDiagnosticPlayback();
      this.observePlaybackId(event.playbackId);this.playbackState=null;this.audio?.playChunk(event.audio, 24000,tag??undefined,this.latency.audio(event.latencyMeasurementId));
    } else if (event.type === 'interrupt') {this.audio?.flushAudioDiagnostics?.();this.latency.interrupt();this.clearDiagnosticPlayback();this.observePlaybackId(event.playbackId);this.playbackState=null;this.audio?.cancelPlayback();}
    else if (event.type === 'snapshot') {
      const value = event.classroom;
      if (value && typeof value === 'object' && 'id' in value && value.id === this.options.classroomId && 'revision' in value && Number.isInteger(value.revision)) {
        if(!this.chalkSnapshot||(value.revision as number)>=this.chalkSnapshot.revision){this.audioDiagnosticContextChanged(value as ClassroomSnapshot);this.chalkSnapshot=value as ClassroomSnapshot;this.latencyContextChanged(this.chalkSnapshot);this.chalk.contextChanged();if(this.pointPending&&this.pointPending.scope!==this.pointScope())this.clearPoint('superseded');}
        this.options.onSnapshot(value as ClassroomSnapshot);
      }
    } else if (event.type === 'error') { const failure = classroomVoiceFailure(event.code); this.fail(failure.message, failure.code); }
    else if (event.type === 'closed') {
      this.audio?.flushAudioDiagnostics?.();
      this.stopped = true; this.releaseLocal(); this.startResolve?.(); this.startResolve = null; this.startReject = null; this.closeResolve?.();
      this.socket?.close(); this.options.onState('closed');
    }
  }
  private pointScope(){
    try{
      const captured=this.chalkSnapshot&&captureClassroomToolState(this.chalkSnapshot);
      if(!captured||!captured.ok||captured.snapshot.status!=='active')return null;
      const context=captured.snapshot.context;
      // The accepted point may publish a newer revision before its receipt.
      return JSON.stringify([context.logicalSessionId,context.courseVersion,context.connectionEpoch,context.pageId,context.activityId]);
    }catch{return null;}
  }
  private reportError(message:string){this.lastClientError=message;this.options.onError(message);}
  private observePoint(event:ClassroomPointObservation){
    try{if(this.dependencies.pointDiagnostics)this.dependencies.pointDiagnostics(event);else reportClassroomPointObservation(this.options.classroomId,event);}catch{ /* Optional diagnostics never stop the media path. */ }
  }
  private clearPoint(reason?:ClassroomPointReason){
    const pending=this.pointPending;if(pending){clearTimeout(pending.timer);if(reason)this.observePoint({...pending.observation,stage:'unavailable',reason});}
    this.pointPending=null;
  }
  private receivePointResult(event:Record<string,unknown>){
    const pending=this.pointPending;
    const keys=Object.keys(event),reason=event.reason;
    if(!this.ready||this.stopped||!pending||keys.length<3||keys.length>4||keys.some(key=>!['type','eventId','status','reason'].includes(key))||event.eventId!==pending.eventId||(event.status!=='accepted'&&event.status!=='unavailable'))return;
    if(reason!==undefined&&(event.status!=='unavailable'||!CLASSROOM_POINT_REASONS.includes(reason as ClassroomPointReason)))return;
    const current=pending.scope===this.pointScope();
    this.observePoint({...pending.observation,stage:current?(event.status==='accepted'?'acknowledged':'unavailable'):'unavailable',...(current&&event.status==='accepted'?{}:{reason:current?(reason as ClassroomPointReason|undefined)??'server_rejected':'superseded'})});
    this.clearPoint();
    if(current&&event.status==='unavailable')this.reportError('刚才的点选没有送达，请再点一次。');
  }
  private latencyContextChanged(snapshot:ClassroomSnapshot){
    try{
      const captured=captureClassroomToolState(snapshot);
      if(!captured.ok){this.latency.reset();this.latencyScope=null;return;}
      const {context,status}=captured.snapshot,scope={session:context.logicalSessionId,course:context.courseVersion,epoch:context.connectionEpoch,task:JSON.stringify([context.pageId,context.activityId]),status};
      const previous=this.latencyScope;this.latencyScope=scope;
      if(status!=='active'||previous&&(previous.session!==scope.session||previous.course!==scope.course||previous.epoch!==scope.epoch||previous.status!==status))this.latency.reset();
      else if(previous&&previous.task!==scope.task)this.latency.scopeChanged();
    }catch{this.latency.reset();this.latencyScope=null;}
  }
  private clearDiagnosticPlayback(){this.diagnosticSpan=null;this.diagnosticResponses.clear();}
  private audioDiagnosticContextChanged(snapshot:ClassroomSnapshot){
    const next=snapshot.status==='active'&&Number.isSafeInteger(snapshot.connectionEpoch)&&snapshot.connectionEpoch>0&&Number.isSafeInteger(snapshot.stepIndex)&&snapshot.stepIndex>=0?`${snapshot.id}:${snapshot.connectionEpoch}:${snapshot.stepIndex}`:null;
    if(next===this.audioDiagnosticContext)return;
    // Flush while the old context is still bound; telemetry must not relabel old audio.
    this.audio?.flushAudioDiagnostics?.();this.audioDiagnosticContext=next;
  }
  private reportAudioDiagnostics(audioStats:AudioContinuityStats){
    if(!this.ready||this.stopped||this.recoveryChecking||!this.audioDiagnosticContext||!this.playbackKnown)return;
    const report=audioContinuityReportSchema.safeParse({type:'diagnostic.audio',contextKey:this.audioDiagnosticContext,playbackId:this.playbackId,sequence:this.audioDiagnosticSequence+1,audioStats});
    if(report.success&&this.send(report.data))this.audioDiagnosticSequence=report.data.sequence;
  }
  private receiveDiagnosticResponse(event:Record<string,unknown>){
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if(!this.ready||Object.keys(event).length!==4||typeof event.turnId!=='string'||!uuid.test(event.turnId)||typeof event.spanId!=='string'||!uuid.test(event.spanId))return;
    const spanId=event.spanId,existing=this.diagnosticResponses.get(spanId);
    if(event.state==='started'){
      if(existing)return;
      if(this.diagnosticResponses.size>=8)this.diagnosticResponses.delete(this.diagnosticResponses.keys().next().value!);
      this.diagnosticResponses.set(spanId,{turnId:event.turnId,at:this.connectionNow(),started:false,completed:false,lastSample:-Infinity,metrics:null});this.diagnosticSpan=spanId;
    }else if(existing&&existing.turnId===event.turnId){
      if(event.state==='cancelled'){this.diagnosticResponses.delete(spanId);if(this.diagnosticSpan===spanId)this.diagnosticSpan=null;}
      else if(event.state==='completed'){existing.completed=true;if(existing.metrics)this.reportDiagnosticPlayback(existing.metrics);}
    }
  }
  private reportDiagnosticPlayback(metrics:PcmPlaybackMetrics){
    const response=this.diagnosticResponses.get(metrics.tag);
    if(!this.ready||this.stopped||!response||!Number.isFinite(metrics.queueMs)||metrics.queueMs<0||metrics.queueMs>12000)return;
    response.metrics=metrics;
    const now=this.connectionNow(),elapsedMs=Math.round(now-response.at);
    if(!Number.isSafeInteger(elapsedMs)||elapsedMs<0||elapsedMs>86400000)return;
    const phase=!response.started&&metrics.running&&(metrics.playing||metrics.audibleEnded)?'playback_started':response.started&&response.completed&&!metrics.pending?'playback_finished':response.started&&metrics.pending&&now-response.lastSample>=1000?'playback_sample':null;
    if(!phase)return;
    if(this.send({type:'diagnostic.playback',turnId:response.turnId,spanId:metrics.tag,phase,elapsedMs,queueMs:Math.round(metrics.queueMs)})){
      response.lastSample=now;
      if(phase==='playback_started'){
        response.started=true;
        if(response.completed&&!metrics.pending)this.reportDiagnosticPlayback(metrics);
      }
      if(phase==='playback_finished'){this.diagnosticResponses.delete(metrics.tag);if(this.diagnosticSpan===metrics.tag)this.diagnosticSpan=null;}
    }
  }
  private observePlaybackId(value:unknown){
    this.playbackKnown=typeof value==='number'&&Number.isSafeInteger(value)&&value>=this.playbackId;
    if(this.playbackKnown)this.playbackId=value as number;
  }
  private reportPlayback(){
    if(!this.ready||this.stopped||!this.playbackProbe||!this.playbackKnown||!this.playbackState?.running||this.playbackState.audiblePending)return;
    if(this.send({type:'playback.state',probeId:this.playbackProbe,playbackId:this.playbackId,running:true,audiblePending:false}))this.playbackProbe=null;
  }
  private releaseLocal() {
    this.audioDiagnosticContext=null;
    this.recoveryChecking=false;if(this.lastClientError===RECOVERY_NOTICE)this.reportError('');
    this.clearPoint('not_ready');flushClassroomPointObservations(this.options.classroomId);this.latency.reset();this.latencyScope=null;this.clearDiagnosticPlayback();this.chalk.close();this.chalkSnapshot=null;
    this.playbackProbe=null;this.playbackState=null;this.playbackKnown=false;
    this.stopConnectionChecks();
    this.stopVision();
    if (this.startup) clearTimeout(this.startup); this.startup = null;
    this.stopBoard();this.ready = false;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.audio?.close(); this.audio = null;
    this.options.onLevel('child', 0); this.options.onLevel('teacher', 0);
    this.options.onPlaybackQueue?.(0);
  }
  private fail(message: string, code: ClassroomVoiceErrorCode = 'transport_error') {
    if (this.stopped) return;
    this.audio?.flushAudioDiagnostics?.();
    this.stopped = true; this.releaseLocal();
    this.startReject?.(new Error(message)); this.startReject = null; this.startResolve = null;
    this.options.onFailure?.({ code, message });
    this.send({ type: 'close' }); this.socket?.close(); this.reportError(message); this.options.onState('error');
  }
  chalkDisplayed(id:string){return this.ready&&!this.stopped&&this.chalk.displayed(id);}
  chalkExpired(id:string){this.chalk.expired(id);}
  sendText(text: string): boolean {
    if(!this.ready||this.stopped||!text.trim()||text.length>1000)return false;
    this.latency.reset();return this.send({type:'text',text:text.trim()});
  }
  sendInteraction(input:ClassroomAnnotationInput):boolean{
    if(!this.ready||this.stopped||!input.contextKey||input.contextKey.length>200||!['draw','undo'].includes(input.action)||!Number.isSafeInteger(input.strokeCount)||input.strokeCount<0||input.strokeCount>1000||!Number.isSafeInteger(input.pointCount)||input.pointCount<0||input.pointCount>600)return false;
    return this.send({type:'interaction',eventId:crypto.randomUUID(),contextKey:input.contextKey,action:input.action,strokeCount:input.strokeCount,pointCount:input.pointCount});
  }
  sendPoint(input:ClassroomPointInput,eventId?:string):boolean{
    const pointId=eventId??globalThis.crypto.randomUUID(),snapshot=this.chalkSnapshot;
    let context:ClassroomPointObservation['context'];try{const captured=snapshot&&captureClassroomToolState(snapshot);if(captured?.ok)context=captured.snapshot.context;}catch{}
    const observation={pointId,context,objectId:input?.objectId};
    const refused=(reason:ClassroomPointReason)=>{this.observePoint({...observation,stage:'send_failed',reason});return false;};
    if(!this.ready||this.stopped||this.startResolve)return refused('not_ready');
    if(this.recoveryChecking){this.reportError(RECOVERY_NOTICE);return refused('busy');}
    if(this.pointPending)return refused('busy');
    if(!snapshot||!context||!input||input.contextKey!==[snapshot.id,snapshot.connectionEpoch,snapshot.stepIndex].join(':'))return refused('invalid_context');
    const step=snapshot.course.steps[snapshot.stepIndex],object=snapshot.course.pages.find(page=>page.id===step?.pageId)?.objects.find(object=>object.id===input.objectId);
    if(!object)return refused('unknown_object');
    try{
      const scope=this.pointScope();if(!scope)return refused('invalid_context');
      const point=captureClassroomPoint(snapshot,{type:'interaction.point',eventId:pointId,context,objectId:input.objectId});
      if(!point.accepted)return refused('invalid_context');
      if(!this.socket||this.socket.readyState!==1)return refused('not_ready');
      if(this.socket.bufferedAmount>64000)return refused('send_backpressure');
      const timer=setTimeout(()=>{
        const pending=this.pointPending;if(pending?.eventId!==pointId)return;
        const current=this.ready&&!this.stopped&&pending.scope===this.pointScope();
        this.observePoint({...pending.observation,stage:current?'timeout':'unavailable',reason:current?'ack_timeout':'superseded'});this.clearPoint();
        if(current)this.reportError('刚才的点选没有送达，请再点一次。');
      },10000);
      this.pointPending={eventId:pointId,scope,timer,observation};this.latency.reset();
      if(this.send(point.request)){this.observePoint({...observation,stage:'sent'});return true;}
      this.clearPoint();return refused('send_failed');
    }catch{return refused('send_failed');}
  }
  stopBoard():void{
    if(this.boardContext)this.send({type:'board.stop',generation:this.boardGeneration,contextKey:this.boardContext});
    this.boardContext='';this.boardLastSent=-Infinity;
  }
  sendBoard(input:ClassroomBoardInput):boolean{
    if(this.options.provider==='grok')return false;
    if(!this.ready||this.stopped||!input.contextKey||input.contextKey.length>1000||!input.image||input.image.length>CLASSROOM_CAMERA_FRAME_BASE64||!this.socket||this.socket.readyState!==1||this.socket.bufferedAmount>8192)return false;
    if(this.boardContext!==input.contextKey){
      if(this.boardContext)this.send({type:'board.stop',generation:this.boardGeneration,contextKey:this.boardContext});
      this.boardContext=input.contextKey;this.boardGeneration++;this.boardSequence=0;this.boardLastSent=-Infinity;
      if(!this.send({type:'board.start',generation:this.boardGeneration,contextKey:input.contextKey})){this.boardContext='';return false;}
    }
    const now=this.connectionNow();if(now-this.boardLastSent<3000)return false;
    const sent=this.send({type:'board.frame',generation:this.boardGeneration,sequence:++this.boardSequence,contextKey:input.contextKey,image:input.image});
    if(sent)this.boardLastSent=now;return sent;
  }
  private connectionNow(){return this.dependencies.now?.()??performance.now();}
  private startConnectionChecks(){
    this.options.onConnectionQuality?.({link:'device',quality:{status:'checking',rttMs:null}});
    const probe=()=>{
      if(this.stopped||!this.ready||this.connectionPending)return;
      const nonce=`cq_${++this.connectionSequence}`,sentAt=this.connectionNow();
      this.connectionPending={nonce,sentAt};
      if(!this.send({type:'ping',nonce})){this.connectionPending=null;this.options.onConnectionQuality?.({link:'device',quality:this.connectionSamples.missed()});return;}
      this.connectionTimeout=setTimeout(()=>{
        this.connectionTimeout=null;if(this.stopped||this.connectionPending?.nonce!==nonce)return;
        this.connectionPending=null;this.options.onConnectionQuality?.({link:'device',quality:this.connectionSamples.missed()});
      },CLASSROOM_CONNECTION_TIMEOUT_MS);
    };
    probe();this.connectionTimer=setInterval(probe,CLASSROOM_CONNECTION_INTERVAL_MS);
  }
  private stopConnectionChecks(){
    if(this.connectionTimer)clearInterval(this.connectionTimer);this.connectionTimer=null;
    if(this.connectionTimeout)clearTimeout(this.connectionTimeout);this.connectionTimeout=null;this.connectionPending=null;
    const quality=this.connectionSamples.reset();
    this.options.onConnectionQuality?.({link:'device',quality});this.options.onConnectionQuality?.({link:'teacher',quality});
  }
  private publishVision(status:ClassroomVisionState['status']){
    const messages={off:'',starting:'正在开启画面分享…',sharing:'画面分享中',error:'画面分享已停止，请重试；语音课堂可以继续。',unavailable:'当前课堂暂不支持画面分享，可以继续语音上课。'};
    this.options.onVisionState?.({status,generation:this.visionGeneration,message:messages[status]});
  }
  startVision(stream:MediaStream):boolean{
    if(this.options.provider==='grok'){this.visionGeneration++;this.publishVision('unavailable');return false;}
    if(!this.ready||this.stopped)return false;
    this.stopVision();this.visionGeneration++;this.visionSequence=0;this.visionActive=true;
    if(!this.send({type:'vision.start',generation:this.visionGeneration})){this.visionActive=false;this.publishVision('error');return false;}
    this.publishVision('starting');const generation=this.visionGeneration;
    const failed=()=>{if(!this.visionActive||generation!==this.visionGeneration)return;this.stopVision();this.publishVision('error');};
    this.visionStartup=setTimeout(failed,10000);
    try{
     const frames=this.dependencies.frames?.()??new ClassroomCameraFrames();this.frames=frames;
     frames.start(stream,image=>{
      if(!this.visionActive||this.stopped||generation!==this.visionGeneration)return;
      if(image.length>CLASSROOM_VISION_MAX_BASE64){failed();return;}
      // Never let images consume the audio/control queue's 64KB budget.
      if(!this.socket||this.socket.readyState!==1||this.socket.bufferedAmount>8192||image.length>CLASSROOM_CAMERA_FRAME_BASE64)return;
      try{this.socket.send(JSON.stringify({type:'vision.frame',generation,sequence:++this.visionSequence,image}));}catch{failed();}
     },failed);
    }catch{failed();return false;}
    return this.visionActive;
  }
  stopVision():void{
    if(this.visionStartup)clearTimeout(this.visionStartup);this.visionStartup=null;
    const active=this.visionActive;this.visionActive=false;this.frames?.stop();this.frames=null;
    if(active)this.send({type:'vision.stop',generation:this.visionGeneration});
    this.publishVision('off');
  }
  setMuted(muted: boolean) {
    if (this.stopped) return;
    this.latency.reset();this.muted = muted; this.audio?.mute(muted); this.stream?.getTracks().forEach(track => { track.enabled = !muted; });
    if (this.ready) this.send({ type: 'mute', muted });
  }
  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.audio?.flushAudioDiagnostics?.();
    this.stopped = true; this.releaseLocal(); this.startResolve?.(); this.startResolve = null; this.startReject = null;
    this.closing = (async () => {
      if (this.socket?.readyState === 1) {
        await new Promise<void>(resolve => {
          const timeout = setTimeout(resolve, this.dependencies.closeMs);
          this.closeResolve = () => { clearTimeout(timeout); resolve(); };
          if (!this.send({ type: 'close' })) this.closeResolve();
        });
      }
      this.socket?.close(); this.options.onState('closed');
    })();
    return this.closing;
  }
  dispose() {
    this.audio?.flushAudioDiagnostics?.();
    this.stopped = true; this.releaseLocal(); this.startResolve?.(); this.startResolve = null; this.startReject = null;
    this.send({ type: 'close' }); this.socket?.close(); this.closeResolve?.();
  }
}
