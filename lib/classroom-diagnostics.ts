import {sanitizeClassroomPointDetails,type ClassroomPointJournalDetails} from './classroom-point-diagnostics';
import {formatClassroomDiagnosticId,formatPersistentEventDiagnosticId} from './classroom-diagnostic-id';
import {sanitizeAudioContinuityStats,audioContinuityHasGap,type AudioContinuityStats} from './classroom-audio-diagnostics';
import {CLASSROOM_DIAGNOSTIC_PHASES,CLASSROOM_LATENCY_STAGES,CLASSROOM_LATENCY_BASES,sanitizeClassroomJournalText,sanitizeClassroomProviderErrorDetails,sanitizeClassroomVoiceRecoveryMetadata,type ClassroomVoiceRecoveryMetadata,type ClassroomProviderErrorDetails,type ClassroomJournalEvent} from './classroom-journal';

export const diagnosticPhases=CLASSROOM_DIAGNOSTIC_PHASES;
export type DiagnosticPhase=typeof diagnosticPhases[number];
export type DiagnosticClock='server'|'client';
export type DiagnosticProjectionOptions={coverage?:'journal'|'legacy_transcripts'|'none';complete?:boolean;totalEventCount?:number};
export type DiagnosticEvent=Pick<ClassroomJournalEvent,'id'|'createdAt'|'epoch'|'revision'|'stepIndex'|'kind'|'actor'|'status'|'name'|'text'|'correlationId'>&ClassroomProviderErrorDetails&ClassroomPointJournalDetails&ClassroomVoiceRecoveryMetadata&{
 audioStats?:AudioContinuityStats;
 errorCode:string|null;state:string|null;turnId:string|null;spanId:string|null;phase:DiagnosticPhase|null;clock:DiagnosticClock|null;elapsedMs:number|null;queueMs:number|null;rttMs:number|null;
 measurementId:string|null;latencyInputId:string|null;latencyStage:typeof CLASSROOM_LATENCY_STAGES[number]|null;latencyBasis:typeof CLASSROOM_LATENCY_BASES[number]|null;waitMs:number|null;playbackMs:number|null;captureGapMs:number|null;
 source:NonNullable<ClassroomJournalEvent['details']['source']>|null;playback:'generated'|'client_reported'|null;
};
export type DiagnosticTurn={id:string;association:'measurement'|'turn'|'span'|'correlation'|'unknown';eventIds:string[];events:DiagnosticEvent[];firstAnomalyEventId:string|null};
export type DiagnosticCoverage={source:'journal'|'legacy_transcripts'|'none';loadedEventCount:number;totalEventCount:number|null;complete:boolean;firstEventId:string|null;lastEventId:string|null;unlinkedEventCount:number;timingEventCount:number};
export type ClassroomDiagnostics={events:DiagnosticEvent[];turns:DiagnosticTurn[];firstAnomaly:DiagnosticEvent|null;coverage:DiagnosticCoverage};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const latencyStates=new Set(['receiving_input','waiting_reply','waiting_audio','waiting_playback','capture_gap','playback_unbound','playback_clock','scope_changed','context_changed','interrupted','new_input','new_voice','response_cancelled','playback_interrupted','input_invalidated','stop_unconfirmed','closed','overlapping_input','ambiguous_input','ambiguous_response','mixed_audio','expired','advance_timeout','advance_unverified']);
const identifier=(value:unknown)=>typeof value==='string'&&uuid.test(value)?value.toLowerCase():null;
const duration=(value:unknown,max=86_400_000)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=max?value:null;
export const isDiagnosticAnomaly=(event:DiagnosticEvent)=>event.status==='failed'||event.status==='rejected'||event.phase==='error'||event.phase==='input_failed'||event.name==='journal_gap'||!!event.audioStats&&audioContinuityHasGap(event.audioStats);
const sources=['speech','typed','model','application','provider','client','camera','board'] as const;
const token=(event:DiagnosticEvent,type:string,value:string)=>`${event.epoch}:${type}:${value}`;

