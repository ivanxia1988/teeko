import type {PcmCaptureMetrics,PcmAudiblePlayback,PcmUnavailablePlayback} from './voice-audio';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Episode={id:string;firstSequence:number;lastVoiceSequence:number;lastVoiceAt:number;stopped:boolean;reported:boolean;reportAttempted:boolean;bound:boolean;scopePending:boolean;invalid:boolean;maxGap:number};
type Binding={inputId:string;sequence:number;firstAudioAt:number|null;tag:string};
/** Local energy boundaries only. No absolute clock or media leaves this observer. */
export class ClassroomLatencyClient{
 private sequence=0;
 private bindingSequence=0;
 private lastCaptureAt:number|null=null;
 private episode:Episode|null=null;
 private readonly bindings=new Map<string,Binding>();
 private readonly retired=new Set<string>();
 constructor(private readonly options:{now:()=>number;id:()=>string;send:(value:Record<string,unknown>)=>boolean}){}
 private retire(id:string){this.retired.add(id);while(this.retired.size>128)this.retired.delete(this.retired.values().next().value!);}
 private clearBindings(retire=true){if(retire)for(const id of this.bindings.keys())this.retire(id);this.bindings.clear();}
 capture(metrics:PcmCaptureMetrics|undefined):{latencyInputId:string;audioSequence:number}|undefined{
  if(!metrics||!Number.isFinite(metrics.atMs)||!Number.isFinite(metrics.level)||metrics.level<0||metrics.level>1||!Number.isFinite(metrics.frameMs)||metrics.frameMs<=0||metrics.frameMs>250||metrics.atMs>this.options.now()+1){this.unmeasured('capture_gap');this.reset();return;}
  const previous=this.lastCaptureAt;let gap=previous===null?0:metrics.atMs-previous;
  if(previous!==null&&(gap<=0||gap>500)){this.unmeasured('capture_gap',Math.max(0,gap-metrics.frameMs));this.reset();gap=0;}
  this.lastCaptureAt=metrics.atMs;
  const audioSequence=this.sequence++,voiced=metrics.level>=.015;
  if(voiced){
   const previousEpisode=this.episode;
   if(!previousEpisode||previousEpisode.bound||previousEpisode.scopePending||previousEpisode.invalid||metrics.atMs-previousEpisode.lastVoiceAt>=1200){
    this.clearBindings();let id:string;try{id=this.options.id();}catch{return;}if(!uuid.test(id))return;
    this.episode={id,firstSequence:audioSequence,lastVoiceSequence:audioSequence,lastVoiceAt:metrics.atMs,stopped:false,reported:false,reportAttempted:false,bound:false,scopePending:false,invalid:false,maxGap:0};
   }else{
    this.clearBindings();previousEpisode.lastVoiceSequence=audioSequence;previousEpisode.lastVoiceAt=metrics.atMs;previousEpisode.stopped=false;previousEpisode.reported=false;previousEpisode.reportAttempted=false;
   }
  }
  const episode=this.episode;if(!episode)return;
  episode.maxGap=Math.max(episode.maxGap,Math.max(0,gap-metrics.frameMs));
  // This is an energy boundary from a quiet frame, never a provider-final claim.
  if(!voiced&&!episode.invalid&&!episode.reportAttempted){
   episode.stopped=true;episode.reportAttempted=true;
   episode.reported=this.send({type:'diagnostic.input',inputId:episode.id,firstSequence:episode.firstSequence,lastVoiceSequence:episode.lastVoiceSequence,phase:'stopped',silenceMs:Math.round(Math.min(10000,metrics.atMs-episode.lastVoiceAt))});
  }
  return{latencyInputId:episode.id,audioSequence};
 }
 receive(message:Record<string,unknown>){
  if(message.type!=='diagnostic.latency'||typeof message.measurementId!=='string'||!uuid.test(message.measurementId))return;
  const id=message.measurementId;
  if(message.state==='cancelled'){this.bindings.delete(id);this.retire(id);return;}
  const allowed=['type','measurementId','inputId','turnId','spanId','basis','state','lastVoiceSequence'];
  const episode=this.episode;
  if(message.state!=='bound'||Object.keys(message).length!==allowed.length||!Object.keys(message).every(key=>allowed.includes(key))||typeof message.inputId!=='string'||!uuid.test(message.inputId)||typeof message.turnId!=='string'||!uuid.test(message.turnId)||typeof message.spanId!=='string'||!uuid.test(message.spanId)||!['provider_turn','application_window'].includes(String(message.basis))||!Number.isSafeInteger(message.lastVoiceSequence)||!episode||episode.invalid||!episode.stopped||!episode.reported||message.inputId!==episode.id||message.lastVoiceSequence!==episode.lastVoiceSequence||this.retired.has(id)||this.options.now()-episode.lastVoiceAt>120000)return;
  if(this.bindings.has(id))return;
  if(this.bindings.size){episode.invalid=true;this.clearBindings();this.retire(id);return;}
  episode.bound=true;episode.scopePending=false;this.bindings.set(id,{inputId:episode.id,sequence:episode.lastVoiceSequence,firstAudioAt:null,tag:`${id}:${++this.bindingSequence}`});
 }
 audio(measurementId:unknown):string|undefined{
  if(typeof measurementId!=='string'||!uuid.test(measurementId)){
   if(this.bindings.size)this.unmeasured('playback_unbound');
   return;
  }
  const binding=this.bindings.get(measurementId),episode=this.episode;
  if(!binding||!episode||episode.invalid||binding.inputId!==episode.id||binding.sequence!==episode.lastVoiceSequence){if(this.bindings.size)this.unmeasured('playback_unbound');return;}
  binding.firstAudioAt??=this.options.now();return binding.tag;
 }
 audible(event:PcmAudiblePlayback){
  const approved=[...this.bindings.entries()].find(([,binding])=>binding.tag===event.measurementId),measurementId=approved?.[0],binding=approved?.[1],episode=this.episode,now=this.options.now();
  if(binding&&this.lastCaptureAt!==null&&now-this.lastCaptureAt>500){this.unmeasured('capture_gap',now-this.lastCaptureAt);return;}
  if(!measurementId||!binding||!episode||episode.invalid||!episode.stopped||binding.inputId!==episode.id||binding.sequence!==episode.lastVoiceSequence||binding.firstAudioAt===null||this.lastCaptureAt===null||now-this.lastCaptureAt>500||!Number.isFinite(event.atMs)||event.atMs>now+1)return;
  const waitMs=Math.round(event.atMs-episode.lastVoiceAt),playbackMs=Math.round(event.atMs-binding.firstAudioAt);
  if(waitMs<0||waitMs>120000||playbackMs<0||playbackMs>120000)return;
  this.bindings.delete(measurementId);this.retire(measurementId);episode.invalid=true;
  this.send({type:'diagnostic.latency',measurementId,phase:'playback_started',waitMs,captureGapMs:Math.round(Math.min(10000,episode.maxGap)),playbackMs});
 }
 unavailable(event:PcmUnavailablePlayback){if([...this.bindings.values()].some(binding=>binding.tag===event.measurementId))this.unmeasured(event.reason);}
 private unmeasured(reason:'capture_gap'|'playback_unbound'|'playback_clock',gap?:number){
  const episode=this.episode;if(!episode||episode.invalid)return;
  episode.invalid=true;this.clearBindings();
  this.send({type:'diagnostic.input',inputId:episode.id,phase:'unmeasured',reason,...(reason==='capture_gap'&&Number.isFinite(gap)?{captureGapMs:Math.round(Math.max(0,Math.min(10000,gap!)))}:{})});
 }
 private send(message:Record<string,unknown>){try{return this.options.send(message);}catch{return false;}}
 interrupt(){if(this.bindings.size&&this.episode)this.episode.invalid=true;this.clearBindings();}
 scopeChanged(){
  const episode=this.episode;this.clearBindings(false);
  if(!episode||episode.invalid||!episode.stopped){this.reset();return;}
  // Only the server can authorize an automatic task advance to retain this input.
  episode.bound=false;episode.scopePending=true;
 }
 reset(){this.clearBindings();this.episode=null;this.lastCaptureAt=null;}
}
