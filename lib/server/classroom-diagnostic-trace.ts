import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {CLASSROOM_DIAGNOSTIC_PHASES,type ClassroomJournalEntry} from '../classroom-journal';

export type DiagnosticSpan=Readonly<{turnId:string;spanId:string}>;
type Phase=typeof CLASSROOM_DIAGNOSTIC_PHASES[number];
type Source='speech'|'typed'|'application'|'provider';
type Metadata={type:'diagnostic.response';turnId:string;spanId:string;state:'started'|'completed'|'cancelled'};
type State={ref:DiagnosticSpan;scope:string;contextKey:string;source:Source;at:number;seen:Set<Phase>;announced:boolean;terminal?:'completed'|'cancelled';queuedAudio:number;providerDone:boolean;playbackStarted:boolean;playbackFinished:boolean;lastSample:number;clientElapsed:number};
const playbackSchema=z.object({type:z.literal('diagnostic.playback'),turnId:z.string().uuid(),spanId:z.string().uuid(),phase:z.enum(['playback_started','playback_finished','playback_sample']),elapsedMs:z.number().int().min(0).max(86400000),queueMs:z.number().int().min(0).max(12000)}).strict();
const bounded=(value:number,max:number)=>Math.min(max,Math.max(0,Math.round(Number.isFinite(value)?value:0)));

