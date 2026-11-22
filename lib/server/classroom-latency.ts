import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ClassroomJournalEntry} from '../classroom-journal';
import type {DiagnosticSpan} from './classroom-diagnostic-trace';

type Basis='provider_turn'|'application_window';
type Stage='input_received'|'speech_stopped'|'input_final'|'application_started'|'response_requested'|'response_started'|'audio_first_received'|'audio_first_sent'|'playback_started'|'cancelled'|'unmeasured'|'wait_update';
export type LatencyBinding={type:'diagnostic.latency';measurementId:string;inputId:string;turnId:string;spanId:string;lastVoiceSequence:number;basis:Basis;state:'bound'|'cancelled'};
type Scope={key:string;contextKey:string;version?:number};
type NativeFrame={sampleCount:number;sampleRate:number};
type NativeRange={start:number;end:number;inputId?:string;sequence?:number;audible:boolean};
type Episode={id:string;measurementId:string;scope:Scope;at:number;first:number;last:number;voice:number;voiceAt:number;stopped:boolean;input?:DiagnosticSpan;reply?:DiagnosticSpan;basis?:Basis;announced:boolean;sent:boolean;ended:boolean;played:boolean;invalid:boolean;suspended?:{at:number;voice:number;target?:Scope;timer:ReturnType<typeof setTimeout>};seen:Set<Stage>};
const integer=z.number().int().nonnegative().safe();
const frameSchema=z.object({latencyInputId:z.string().uuid(),audioSequence:integer});
const stopSchema=z.object({type:z.literal('diagnostic.input'),inputId:z.string().uuid(),firstSequence:integer,lastVoiceSequence:integer,phase:z.literal('stopped'),silenceMs:integer.max(10000)}).strict();
const unmeasuredSchema=z.object({type:z.literal('diagnostic.input'),inputId:z.string().uuid(),phase:z.literal('unmeasured'),reason:z.enum(['capture_gap','playback_unbound','playback_clock']),captureGapMs:integer.max(10000).optional()}).strict().refine(value=>value.reason==='capture_gap'||value.captureGapMs===undefined);
const playbackSchema=z.object({type:z.literal('diagnostic.latency'),measurementId:z.string().uuid(),phase:z.literal('playback_started'),waitMs:integer.max(120000),captureGapMs:integer.max(10000).optional(),playbackMs:integer.max(120000).optional()}).strict();
const uuid=z.string().uuid();
const validRef=(ref:DiagnosticSpan|undefined):ref is DiagnosticSpan=>!!ref&&uuid.safeParse(ref.turnId).success&&uuid.safeParse(ref.spanId).success;