/** IDs establish association; neither wall-clock proximity nor event names establish a turn or a duration. */
export function projectClassroomDiagnostics(input:readonly ClassroomJournalEvent[],options:DiagnosticProjectionOptions={}):ClassroomDiagnostics{
 const seen=new Set<string>();
 const events:DiagnosticEvent[]=[...input].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0).filter(event=>!seen.has(event.id)&&!!seen.add(event.id)).map(event=>{
  const details:Record<string,unknown>=event.details,clock=details.clock==='server'||details.clock==='client'?details.clock:null;
  const phase=diagnosticPhases.includes(details.phase as DiagnosticPhase)?details.phase as DiagnosticPhase:null;
  const source=sources.includes(details.source as typeof sources[number])?details.source as typeof sources[number]:null;
  const playback=details.playback==='generated'?'generated':source==='client'&&clock==='client'&&phase?.startsWith('playback_')?'client_reported':null;
  return {audioStats:sanitizeAudioContinuityStats(details.audioStats),...sanitizeClassroomVoiceRecoveryMetadata({...(event.name==='voice_request_recovery'?{recoveryState:details.state}:{}),...(event.name==='voice_provider_failure'?{providerErrorAction:details.action}:{})}),...sanitizeClassroomPointDetails(details),...sanitizeClassroomProviderErrorDetails(details),measurementId:identifier(details.measurementId),latencyInputId:identifier(details.latencyInputId),latencyStage:CLASSROOM_LATENCY_STAGES.includes(details.latencyStage as typeof CLASSROOM_LATENCY_STAGES[number])?details.latencyStage as typeof CLASSROOM_LATENCY_STAGES[number]:null,latencyBasis:CLASSROOM_LATENCY_BASES.includes(details.latencyBasis as typeof CLASSROOM_LATENCY_BASES[number])?details.latencyBasis as typeof CLASSROOM_LATENCY_BASES[number]:null,waitMs:duration(details.waitMs,120000),playbackMs:duration(details.playbackMs,120000),captureGapMs:duration(details.captureGapMs,10000),id:event.id,createdAt:event.createdAt,epoch:event.epoch,revision:event.revision,stepIndex:event.stepIndex,kind:event.kind,actor:event.actor,status:event.status,name:sanitizeClassroomJournalText(event.name,80),text:event.text===null?null:sanitizeClassroomJournalText(event.text),correlationId:event.correlationId?sanitizeClassroomJournalText(event.correlationId,200):null,turnId:identifier(details.turnId),spanId:identifier(details.spanId),phase,clock,source,playback,errorCode:typeof details.errorCode==='string'?sanitizeClassroomJournalText(details.errorCode,80):null,state:typeof details.state==='string'?sanitizeClassroomJournalText(details.state,80):null,elapsedMs:clock?duration(details.elapsedMs):null,queueMs:clock?duration(details.queueMs,12_000):null,rttMs:clock?duration(details.rttMs,60_000):null};
 });
 const associations=new Map<string,Set<string>>();
 for(const event of events){
  if(!event.turnId)continue;
  for(const [type,value] of [['span',event.spanId],['correlation',event.correlationId]] as const){
   if(value){const key=token(event,type,value),turns=associations.get(key)??new Set<string>();turns.add(event.turnId);associations.set(key,turns);}
  }
 }
 const groups=new Map<string,DiagnosticTurn>();
 for(const event of events){
  let turnId=event.turnId;
  if(!turnId){
   const candidates=new Set<string>();let ambiguous=false;
   for(const [type,value] of [['span',event.spanId],['correlation',event.correlationId]] as const){
    const matched=value?associations.get(token(event,type,value)):undefined;
    if(matched){if(matched.size>1)ambiguous=true;for(const value of matched)candidates.add(value);}
   }
   if(!ambiguous&&candidates.size===1)turnId=[...candidates][0];
  }
  const association=event.measurementId?'measurement':turnId?'turn':event.spanId?'span':event.correlationId?'correlation':'unknown';
  const id=token(event,association,event.measurementId??turnId??event.spanId??event.correlationId??event.id);
  const group=groups.get(id)??{id,association,eventIds:[],events:[],firstAnomalyEventId:null};
  group.eventIds.push(event.id);group.events.push(event);if(!group.firstAnomalyEventId&&isDiagnosticAnomaly(event))group.firstAnomalyEventId=event.id;groups.set(id,group);
 }
 const totalEventCount=duration(options.totalEventCount,Number.MAX_SAFE_INTEGER);
 return {events,turns:[...groups.values()],firstAnomaly:events.find(isDiagnosticAnomaly)??null,coverage:{source:options.coverage??'journal',loadedEventCount:events.length,totalEventCount,complete:options.complete===true&&(totalEventCount===null||totalEventCount===events.length),firstEventId:events[0]?.id??null,lastEventId:events.at(-1)?.id??null,unlinkedEventCount:events.filter(event=>!event.measurementId&&!event.turnId&&!event.spanId&&!event.correlationId).length,timingEventCount:events.filter(event=>event.elapsedMs!==null||event.queueMs!==null||event.rttMs!==null||event.waitMs!==null||event.playbackMs!==null||event.captureGapMs!==null).length}};
}

