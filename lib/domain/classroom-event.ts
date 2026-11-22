import { z } from 'zod';
import { captureClassroomState, classroomTaskContextSchema, validateClassroomContext, type ClassroomContextRejectionReason } from './classroom-context';

const identifier = (max: number) => z.string().min(1).max(max).refine(
  value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
  'Identifiers cannot have surrounding whitespace or control characters.',
);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(6000).refine(value => value.trim().length > 0);
const common = {
  id: z.string().uuid(),
  receivedAtMs: count,
  context: classroomTaskContextSchema,
};
const transcript = { itemId: identifier(200), text };

const eventSchema = z.union([
  z.object({
    ...common, type: z.literal('transcript.final'), source: z.literal('voice'),
    payload: z.object({
      ...transcript, role: z.enum(['child', 'teacher']), input: z.literal('speech'),
      boundary: z.enum(['provider_final', 'application_segment']),
    }).strict().readonly(),
  }).strict().readonly(),
  z.object({
    ...common, type: z.literal('transcript.final'), source: z.literal('action'),
    payload: z.object({ ...transcript, role: z.literal('child'), input: z.literal('typed') }).strict().readonly(),
  }).strict().readonly(),
  z.object({
    ...common, type: z.literal('selection.committed'), source: z.literal('interaction'),
    payload: z.object({ objectIds: z.array(identifier(100)).min(1).max(5).readonly() }).strict().readonly(),
  }).strict().readonly(),
  z.object({
    ...common, type: z.literal('annotation.changed'), source: z.literal('action'),
    payload: z.object({ action: z.enum(['draw', 'undo']), strokeCount: count.max(1000), pointCount: count.max(600) }).strict().readonly(),
  }).strict().readonly(),
  z.object({
    ...common, type: z.literal('visual.state'), source: z.literal('vision'),
    payload: z.object({
      target: z.enum(['camera', 'board']), status: z.enum(['off', 'starting', 'sharing', 'error', 'unavailable']),
      generation: count.max(2_000_000_000),
    }).strict().readonly(),
  }).strict().readonly(),
]);

export type ClassroomEvent = z.infer<typeof eventSchema>;
export type ClassroomEventParse =
  | { ok: true; event: ClassroomEvent }
  | { ok: false; reason: 'invalid_event' };
export type ClassroomEventRejectionReason = Exclude<ClassroomContextRejectionReason, 'invalid_context'> | 'invalid_event';
export type ClassroomEventValidation =
  | { accepted: true; event: ClassroomEvent }
  | { accepted: false; reason: ClassroomEventRejectionReason };

/** Format only: callers must establish provenance, receipt time and persistence policy separately. */
export function parseClassroomEvent(input: unknown): ClassroomEventParse {
  const parsed = eventSchema.safeParse(input);
  return parsed.success ? { ok: true, event: parsed.data } : { ok: false, reason: 'invalid_event' };
}

/** A scoped event is still untrusted data, never authorization, execution or learning evidence. */
export function validateClassroomEvent(current: unknown, input: unknown): ClassroomEventValidation {
  const captured = captureClassroomState(current);
  if (!captured.ok) return { accepted: false, reason: 'invalid_state' };
  const parsed = parseClassroomEvent(input);
  if (!parsed.ok) return { accepted: false, reason: 'invalid_event' };
  const scope = validateClassroomContext(captured.snapshot, parsed.event.context);
  if (!scope.accepted) return { accepted: false, reason: scope.reason === 'invalid_context' ? 'invalid_event' : scope.reason };
  return { accepted: true, event: parsed.event };
}