/** Optional measurement state. No diagnostics can authorize media, tools or learning evidence. */
export class ClassroomLatencyServer{
 private readonly episodes=new Map<string,Episode>();
 private readonly refs=new Map<string,Episode>();
 private currentEpisode:Episode|undefined;
 private lastSequence=-1;
 // Without a provider audio offset, an unacknowledged capture makes every
 // later unqualified VAD start ambiguous for this connection.
 private unresolvedCapture=false;
 private nativeRate:number|undefined;
 private nativeSamples=0;
 private nativeClockValid=true;
 private readonly nativeRanges:NativeRange[]=[];
 private closed=false;
 private count=0;
 private waitAt=-Infinity;
 private waitCount=0;
 private readonly now:()=>number;
 constructor(private readonly options:{native?:boolean;nativeTiming?:boolean;current:()=>Scope|null;emit:(entry:ClassroomJournalEntry)=>unknown;notify:(message:LatencyBinding)=>boolean;now?:()=>number}){this.now=options.now??(()=>performance.now());}
 private scope(){try{return this.options.current();}catch{return null;}}
 private valid(ep:Episode|undefined):ep is Episode{return !!ep&&!this.closed&&!ep.invalid&&!ep.suspended&&ep.scope.key===this.scope()?.key;}
 private byRef(ref:DiagnosticSpan|undefined){if(!validRef(ref))return;const ep=this.refs.get(ref.spanId);return this.valid(ep)&&ep.input?.turnId===ref.turnId?ep:undefined;}
 private emit(ep:Episode,stage:Stage,extra:Record<string,unknown>={}){
  if(this.closed||ep.seen.has(stage))return;ep.seen.add(stage);
  const ref=ep.reply??ep.input;
  try{this.options.emit({eventKey:`latency:${ep.measurementId}:${stage}${stage==='wait_update'?`:${++this.waitCount}`:''}`,kind:stage==='input_received'||stage==='speech_stopped'||stage==='input_final'?'interaction':'connection',actor:'application',status:stage==='response_requested'?'requested':'recorded',name:'latency_stage',details:{measurementId:ep.measurementId,latencyInputId:ep.id,latencyStage:stage,...(ep.basis?{latencyBasis:ep.basis}:{}),...(ref?ref:{}),contextKey:ep.scope.contextKey,clock:'server',elapsedMs:Math.max(0,Math.min(86400000,Math.round(this.now()-ep.at))),...extra}});}catch{/* Optional diagnostics must not affect the classroom. */}
 }
 private notify(ep:Episode,state:LatencyBinding['state']){if(!ep.reply||!ep.basis)return false;try{return this.options.notify({type:'diagnostic.latency',measurementId:ep.measurementId,inputId:ep.id,...ep.reply,lastVoiceSequence:ep.voice,basis:ep.basis,state});}catch{return false;}}
 private invalidate(ep:Episode,stage:'cancelled'|'unmeasured',state:string,extra:Record<string,unknown>={}){
  if(ep.invalid||ep.played)return;if(ep.suspended)clearTimeout(ep.suspended.timer);ep.suspended=undefined;this.emit(ep,stage,{state,...extra});if(ep.announced)this.notify(ep,'cancelled');ep.invalid=true;
 }
 private nativeFrame(frame:NativeFrame|undefined,audible:boolean){
  if(!this.options.native||!this.options.nativeTiming||!this.nativeClockValid)return;
  if(!frame||!Number.isSafeInteger(frame.sampleCount)||frame.sampleCount<=0||!Number.isSafeInteger(frame.sampleRate)||frame.sampleRate<=0||frame.sampleRate>192000||frame.sampleCount>frame.sampleRate||this.nativeRate!==undefined&&this.nativeRate!==frame.sampleRate){this.nativeClockValid=false;return;}
  this.nativeRate=frame.sampleRate;
  const range:NativeRange={start:this.nativeSamples,end:this.nativeSamples+frame.sampleCount,audible};
  if(!Number.isSafeInteger(range.end)){this.nativeClockValid=false;return;}
  this.nativeSamples=range.end;this.nativeRanges.push(range);
  while(this.nativeRanges.length>2048)this.nativeRanges.shift();
  return range;
 }
 audio(value:unknown,audible:boolean,nativeFrame?:NativeFrame){
  if(this.closed)return;const range=this.nativeFrame(nativeFrame,audible),parsed=frameSchema.safeParse(value);if(!parsed.success)return;
  const frame=parsed.data,scope=this.scope();if(!scope||frame.audioSequence<=this.lastSequence)return;
  if(range){range.inputId=frame.latencyInputId;range.sequence=frame.audioSequence;}
  const previous=this.lastSequence;this.lastSequence=frame.audioSequence;
  let ep=this.currentEpisode;
  if(!ep||ep.id!==frame.latencyInputId){
   // Exact native positions can prove a new input without relabelling delayed
   // VAD from the discarded candidate. The offset-less path stays conservative.
   const overlapping=!(this.options.native&&this.options.nativeTiming&&range)&&(this.unresolvedCapture||!!ep&&(!ep.invalid||!ep.input)&&!ep.ended&&!ep.played);
   if(ep&&!ep.input&&!ep.ended&&!ep.played)this.unresolvedCapture=true;
   if(ep&&!ep.played)this.invalidate(ep,'cancelled','new_input');
   const known=this.episodes.get(frame.latencyInputId);if(known||++this.count>256)return;
   ep={id:frame.latencyInputId,measurementId:randomUUID(),scope,at:this.now(),first:frame.audioSequence,last:frame.audioSequence,voice:audible?frame.audioSequence:-1,voiceAt:this.now(),stopped:false,announced:false,sent:false,ended:false,played:false,invalid:false,seen:new Set()};
   this.episodes.set(ep.id,ep);this.currentEpisode=ep;this.emit(ep,'input_received');
   if(overlapping)this.invalidate(ep,'unmeasured','overlapping_input');
   while(this.episodes.size>32){const first=this.episodes.keys().next().value!;this.episodes.delete(first);}
  }else{
   if(ep.suspended&&audible){this.invalidate(ep,'cancelled','new_voice');return;}
   if(!this.valid(ep))return;
   if(previous>=0&&frame.audioSequence!==previous+1){this.invalidate(ep,'unmeasured','capture_gap');return;}
   ep.last=frame.audioSequence;
   if(audible){
    if(this.options.native&&ep.stopped){this.unresolvedCapture=true;this.invalidate(ep,'unmeasured','ambiguous_input');return;}
    if(ep.reply||ep.seen.has('speech_stopped')){this.invalidate(ep,'cancelled','new_voice');return;}
    ep.voice=frame.audioSequence;ep.voiceAt=this.now();ep.stopped=false;
   }
  }
 }
 input(ref:DiagnosticSpan|undefined,unique=true,nativeStart?:{audioStartMs:unknown}){
  const ep=this.currentEpisode;if(!this.valid(ep)||!validRef(ref))return;
  if(this.options.native&&this.options.nativeTiming){
   const offset=nativeStart?.audioStartMs;
   if(!this.nativeClockValid||!this.nativeRate||typeof offset!=='number'||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(offset*this.nativeRate))return;
   // Qwen audio_start_ms is measured from the first buffer write, not from
   // receipt time. Never search the nearest input when it falls in silence,
   // omitted metadata, an old candidate or audio we have not forwarded yet.
   const position=offset*this.nativeRate;
   const range=this.nativeRanges.find(frame=>position>=frame.start*1000&&position<frame.end*1000);
   if(!range?.audible||range.inputId!==ep.id||range.sequence===undefined||range.sequence<ep.first||range.sequence>ep.last)return;
  }
  if(!unique||ep.input&&ep.input.spanId!==ref.spanId){this.invalidate(ep,'unmeasured','ambiguous_input');return;}
  ep.input=ref;this.refs.set(ref.spanId,ep);while(this.refs.size>128)this.refs.delete(this.refs.keys().next().value!);
 }
 inputStopped(value:unknown){
  const unmeasured=unmeasuredSchema.safeParse(value),candidate=this.currentEpisode;
  if(unmeasured.success){if(!candidate||candidate.invalid||candidate.played||candidate.id!==unmeasured.data.inputId||this.closed||candidate.scope.key!==this.scope()?.key)return false;this.invalidate(candidate,'unmeasured',unmeasured.data.reason,unmeasured.data.captureGapMs===undefined?{}:{captureGapMs:unmeasured.data.captureGapMs});return true;}
  const parsed=stopSchema.safeParse(value),ep=this.currentEpisode;if(!parsed.success||!this.valid(ep))return false;
  const report=parsed.data;if(report.inputId!==ep.id||report.firstSequence!==ep.first||report.lastVoiceSequence!==ep.voice||report.lastVoiceSequence>ep.last||ep.voice<0)return false;
  ep.stopped=true;return true;
 }
 associate(ref:DiagnosticSpan|undefined,parent:DiagnosticSpan|undefined){const ep=this.byRef(parent);if(!ep||!validRef(ref)||ref.turnId!==ep.input?.turnId)return;this.refs.set(ref.spanId,ep);while(this.refs.size>128)this.refs.delete(this.refs.keys().next().value!);}
 mark(ref:DiagnosticSpan|undefined,stage:Exclude<Stage,'playback_started'|'cancelled'|'unmeasured'>){const ep=this.byRef(ref);if(!ep)return;if(stage==='speech_stopped'&&!ep.stopped){this.invalidate(ep,'unmeasured','stop_unconfirmed');return;}this.emit(ep,stage);}
 bind(ref:DiagnosticSpan|undefined,parent:DiagnosticSpan|undefined,basis:Basis){
  const ep=this.byRef(parent);if(!ep||ep!==this.currentEpisode||!validRef(ref)||!ep.stopped||!ep.input||ref.turnId!==ep.input.turnId||ep.played)return false;
  if(ep.reply&&ep.reply.spanId!==ref.spanId&&(!ep.ended||ep.announced)){this.invalidate(ep,'unmeasured','ambiguous_response');return false;}
  ep.reply=ref;ep.basis=basis;ep.ended=false;this.refs.set(ref.spanId,ep);return true;
 }
 sent(ref:DiagnosticSpan|undefined,audible=true){const ep=this.byRef(ref);if(!ep||ep.reply?.spanId!==ref?.spanId||ep.played)return null;if(!ep.announced){if(!audible)return null;ep.announced=this.notify(ep,'bound');if(!ep.announced)return null;}ep.sent=true;this.emit(ep,'audio_first_sent');return ep.measurementId;}
 tag(ref:DiagnosticSpan|undefined){const ep=this.byRef(ref);return ep&&ep.reply?.spanId===ref?.spanId&&ep.announced&&!ep.played?ep.measurementId:null;}
 done(ref:DiagnosticSpan|undefined,cancelled=false){const ep=this.byRef(ref);if(!ep||ep.reply?.spanId!==ref?.spanId)return;if(cancelled)this.invalidate(ep,'cancelled','response_cancelled');else ep.ended=true;}
 details(ref:DiagnosticSpan|undefined){const ep=this.byRef(ref);return ep?{measurementId:ep.measurementId,latencyInputId:ep.id}:{};}
 playback(value:unknown){
  const parsed=playbackSchema.safeParse(value);if(!parsed.success||this.closed)return false;const report=parsed.data,ep=[...this.episodes.values()].find(ep=>ep.measurementId===report.measurementId);
  if(!this.valid(ep)||ep!==this.currentEpisode||!ep.announced||!ep.sent||ep.played)return false;
  ep.played=true;this.emit(ep,'playback_started',{clock:'client',elapsedMs:undefined,waitMs:report.waitMs,...(report.playbackMs===undefined?{}:{playbackMs:report.playbackMs}),...(report.captureGapMs===undefined?{}:{captureGapMs:report.captureGapMs})});return true;
 }
 unknownAudio(audible:boolean){if(!audible)return;const ep=this.currentEpisode;if(ep&&!ep.invalid&&!ep.played&&(ep.reply||ep.suspended||ep.stopped))this.invalidate(ep,'unmeasured','playback_unbound');}
 // Freeze the observed transition as well as its input; an intervening revision
 // cannot revive this measurement through a later receipt for the same activity.
 suspend(target?:Scope){const ep=this.currentEpisode;if(!this.valid(ep)||!ep.stopped||ep.announced||!ep.input){if(ep)this.invalidate(ep,'cancelled','context_changed');return false;}if(!ep.suspended){const timer=setTimeout(()=>this.invalidate(ep,'cancelled','advance_timeout'),10000);timer.unref();ep.suspended={at:this.now(),voice:ep.voice,target,timer};}return true;}
 migrate(ref:DiagnosticSpan|undefined){const ep=validRef(ref)?this.refs.get(ref.spanId):undefined,scope=this.scope();if(!ep||ep!==this.currentEpisode||ep.invalid||ep.played||!ep.suspended||this.now()-ep.suspended.at>10000||ep.suspended.voice!==ep.voice||!scope||ep.suspended.target&&(ep.suspended.target.key!==scope.key||ep.suspended.target.version!==scope.version)){if(ep)this.invalidate(ep,'cancelled','advance_unverified');return false;}clearTimeout(ep.suspended.timer);ep.suspended=undefined;ep.scope=scope;ep.reply=undefined;ep.basis=undefined;ep.ended=false;return true;}
 cancelSuspended(){for(const ep of this.episodes.values())if(ep.suspended)this.invalidate(ep,'cancelled','advance_unverified');}
 cancelReplies(){for(const ep of this.episodes.values())if(ep.reply&&!ep.suspended&&!(ep.ended&&!ep.announced))this.invalidate(ep,'cancelled','playback_interrupted');}
 cancelAll(state='input_invalidated'){if(this.currentEpisode&&!this.currentEpisode.input&&!this.currentEpisode.played)this.unresolvedCapture=true;for(const ep of this.episodes.values())this.invalidate(ep,'cancelled',state);this.currentEpisode=undefined;}
 contextChanged(){for(const ep of this.episodes.values())if(!ep.suspended&&ep.scope.key!==this.scope()?.key)this.invalidate(ep,'cancelled','context_changed');if(this.currentEpisode&&!this.currentEpisode.suspended&&this.currentEpisode.scope.key!==this.scope()?.key){if(!this.currentEpisode.input&&!this.currentEpisode.played)this.unresolvedCapture=true;this.currentEpisode=undefined;}}
 waiting(){const ep=this.currentEpisode;if(!this.valid(ep)||ep.played||this.now()-this.waitAt<1000)return;this.waitAt=this.now();ep.seen.delete('wait_update');this.emit(ep,'wait_update',{state:ep.sent?'waiting_playback':ep.reply?'waiting_audio':ep.stopped?'waiting_reply':'receiving_input'});}
 close(){this.cancelAll('closed');this.closed=true;this.episodes.clear();this.refs.clear();this.nativeRanges.length=0;}
}
