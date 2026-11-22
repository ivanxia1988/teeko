import {z} from 'zod';
import {captureClassroomToolState} from './classroom-tool-state';
import {validateClassroomEvent,type ClassroomEventValidation} from './domain/classroom-event';

type InputSnapshot=Parameters<typeof captureClassroomToolState>[0];
type Receipt={id:string;receivedAtMs:number};

const annotationWire=z.object({
 type:z.literal('interaction'),eventId:z.unknown(),contextKey:z.string(),
 action:z.unknown(),strokeCount:z.unknown(),pointCount:z.unknown(),
}).strict();

/** Call at the authenticated connection boundary; the browser supplies neither provenance nor complete scope. */
export function captureClassroomAnnotation(snapshot:InputSnapshot,receivedAtMs:number,input:unknown):ClassroomEventValidation{
 const captured=captureClassroomToolState(snapshot);
 if(!captured.ok)return {accepted:false,reason:'invalid_state'};
 const parsed=annotationWire.safeParse(input);
 if(!parsed.success||parsed.data.contextKey!==`${snapshot.id}:${snapshot.connectionEpoch}:${snapshot.stepIndex}`)return {accepted:false,reason:'invalid_event'};
 const {eventId,action,strokeCount,pointCount}=parsed.data;
 return validateClassroomEvent(captured.snapshot,{
  id:eventId,receivedAtMs,context:captured.snapshot.context,type:'annotation.changed',source:'action',
  payload:{action,strokeCount,pointCount},
 });
}


const transcriptWire=z.object({role:z.enum(['child','teacher']),text:z.unknown(),final:z.literal(true),itemId:z.unknown(),contextKey:z.string(),source:z.enum(['speech','typed'])}).strict();
export function captureClassroomTranscript(snapshot:InputSnapshot,receipt:Receipt,input:unknown,provider:'qwen'|'openai'|'grok'):ClassroomEventValidation{
 const captured=captureClassroomToolState(snapshot);if(!captured.ok)return {accepted:false,reason:'invalid_state'};
 const parsed=transcriptWire.safeParse(input);
 if(!parsed.success||parsed.data.contextKey!==`${snapshot.id}:${snapshot.connectionEpoch}:${snapshot.stepIndex}`)return {accepted:false,reason:'invalid_event'};
 const {role,text,itemId,source}=parsed.data;
 return validateClassroomEvent(captured.snapshot,{id:receipt.id,receivedAtMs:receipt.receivedAtMs,context:captured.snapshot.context,type:'transcript.final',source:source==='typed'?'action':'voice',payload:{role,text,itemId,input:source==='typed'?'typed':'speech',...(source==='speech'?{boundary:provider==='openai'?'application_segment':'provider_final'}:{})}});
}

const selectionWire=z.object({type:z.literal('select'),eventId:z.unknown(),expectedRevision:z.number(),objectIds:z.unknown()}).strict();
export function captureClassroomSelection(snapshot:InputSnapshot,receivedAtMs:number,input:unknown):ClassroomEventValidation{
 const captured=captureClassroomToolState(snapshot);if(!captured.ok)return {accepted:false,reason:'invalid_state'};
 const parsed=selectionWire.safeParse(input);
 if(!parsed.success||parsed.data.expectedRevision!==snapshot.revision)return {accepted:false,reason:'invalid_event'};
 return validateClassroomEvent(captured.snapshot,{id:parsed.data.eventId,receivedAtMs,context:captured.snapshot.context,type:'selection.committed',source:'interaction',payload:{objectIds:parsed.data.objectIds}});
}

const visualWire=z.object({status:z.unknown(),generation:z.unknown(),message:z.unknown().optional()}).strict();
export function captureClassroomVisualState(snapshot:InputSnapshot,receipt:Receipt,target:'camera'|'board',input:unknown):ClassroomEventValidation{
 const captured=captureClassroomToolState(snapshot);if(!captured.ok)return {accepted:false,reason:'invalid_state'};
 const parsed=visualWire.safeParse(input);if(!parsed.success)return {accepted:false,reason:'invalid_event'};
 return validateClassroomEvent(captured.snapshot,{id:receipt.id,receivedAtMs:receipt.receivedAtMs,context:captured.snapshot.context,type:'visual.state',source:'vision',payload:{target,status:parsed.data.status,generation:parsed.data.generation}});
}
