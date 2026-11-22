import {z} from 'zod';
import {classroomPointJournalDetailsSchema} from './classroom-point-diagnostics';
import {audioContinuityStatsSchema} from './classroom-audio-diagnostics';

export const classroomJournalKindSchema=z.enum(['utterance','interaction','tool','connection','visual']);
export const classroomJournalActorSchema=z.enum(['child','teacher','application','provider']);
export const classroomJournalStatusSchema=z.enum(['recorded','requested','confirmed','rejected','failed']);
const count=z.number().int().nonnegative().safe(),identifier=z.string().uuid(),date=z.string().datetime();
const detailText=z.string().max(1000);
export const CLASSROOM_DIAGNOSTIC_PHASES=['session_started','session_ended','input_received','speech_started','speech_stopped','input_final','input_failed','application_started','application_completed','model_started','model_completed','response_requested','response_started','audio_first_received','audio_first_sent','playback_started','playback_finished','playback_sample','response_completed','response_cancelled','context_updated','tool_requested','tool_completed','error'] as const;
export const CLASSROOM_LATENCY_STAGES=['input_received','speech_stopped','input_final','application_started','response_requested','response_started','audio_first_received','audio_first_sent','playback_started','wait_update','cancelled','unmeasured'] as const;
export const CLASSROOM_LATENCY_BASES=['provider_turn','application_window'] as const;
export const CLASSROOM_PROVIDER_ERROR_REASONS=['unknown','cancel_without_response','response_overlap','empty_audio_commit','invalid_image','invalid_audio','unknown_tool_call','unsupported_operation','empty_output','content_policy','context_limit','upstream_timeout','configuration_rejected'] as const;
export const CLASSROOM_PROVIDER_ERROR_MESSAGE_CATEGORIES=['active','cancel','empty','image','audio','tool','unsupported','invalid','instruction','response','format','event','buffer','conversation','already','decode','base64','rate','quota','auth','timeout','inspection','length','missing','text','parameter','content','sequence','commit','update','exception'] as const;
export const CLASSROOM_VOICE_RECOVERY_STATES=['checking','configuration_verified','audio_verified','recovered','failed'] as const;
export const CLASSROOM_PROVIDER_ERROR_ACTIONS=['stopped','retained_idle','recovery_check'] as const;
const voiceRecoveryMetadataSchema=z.object({recoveryState:z.enum(CLASSROOM_VOICE_RECOVERY_STATES).optional(),providerErrorAction:z.enum(CLASSROOM_PROVIDER_ERROR_ACTIONS).optional()});
export type ClassroomVoiceRecoveryMetadata=z.infer<typeof voiceRecoveryMetadataSchema>;
export function sanitizeClassroomVoiceRecoveryMetadata(value:unknown):ClassroomVoiceRecoveryMetadata{
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 const result:Record<string,unknown>={};for(const[key,schema]of Object.entries(voiceRecoveryMetadataSchema.shape)){const parsed=schema.safeParse((value as Record<string,unknown>)[key]);if(parsed.success&&parsed.data!==undefined)result[key]=parsed.data;}return voiceRecoveryMetadataSchema.parse(result);
}
export const classroomProviderErrorDetailsSchema=z.object({
 providerErrorReason:z.enum(CLASSROOM_PROVIDER_ERROR_REASONS).optional(),
 providerErrorCodeKind:z.enum(['missing','null','string','number','boolean','object','array','other']).optional(),
 providerErrorCodeShape:z.enum(['empty','identifier','numeric','text','none']).optional(),
 providerErrorCodeFingerprint:z.string().regex(/^[0-9a-f]{16}$/).optional(),providerErrorMessageFingerprint:z.string().regex(/^[0-9a-f]{16}$/).optional(),
 providerErrorMessageCategories:z.array(z.enum(CLASSROOM_PROVIDER_ERROR_MESSAGE_CATEGORIES)).max(16).optional(),
 providerErrorType:z.enum(['invalid_request_error','server_error','authentication_error','permission_error','rate_limit_error','unknown']).optional(),
 providerErrorCode:z.enum(['invalid_value','authentication','quota','rate_limit','server','unknown']).optional(),
 providerErrorParam:z.enum(['response.cancel','response.create','session','audio','image','conversation.item','none','other']).optional(),
 requestCorrelation:z.enum(['matched','missing','unknown','unsent','scope_mismatch']).optional(),
 requestId:z.string().length(42).startsWith('tkreq_').refine(value=>identifier.safeParse(value.slice(6)).success).optional(),
 requestType:z.enum(['session.update','response.create','response.cancel','conversation.item.create','input_audio_buffer.append','input_audio_buffer.commit','input_audio_buffer.clear','input_image_buffer.append','unknown']).optional(),
});
export type ClassroomProviderErrorDetails=z.infer<typeof classroomProviderErrorDetailsSchema>;
/** One invalid label must not erase the other independently safe error facts. */
export function sanitizeClassroomProviderErrorDetails(value:unknown):ClassroomProviderErrorDetails{
 if(!value||typeof value!=='object'||Array.isArray(value))return {};
 const details:Record<string,unknown>={};
 for(const [key,schema]of Object.entries(classroomProviderErrorDetailsSchema.shape)){
  const raw=(value as Record<string,unknown>)[key];if(raw===undefined)continue;
  const parsed=schema.safeParse(raw);if(parsed.success)details[key]=parsed.data;
 }
 return classroomProviderErrorDetailsSchema.parse(details);
}
export const classroomJournalDetailsSchema=z.object({
 audioStats:audioContinuityStatsSchema.optional(),
 ...classroomPointJournalDetailsSchema.shape,
 ...classroomProviderErrorDetailsSchema.shape,
 measurementId:identifier.optional(),latencyInputId:identifier.optional(),latencyStage:z.enum(CLASSROOM_LATENCY_STAGES).optional(),latencyBasis:z.enum(CLASSROOM_LATENCY_BASES).optional(),waitMs:count.max(120000).optional(),playbackMs:count.max(120000).optional(),captureGapMs:count.max(10000).optional(),
 turnId:identifier.optional(),spanId:identifier.optional(),phase:z.enum(CLASSROOM_DIAGNOSTIC_PHASES).optional(),clock:z.enum(['server','client']).optional(),elapsedMs:count.max(86400000).optional(),queueMs:count.max(12000).optional(),rttMs:count.max(60000).optional(),
 source:z.enum(['speech','typed','model','application','provider','client','camera','board']).optional(),
 boundary:z.enum(['provider_final','application_segment']).optional(),playback:z.literal('generated').optional(),
 objectIds:z.array(z.string().max(100)).max(5).optional(),highlighted:z.array(z.string().max(100)).max(5).optional(),
 contextKey:z.string().max(1000).optional(),question:z.string().max(500).optional(),answer:detailText.optional(),message:detailText.optional(),
 resultStatus:z.string().max(60).optional(),errorCode:z.string().max(80).optional(),action:z.string().max(80).optional(),
 strokeCount:count.max(1000).optional(),pointCount:count.max(600).optional(),generation:count.max(2_000_000_000).optional(),durationMs:count.max(86_400_000).optional(),
 feedbackKind:z.string().max(60).optional(),endReason:z.string().max(80).optional(),effectiveTool:z.string().max(80).optional(),state:z.string().max(80).optional(),
});
export type ClassroomJournalDetails=z.infer<typeof classroomJournalDetailsSchema>;
const entrySchema=z.object({
 eventKey:z.string().min(1).max(200),kind:classroomJournalKindSchema,actor:classroomJournalActorSchema,status:classroomJournalStatusSchema,
 name:z.string().min(1).max(80).regex(/^[A-Za-z0-9_.:-]+$/),text:z.string().optional(),correlationId:z.string().max(200).optional(),details:z.record(z.unknown()).optional(),
});
export type ClassroomJournalEntry=Omit<z.infer<typeof entrySchema>,'details'>&{details?:ClassroomJournalDetails};
export type ClassroomJournalScope={classroomId:string;epoch:number;revision:number;stepIndex:number};

