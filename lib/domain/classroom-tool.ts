import { z } from 'zod';
import { captureClassroomState, classroomTaskContextSchema, validateClassroomContext, type ClassroomContextRejectionReason } from './classroom-context';

const identifier = (max: number) => z.string().min(1).max(max).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const contextKey = identifier(1000);
const objectIds = z.array(identifier(100)).min(1).max(5).readonly();
const learnerText = z.string().min(1).max(500).refine(value => value.trim().length > 0);
const commandSchema = z.union([
  z.object({ name: z.literal('highlight_objects'), arguments: z.object({ contextKey, objectIds }).strict().readonly() }).strict().readonly(),
  z.object({ name: z.literal('submit_spoken_answer'), arguments: z.object({ contextKey, answer: learnerText }).strict().readonly() }).strict().readonly(),
  z.object({ name: z.literal('inspect_current_page'), arguments: z.object({ contextKey, question: learnerText }).strict().readonly() }).strict().readonly(),
  z.object({name:z.literal('review_lesson_notes'),arguments:z.object({contextKey}).strict().readonly()}).strict().readonly(),
  z.object({name:z.literal('chalk_write'),arguments:z.object({contextKey,text:z.string().min(1).max(120).refine(value=>value.trim().length>0&&!/[\u0000-\u001f\u007f]/u.test(value)),seconds:z.number().int().min(2).max(20)}).strict().readonly()}).strict().readonly(),
]);
const outputSchema = z.object({
  status: z.enum(['confirmed', 'retry', 'conversation', 'reference', 'unavailable']),
  english: z.string().max(6000).optional(), highlighted: objectIds.optional(),
}).strict().refine(output => !output.highlighted || output.status === 'confirmed').readonly();
const requestFields={type:z.literal('tool.requested'),id:z.string().uuid(),receivedAtMs:z.number().int().nonnegative().safe(),callId:identifier(300),context:classroomTaskContextSchema};
const requestSchema=z.union([
 z.object({...requestFields,source:z.enum(['teacher','application']),command:commandSchema}).strict().readonly(),
 z.object({...requestFields,source:z.literal('application'),command:z.object({name:z.literal('delegate'),arguments:z.object({contextKey,evidenceItemId:identifier(200)}).strict().readonly()}).strict().readonly()}).strict().readonly(),
 z.object({...requestFields,source:z.literal('application'),command:z.object({name:z.literal('chalk_write'),arguments:z.object({contextKey,evidenceItemId:identifier(200),text:z.string().min(1).max(120).refine(value=>value.trim().length>0&&!/[\u0000-\u001f\u007f]/u.test(value)),seconds:z.literal(8)}).strict().readonly()}).strict().readonly()}).strict().readonly(),
]);
const resultSchema = z.object({
  type: z.literal('tool.result'), requestId: z.string().uuid(), callId: identifier(300), context: classroomTaskContextSchema,
  phase: z.literal('application'), output: outputSchema,
}).strict().readonly();

const advanceSchema=z.object({type:z.literal('tool.advance'),requestId:z.string().uuid(),callId:identifier(300),before:classroomTaskContextSchema,after:classroomTaskContextSchema}).strict().readonly();
export type ClassroomToolAdvance=z.infer<typeof advanceSchema>;

export type ClassroomToolCommand = z.infer<typeof commandSchema>;
export type ClassroomToolName = ClassroomToolCommand['name'];
export type ClassroomToolOutput = z.infer<typeof outputSchema>;
export type ClassroomToolRequest = z.infer<typeof requestSchema>;
export type ClassroomToolResult = z.infer<typeof resultSchema>;
type ScopeRejection = Exclude<ClassroomContextRejectionReason, 'invalid_context'>;

export function parseClassroomToolCommand(input: unknown):
  | { ok: true; command: ClassroomToolCommand }
  | { ok: false; reason: 'invalid_command' } {
  const parsed = commandSchema.safeParse(input);
  return parsed.success ? { ok: true, command: parsed.data } : { ok: false, reason: 'invalid_command' };
}

export function parseClassroomToolOutput(input: unknown):
  | { ok: true; output: ClassroomToolOutput }
  | { ok: false; reason: 'invalid_output' } {
  const parsed = outputSchema.safeParse(input);
  return parsed.success ? { ok: true, output: parsed.data } : { ok: false, reason: 'invalid_output' };
}

/** Provenance and permission belong to the authenticated boundary, never the envelope itself. */
export function validateClassroomToolRequest(current: unknown, input: unknown):
  | { accepted: true; request: ClassroomToolRequest }
  | { accepted: false; reason: ScopeRejection | 'invalid_request' } {
  const captured = captureClassroomState(current);
  if (!captured.ok) return { accepted: false, reason: 'invalid_state' };
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { accepted: false, reason: 'invalid_request' };
  const scope = validateClassroomContext(captured.snapshot, parsed.data.context);
  if (!scope.accepted) return { accepted: false, reason: scope.reason === 'invalid_context' ? 'invalid_request' : scope.reason };
  return { accepted: true, request: parsed.data };
}