/** Exports omit free text and provider IDs; only locally shaped request IDs and fixed error labels survive. */
export function exportClassroomDiagnostics(projection:ClassroomDiagnostics,classroomId?:string){
 const coverage=projection.coverage,diagnosticId=classroomId===undefined?undefined:formatClassroomDiagnosticId({classroomId});
 return {version:1 as const,scope:'loaded_events_only' as const,...(diagnosticId?{diagnosticId}:{}),coverage:{source:coverage.source,loadedEventCount:coverage.loadedEventCount,totalEventCount:coverage.totalEventCount,complete:coverage.complete,firstEventId:coverage.firstEventId,lastEventId:coverage.lastEventId,unlinkedEventCount:coverage.unlinkedEventCount,timingEventCount:coverage.timingEventCount},firstAnomalyEventId:projection.firstAnomaly?.id??null,events:projection.events.map(event=>{
  const eventDiagnosticId=classroomId===undefined?null:formatPersistentEventDiagnosticId({classroomId,eventId:event.id},coverage.source);
  return {...(event.audioStats?{audioStats:sanitizeAudioContinuityStats(event.audioStats)}:{}),...sanitizeClassroomVoiceRecoveryMetadata(event),...sanitizeClassroomPointDetails(event),...sanitizeClassroomProviderErrorDetails(event),...(event.measurementId?{measurementId:event.measurementId,...(event.state&&latencyStates.has(event.state)?{latencyState:event.state}:{}),...(event.latencyInputId?{latencyInputId:event.latencyInputId}:{}),...(event.latencyStage?{latencyStage:event.latencyStage}:{}),...(event.latencyBasis?{latencyBasis:event.latencyBasis}:{}),...(event.waitMs===null?{}:{waitMs:event.waitMs}),...(event.playbackMs===null?{}:{playbackMs:event.playbackMs}),...(event.captureGapMs===null?{}:{captureGapMs:event.captureGapMs})}:{}),id:event.id,...(eventDiagnosticId?{diagnosticId:eventDiagnosticId}:{}),createdAt:event.createdAt,epoch:event.epoch,revision:event.revision,stepIndex:event.stepIndex,kind:event.kind,actor:event.actor,status:event.status,turnId:event.turnId,spanId:event.spanId,phase:event.phase,clock:event.clock,source:event.source,playback:event.playback,elapsedMs:event.elapsedMs,queueMs:event.queueMs,rttMs:event.rttMs};
 })};
}