/** Treat text and selected tool fields as untrusted; never persist opaque provider payloads. */
export function sanitizeClassroomJournalText(value:string,limit=6000):string{
 return value.slice(0,16000)
  .replace(/data:[^\s;,]+(?:;[^\s,]*)?,[^\s]+/gi,'[已隐藏]')
  .replace(/\bpostgres(?:ql)?:\/\/[^\s]+/gi,'[已隐藏]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,'Bearer [已隐藏]')
  .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{8,}/gi,'[已隐藏]')
  .replace(/((?:api[_ -]?key|auth[_ -]?secret|access[_ -]?token|secret|password|密码|密钥)["']?\s*(?:is|是|为|[:=：])?\s*)(?:"[^"]*"|'[^']*'|[^\s"',;，。]+)/gi,'$1[已隐藏]')
  .replace(/[A-Za-z0-9+/_=-]{120,}/g,'[已隐藏]')
  .slice(0,limit);
}
export function sanitizeClassroomJournalEntry(value:unknown):ClassroomJournalEntry{
 const entry=entrySchema.parse(value),details:Record<string,unknown>={};
 const providerFailure=entry.name==='voice_provider_failure'||Object.keys(classroomProviderErrorDetailsSchema.shape).some(key=>entry.details?.[key]!==undefined);
 for(const [key,schema] of Object.entries(classroomJournalDetailsSchema.shape)){
  if(providerFailure&&key==='message')continue;
  const raw=entry.details?.[key];if(raw===undefined)continue;
  if(entry.name==='voice_request_recovery'&&key==='state'&&!(CLASSROOM_VOICE_RECOVERY_STATES as readonly unknown[]).includes(raw))continue;
  if(entry.name==='voice_provider_failure'&&key==='action'&&!(CLASSROOM_PROVIDER_ERROR_ACTIONS as readonly unknown[]).includes(raw))continue;
  const field=typeof raw==='string'?sanitizeClassroomJournalText(raw,1000):Array.isArray(raw)?raw.map(item=>typeof item==='string'?sanitizeClassroomJournalText(item,100):item):raw;
  const parsed=schema.safeParse(field);if(parsed.success)details[key]=parsed.data;
 }
 const {text,correlationId,...base}=entry;
 return {...base,eventKey:sanitizeClassroomJournalText(entry.eventKey,200),name:sanitizeClassroomJournalText(entry.name,80),...(!providerFailure&&text!==undefined?{text:sanitizeClassroomJournalText(text)}:{}),...(!providerFailure&&correlationId!==undefined?{correlationId:sanitizeClassroomJournalText(correlationId,200)}:{}),details:classroomJournalDetailsSchema.parse(details)};
}

const calendarDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{const parsed=new Date(`${value}T00:00:00Z`);return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;});
export const classroomJournalListQuerySchema=z.object({query:z.string().trim().max(100).default(''),from:calendarDate.optional(),to:calendarDate.optional(),page:z.coerce.number().int().min(0).max(100000).default(0),pageSize:z.coerce.number().int().min(1).max(50).default(20)}).strict().refine(value=>!value.from||!value.to||value.from<=value.to,'日期范围无效');
const decimal=/^(?:0|[1-9]\d{0,18})$/;
const cursor=z.string().regex(decimal).refine(value=>decimal.test(value)&&BigInt(value)<=BigInt('9223372036854775807'));
export const classroomJournalEventsQuerySchema=z.object({after:cursor.optional(),limit:z.coerce.number().int().min(1).max(100).default(100)}).strict();
export type ClassroomJournalListQuery=z.infer<typeof classroomJournalListQuerySchema>;
export type ClassroomJournalEventsQuery=z.infer<typeof classroomJournalEventsQuerySchema>;
export const classroomJournalClassroomSchema=z.object({id:identifier,accountId:identifier,email:z.string().max(320),childName:z.string().max(100),courseTitle:z.string().max(200),provider:z.enum(['qwen','openai','grok']),status:z.enum(['preflight','active','paused','ended']),startedAt:date,endedAt:date.nullable(),elapsedSeconds:count,agentName:z.string().max(100).nullable(),agentVersion:count.nullable(),model:z.string().max(100).nullable(),eventCount:count});
export type ClassroomJournalClassroom=z.infer<typeof classroomJournalClassroomSchema>;
export const classroomJournalEventSchema=z.object({id:cursor,createdAt:date,epoch:count,revision:count,stepIndex:count,kind:classroomJournalKindSchema,actor:classroomJournalActorSchema,status:classroomJournalStatusSchema,name:z.string().max(80),text:z.string().max(6000).nullable(),correlationId:z.string().max(200).nullable(),details:classroomJournalDetailsSchema});
export type ClassroomJournalEvent=z.infer<typeof classroomJournalEventSchema>;
export const classroomJournalListResponseSchema=z.object({ok:z.literal(true),classrooms:z.array(classroomJournalClassroomSchema).max(50),total:count,page:count,pageSize:count.max(50)});
export const classroomJournalEventsResponseSchema=z.object({ok:z.literal(true),classroom:classroomJournalClassroomSchema,events:z.array(classroomJournalEventSchema).max(100),nextCursor:cursor.nullable(),coverage:z.enum(['journal','legacy_transcripts','none'])});
export type ClassroomJournalList=Omit<z.infer<typeof classroomJournalListResponseSchema>,'ok'>;
export type ClassroomJournalEvents=Omit<z.infer<typeof classroomJournalEventsResponseSchema>,'ok'>;
