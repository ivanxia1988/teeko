import {z} from 'zod';
import {classroomTaskContextSchema} from './domain/classroom-context';

export const CLASSROOM_POINT_CLIENT_STAGES=['clicked','sent','send_failed','acknowledged','unavailable','timeout'] as const;
export const CLASSROOM_POINT_STAGES=[...CLASSROOM_POINT_CLIENT_STAGES,'server_received','server_rejected','accepted','reply_queued','reply_requested','reply_started','audio_sent','playback_started','cancelled','expired'] as const;
export const CLASSROOM_POINT_REASONS=['not_ready','busy','invalid_context','unknown_object','send_backpressure','send_failed','ack_timeout','server_rejected','unsupported','rate_limited','superseded','unknown','expired','duplicate','lease_lost','persistence_failed','stale_context','pending_response','context_changed','invalid_request','ack_failed'] as const;
export type ClassroomPointStage=typeof CLASSROOM_POINT_STAGES[number];
export type ClassroomPointReason=typeof CLASSROOM_POINT_REASONS[number];
export const classroomPointDiagnosticEventSchema=z.object({
 id:z.string().uuid(),pointId:z.string().uuid(),context:classroomTaskContextSchema,stage:z.enum(CLASSROOM_POINT_CLIENT_STAGES),reason:z.enum(CLASSROOM_POINT_REASONS).optional(),
 objectId:z.string().min(1).max(100).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value)).optional(),
}).strict();
export type ClassroomPointDiagnosticEvent=z.infer<typeof classroomPointDiagnosticEventSchema>;
export const classroomPointDiagnosticsBodySchema=z.object({events:z.array(classroomPointDiagnosticEventSchema).min(1).max(10)}).strict();
export const classroomPointJournalDetailsSchema=z.object({pointId:z.string().uuid().optional(),pointStage:z.enum(CLASSROOM_POINT_STAGES).optional(),pointReason:z.enum(CLASSROOM_POINT_REASONS).optional(),clientDiagnosticsVersion:z.literal(1).optional(),clientPointVersion:z.literal(1).optional()});
export type ClassroomPointJournalDetails=z.infer<typeof classroomPointJournalDetailsSchema>;
export function sanitizeClassroomPointDetails(value:unknown):ClassroomPointJournalDetails{
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 const result:Record<string,unknown>={};for(const [key,schema]of Object.entries(classroomPointJournalDetailsSchema.shape)){const parsed=schema.safeParse((value as Record<string,unknown>)[key]);if(parsed.success&&parsed.data!==undefined)result[key]=parsed.data;}
 return classroomPointJournalDetailsSchema.parse(result);
}