/** Compare the committed result snapshot, not the request's pre-effect revision. No playback proof. */
export function validateClassroomToolResult(current: unknown, input: unknown, request: unknown, execution?:unknown):
  | { accepted: true; result: ClassroomToolResult }
  | { accepted: false; reason: ScopeRejection | 'invalid_result' | 'invalid_request' | 'request_mismatch' } {
  const captured = captureClassroomState(current);
  if (!captured.ok) return { accepted: false, reason: 'invalid_state' };
  const parsed = resultSchema.safeParse(input);
  if (!parsed.success) return { accepted: false, reason: 'invalid_result' };
  const original = requestSchema.safeParse(request);
  if (!original.success) return { accepted: false, reason: 'invalid_request' };
  const scope = validateClassroomContext(captured.snapshot, parsed.data.context);
  if (!scope.accepted) return { accepted: false, reason: scope.reason === 'invalid_context' ? 'invalid_result' : scope.reason };
  const unchanged = ['logicalSessionId', 'courseVersion', 'connectionEpoch', 'pageId', 'activityId'] as const;
  if(parsed.data.requestId!==original.data.id||parsed.data.callId!==original.data.callId||parsed.data.context.stateRevision<original.data.context.stateRevision)return {accepted:false,reason:'request_mismatch'};
  if(unchanged.some(key=>parsed.data.context[key]!==original.data.context[key])){
    const advance=advanceSchema.safeParse(execution),keys=[...unchanged,'stateRevision'] as const,identity=['logicalSessionId','courseVersion','connectionEpoch'] as const;
    // Only the trusted application transaction may issue this receipt, never a model or browser payload.
    if(!['submit_spoken_answer','delegate'].includes(original.data.command.name)||parsed.data.output.status!=='confirmed'||!advance.success||advance.data.requestId!==original.data.id||advance.data.callId!==original.data.callId||
      keys.some(key=>advance.data.before[key]!==original.data.context[key]||advance.data.after[key]!==parsed.data.context[key])||
      identity.some(key=>advance.data.before[key]!==advance.data.after[key])||
      advance.data.after.stateRevision<=advance.data.before.stateRevision||advance.data.after.activityId===advance.data.before.activityId)return {accepted:false,reason:'request_mismatch'};
  }
  return { accepted: true, result: parsed.data };
}

type ToolDefinition = { type: 'function'; name: ClassroomToolName; description: string; parameters: Record<string, unknown> };
const common = { contextKey: { type: 'string', description: 'Exact current contextKey from application state' } };
// Preserve the existing provider-facing JSON; the application contract adds bounded validation.
export const CLASSROOM_TOOL_DEFINITIONS: ToolDefinition[] = [
  { type: 'function', name: 'highlight_objects', description: 'Visibly highlight known textbook objects when asked to circle, click, tap, point to, show or select them, or when teaching the current task. This is teacher help, never a learner answer or progress. Wait for confirmed result before claiming success.', parameters: { type: 'object', properties: { ...common, objectIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 } }, required: ['contextKey','objectIds'], additionalProperties: false } },
  { type: 'function', name: 'submit_spoken_answer', description: 'Check the learner completed spoken answer for the current speaking exercise. Do not check partial speech or silently pass an exercise.', parameters: { type: 'object', properties: { ...common, answer: { type: 'string', maxLength: 500 } }, required: ['contextKey','answer'], additionalProperties: false } },
  { type: 'function', name: 'inspect_current_page', description: 'Ask the application to inspect unknown freehand marks on the current page. Use only a current committed native textbook image or current visual observation. If neither is available, ask for clarification; do not claim to have inspected buffered or old images.', parameters: { type: 'object', properties: { ...common, question: { type: 'string', maxLength: 500 } }, required: ['contextKey','question'], additionalProperties: false } },
];

// Additional teaching tools belong to the authenticated classroom owner; legacy bridges keep three tools.
export const CLASSROOM_TEACHING_TOOL_DEFINITIONS:ToolDefinition[]=[...CLASSROOM_TOOL_DEFINITIONS,
 {type:'function',name:'chalk_write',description:'Only when the learner still needs help after you have first rephrased aloud, briefly write one useful keyword or sentence. Plain text, 2–20 seconds. Wait for a displayed result before saying it is visible. Never treat writing or optional repetition as an answer, grade or obligation.',parameters:{type:'object',properties:{...common,text:{type:'string',minLength:1,maxLength:120},seconds:{type:'integer',minimum:2,maximum:20}},required:['contextKey','text','seconds'],additionalProperties:false}},
 {type:'function',name:'review_lesson_notes',description:'Only after the learner explicitly asks to review this lesson, read up to three saved source expression pairs. Wait for the application reference, accept that it may be empty or incomplete. Invite one optional comparison or own expression; never infer mastery, demand repetition, skip, advance or end the lesson from this read.',parameters:{type:'object',properties:{...common},required:['contextKey'],additionalProperties:false}},
];
