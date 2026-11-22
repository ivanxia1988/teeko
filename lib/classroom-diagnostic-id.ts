import {z} from 'zod';
import type {ClassroomJournalEvents} from './classroom-journal';

const decimal=/^[1-9]\d{0,18}$/;
const maxEventId=BigInt('9223372036854775807');
const referenceSchema=z.object({
 classroomId:z.string().uuid().toLowerCase(),
 eventId:z.string().regex(decimal).refine(value=>decimal.test(value)&&BigInt(value)<=maxEventId).optional(),
}).strict();
export type ClassroomDiagnosticReference=z.infer<typeof referenceSchema>;

/** A locator for a classroom or a persistent journal event, never an authorization token. */
export function formatClassroomDiagnosticId(input:ClassroomDiagnosticReference):string{
 const reference=referenceSchema.parse(input);
 return `TKLOG1:${reference.classroomId}${reference.eventId?`:E${reference.eventId}`:''}`;
}
export function parseClassroomDiagnosticId(input:unknown):ClassroomDiagnosticReference|null{
 if(typeof input!=='string'||input.length>100)return null;
 const match=/^TKLOG1:([0-9a-f-]{36})(?::E([1-9]\d{0,18}))?$/i.exec(input.trim());
 if(!match)return null;
 const parsed=referenceSchema.safeParse({classroomId:match[1],...(match[2]?{eventId:match[2]}:{})});
 return parsed.success?parsed.data:null;
}

export function formatPersistentEventDiagnosticId(reference:ClassroomDiagnosticReference&{eventId:string},coverage:ClassroomJournalEvents['coverage']):string|null{
 if(coverage!=='journal')return null;
 const parsed=referenceSchema.safeParse(reference);
 return parsed.success?formatClassroomDiagnosticId(parsed.data):null;
}