/** Metadata only. Caller observations supply association; no wall-clock proximity joins. */
export class ClassroomDiagnosticTrace{
 private readonly spans=new Map<string,State>();
 private readonly bindings=new Map<string,string>();
 private readonly associations=new Set<string>();
 private closed=false;
 private lastClientSample=-Infinity;
 private readonly now:()=>number;
 constructor(private readonly options:{current:()=>{scope:string;contextKey:string}|null;emit:(entry:ClassroomJournalEntry)=>unknown;notify:(message:Metadata)=>boolean;now?:()=>number}){this.now=options.now??(()=>performance.now());}
 private current(){try{return this.options.current();}catch{return null;}}
 private state(ref:DiagnosticSpan|undefined){const state=ref?this.spans.get(ref.spanId):undefined;return state&&state.ref.turnId===ref?.turnId?state:undefined;}
 create(source:Source,parent?:DiagnosticSpan,scope?:{scope:string;contextKey:string}):DiagnosticSpan{
  const ref={turnId:this.state(parent)?.ref.turnId??randomUUID(),spanId:randomUUID()},current=scope??this.current();
  if(!this.closed){
   this.spans.set(ref.spanId,{ref,scope:current?.scope??'',contextKey:current?.contextKey??'',source,at:this.now(),seen:new Set(),announced:false,queuedAudio:0,providerDone:false,playbackStarted:false,playbackFinished:false,lastSample:-Infinity,clientElapsed:0});
   while(this.spans.size>256){const discard=[...this.spans].find(([,state])=>!state.seen.has('session_started'))?.[0]??this.spans.keys().next().value!;this.spans.delete(discard);}
  }
  return ref;
 }
 bind(kind:'input'|'sequence'|'response'|'tool'|'configuration',key:string,ref:DiagnosticSpan){
  if(this.closed||!this.state(ref)||!key||key.length>300)return;
  this.bindings.set(`${kind}:${key}`,ref.spanId);while(this.bindings.size>512)this.bindings.delete(this.bindings.keys().next().value!);
 }
 lookup(kind:'input'|'sequence'|'response'|'tool'|'configuration',key:string){const id=this.bindings.get(`${kind}:${key}`);return !this.closed&&id?this.spans.get(id)?.ref:undefined;}
 associate(ref:DiagnosticSpan|undefined,itemId:string,role:'child'|'teacher',source:'speech'|'typed'){
  const state=this.state(ref),key=`${role}:${itemId}`;if(!state||this.closed||!itemId||itemId.length>200||this.associations.has(key))return;
  this.associations.add(key);while(this.associations.size>512)this.associations.delete(this.associations.values().next().value!);
  try{this.options.emit({eventKey:`diagnostic-association:${createHash('sha256').update(key).digest('hex')}`,kind:'interaction',actor:'application',status:'recorded',name:'diagnostic_association',correlationId:itemId,details:{...state.ref,source,contextKey:state.contextKey}});}catch{/* A missing association cannot affect evidence or transport. */}
 }
 elapsed(ref:DiagnosticSpan|undefined){const state=this.state(ref);return state?bounded(this.now()-state.at,86400000):0;}
 private emit(state:State,phase:Phase,details:{clock?:'server'|'client';elapsedMs?:number;queueMs?:number;rttMs?:number;state?:'unbound_stream'}={}){
  if(this.closed)return;
  const client=details.clock==='client';
  const kind=['tool_requested','tool_completed'].includes(phase)?'tool':['input_received','speech_started','speech_stopped','input_final','input_failed'].includes(phase)?'interaction':'connection';
  const status=phase==='error'||phase==='input_failed'?'failed':phase==='response_requested'||phase==='tool_requested'?'requested':'recorded';
  try{this.options.emit({eventKey:`diagnostic:${state.ref.spanId}:${phase}:${randomUUID()}`,kind,actor:client?'application':state.source==='provider'?'provider':'application',status,name:'diagnostic_phase',details:{...state.ref,phase,clock:client?'client':'server',source:client?'client':state.source,contextKey:state.contextKey,elapsedMs:client?details.elapsedMs:bounded(this.now()-state.at,86400000),...(details.queueMs===undefined?{}:{queueMs:bounded(details.queueMs,12000)}),...(details.rttMs===undefined?{}:{rttMs:bounded(details.rttMs,60000)}),...(details.state?{state:details.state}:{})}});}catch{/* Optional diagnostics never change classroom behavior. */}
 }
 mark(ref:DiagnosticSpan|undefined,phase:Phase,details:{queueMs?:number;rttMs?:number;state?:'unbound_stream'}={}){
  const state=this.state(ref);if(!state||state.seen.has(phase)||this.closed)return;
  state.seen.add(phase);this.emit(state,phase,details);
 }
 private notify(state:State,value:Metadata['state']){try{return this.options.notify({type:'diagnostic.response',...state.ref,state:value});}catch{return false;}}
 announce(ref:DiagnosticSpan|undefined){
  const state=this.state(ref);if(!state||this.closed)return;
  if(!state.announced&&state.terminal!=='cancelled'&&state.scope&&state.scope===this.current()?.scope){
   state.announced=this.notify(state,'started');if(state.announced&&state.terminal)this.notify(state,state.terminal);
  }
 }
 audioSent(ref:DiagnosticSpan|undefined,queueMs?:number){this.announce(ref);this.mark(ref,'audio_first_sent',queueMs===undefined?{}:{queueMs});}
 audioQueued(ref:DiagnosticSpan|undefined,bytes:number){const state=this.state(ref);if(state&&!this.closed&&!state.terminal)state.queuedAudio+=bounded(bytes,576000);}
 audioDrained(ref:DiagnosticSpan|undefined,bytes:number){const state=this.state(ref);if(!state||this.closed||state.terminal)return;state.queuedAudio=Math.max(0,state.queuedAudio-bounded(bytes,576000));this.complete(state);}
 private complete(state:State){if(state.providerDone&&!state.queuedAudio&&!state.terminal){state.terminal='completed';if(state.announced)this.notify(state,'completed');}}
 responseDone(ref:DiagnosticSpan|undefined,cancelled=false){
  const state=this.state(ref);if(!state||this.closed||state.terminal==='cancelled'||!cancelled&&state.terminal==='completed')return;
  if(cancelled){state.terminal='cancelled';this.mark(ref,'response_cancelled');if(state.announced)this.notify(state,'cancelled');}
  else{state.providerDone=true;this.mark(ref,'response_completed');this.complete(state);}
 }
 interrupt(){for(const state of this.spans.values())if(state.announced&&!state.playbackFinished)this.responseDone(state.ref,true);}
 playback(value:unknown):boolean{
  const parsed=playbackSchema.safeParse(value);if(!parsed.success||this.closed)return false;
  const message=parsed.data,state=this.state(message),now=this.now();
  if(!state?.announced||!state.scope||state.scope!==this.current()?.scope||state.terminal==='cancelled'||state.playbackFinished||message.elapsedMs<state.clientElapsed)return false;
  if(message.phase==='playback_started'){if(state.playbackStarted)return false;state.playbackStarted=true;}
  else if(message.phase==='playback_finished'){if(!state.playbackStarted||state.terminal!=='completed')return false;state.playbackFinished=true;}
  else{if(now-state.lastSample<1000||now-this.lastClientSample<1000)return false;state.lastSample=now;this.lastClientSample=now;}
  state.clientElapsed=message.elapsedMs;this.emit(state,message.phase,{clock:'client',elapsedMs:message.elapsedMs,queueMs:message.queueMs});return true;
 }
 close(){this.closed=true;this.spans.clear();this.bindings.clear();this.associations.clear();}
}
