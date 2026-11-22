import {randomUUID} from 'node:crypto';
import {AUDIO_DIAGNOSTIC_WINDOW_MS,audioContinuityReportSchema,type AudioContinuityStats} from '../classroom-audio-diagnostics';
import type {ClassroomJournalEntry} from '../classroom-journal';

type Scope={contextKey:string;playbackId:number};
type Window={scope:string;at:number;last:number|null;chunkCount:number;audioMs:number;audibleChunkCount:number;maxArrivalGapMs:number;minQueueMs?:number;maxQueueMs?:number;maxScheduleLagMs?:number};
const bounded=(v:number,max=60000)=>Math.min(max,Math.max(0,Math.round(Number.isFinite(v)?v:0)));
/** Transport observations only; upstream PCM can contain intentional silence. No media retained. */
export class ClassroomAudioDiagnostics{
 private windows=new Map<'upstream'|'server',Window>();
 private closed=false;
 private sequence=0;
 private browserAt=-Infinity;
 private playbackFloor=0;
 private interrupted:{scope:string;playbackId:number;until:number}|null=null;
 private now:()=>number;
 constructor(private readonly options:{current:()=>Scope|null;emit:(entry:ClassroomJournalEntry)=>unknown;now?:()=>number}){this.now=options.now??(()=>performance.now());}
 private scope(){try{return this.options.current();}catch{return null;}}
 private emit(stats:AudioContinuityStats,scope:string){
  try{this.options.emit({eventKey:`audio-continuity:${randomUUID()}`,kind:'connection',actor:stats.boundary==='upstream'?'provider':'application',status:'recorded',name:'audio_continuity',details:{contextKey:scope,clock:stats.boundary==='browser'?'client':'server',source:stats.boundary==='browser'?'client':stats.boundary==='upstream'?'provider':'application',audioStats:stats}});}catch{/* Optional observations never stop media. */}
 }
 private flush(boundary:'upstream'|'server',w:Window){
  if(!w.chunkCount)return;
  this.emit({boundary,windowMs:bounded(this.now()-w.at),chunkCount:bounded(w.chunkCount,12000),audioMs:bounded(w.audioMs,120000),audibleChunkCount:bounded(w.audibleChunkCount,12000),maxArrivalGapMs:bounded(w.maxArrivalGapMs),...(w.minQueueMs===undefined?{}:{minQueueMs:bounded(w.minQueueMs,12000),maxQueueMs:bounded(w.maxQueueMs??0,12000)}),...(w.maxScheduleLagMs===undefined?{}:{maxScheduleLagMs:bounded(w.maxScheduleLagMs)})},w.scope);
 }
 private window(boundary:'upstream'|'server'){
  const scope=this.scope();if(this.closed||!scope)return null;
  let w=this.windows.get(boundary);
  if(w&&w.scope!==scope.contextKey){this.flush(boundary,w);this.windows.delete(boundary);w=undefined;}
  if(!w){w={scope:scope.contextKey,at:this.now(),last:null,chunkCount:0,audioMs:0,audibleChunkCount:0,maxArrivalGapMs:0};this.windows.set(boundary,w);}
  return w;
 }
 private record(boundary:'upstream'|'server',pcm:Buffer){
  if(!pcm.length||pcm.length%2||pcm.length>192000)return;
  const w=this.window(boundary);if(!w)return;const now=this.now();
  if(w.last!==null)w.maxArrivalGapMs=Math.max(w.maxArrivalGapMs,now-w.last);
  w.last=now;w.chunkCount++;w.audioMs+=pcm.length/48;
  for(let i=0;i<pcm.length;i+=2)if(Math.abs(pcm.readInt16LE(i)/32768)>=.015){w.audibleChunkCount++;break;}
  if(now-w.at>=AUDIO_DIAGNOSTIC_WINDOW_MS||w.chunkCount>=12000||w.audioMs>=116000){this.flush(boundary,w);this.windows.set(boundary,{scope:w.scope,at:now,last:w.last,chunkCount:0,audioMs:0,audibleChunkCount:0,maxArrivalGapMs:0});}
 }
 upstream(pcm:Buffer){this.record('upstream',pcm);}
 sent(pcm:Buffer){this.record('server',pcm);}
 pacing(value:{scheduleLagMs:number;queueMs:number}){
  const w=this.window('server');if(!w)return;
  w.maxScheduleLagMs=Math.max(w.maxScheduleLagMs??0,bounded(value.scheduleLagMs));
  const queue=bounded(value.queueMs,12000);w.minQueueMs=Math.min(w.minQueueMs??queue,queue);w.maxQueueMs=Math.max(w.maxQueueMs??0,queue);
 }
 browser(value:unknown):boolean{
  if(this.closed)return false;const parsed=audioContinuityReportSchema.safeParse(value),scope=this.scope(),now=this.now();
  if(!parsed.success||!scope)return false;const r=parsed.data;
  const boundary=this.interrupted&&r.contextKey===this.interrupted.scope&&r.playbackId===this.interrupted.playbackId&&now<=this.interrupted.until;
  if(r.contextKey!==scope.contextKey||r.playbackId>scope.playbackId||!boundary&&r.playbackId<this.playbackFloor||r.sequence<=this.sequence||!boundary&&now-this.browserAt<500)return false;
  if(boundary)this.interrupted=null;
  this.sequence=r.sequence;this.browserAt=now;this.emit(r.audioStats,scope.contextKey);return true;
 }
 reset(previousPlaybackId?:number){
  for(const [boundary,w] of this.windows)this.flush(boundary,w);this.windows.clear();const scope=this.scope();
  this.playbackFloor=scope?.playbackId??this.playbackFloor;
  this.interrupted=scope&&previousPlaybackId!==undefined&&previousPlaybackId===scope.playbackId-1?{scope:scope.contextKey,playbackId:previousPlaybackId,until:this.now()+1500}:null;
 }
 close(){if(this.closed)return;this.reset();this.closed=true;}
}
