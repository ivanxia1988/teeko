import type {ClassroomSnapshot, PublishedCourse} from '../classroom-contract';

const WINGS = 'wings';
const HIGHLIGHT_TOOL_NAME = 'highlight_objects';
const RESPONSE_DEADLINE_MS = 8_000;
const MAX_DELEGATIONS = 128;
const MAX_CALLS_PER_RESPONSE = 4;

export const LIVE_ROBOT_HIGHLIGHT_TOOL = {
  type: 'function',
  name: HIGHLIGHT_TOOL_NAME,
  description: 'Highlight the known wings on the current robot textbook picture for a teacher demonstration. Use before explaining the wings. Wait for a confirmed result before saying they are marked.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {objectId: {type: 'string', enum: [WINGS]}},
    required: ['objectId'],
    additionalProperties: false,
  },
} as const;

export function canHighlightRobotWings(course: PublishedCourse, stepIndex: number): boolean {
  if (course.id !== 'topic-robot' || course.version !== '1') return false;
  const step = course.steps[stepIndex];
  if (!step || step.pageId !== 'robot-predict' || !['robot-welcome', 'robot-clues'].includes(step.id)) return false;
  return course.pages.some(page => page.id === step.pageId && page.objects.some(object => object.id === WINGS));
}

export function liveHighlightTarget(snapshot: ClassroomSnapshot): typeof WINGS | null {
  if (snapshot.status !== 'active' || snapshot.preferences.provider !== 'openai') return null;
  return canHighlightRobotWings(snapshot.course, snapshot.stepIndex) ? WINGS : null;
}

export function buildLiveHighlightResponsesInstructions(snapshot: Pick<ClassroomSnapshot, 'course' | 'stepIndex' | 'teacherObjectIds'>): string {
  if (!canHighlightRobotWings(snapshot.course, snapshot.stepIndex)) {
    return 'Help the live teacher answer the current learner briefly. The wings demonstration is unavailable in this activity. Do not call the highlight function or claim an object is marked.';
  }
  const explanation = 'The long parts on both sides are its wings. Wings help the robot move through the air.';
  const action = snapshot.teacherObjectIds.includes(WINGS)
    ? 'The wings are already marked in this activity. Keep that mark and do not call the function again.'
    : 'For the planned opening demonstration, your first output must be one call to highlight_objects with objectId wings, even if the learner is silent. Do not write a preamble or describe the planned action. Wait for the application result and never call the function a second time in this demonstration.';
  return `You support the live English teacher in the current robot activity. ${action} Then give a short explanation the voice teacher can say in simple English: ${explanation} Offer at most one simple optional question. Refer to a visible mark only after a confirmed result. If the mark is unavailable, explain the wings without claiming a mark. Never expose tools or internal steps to the learner. For unrelated speech, help the teacher answer naturally without calling the function.`;
}

export function liveHighlightDelegation(model: string, snapshot: ClassroomSnapshot) {
  return {
    type: 'responses',
    responses: {
      model,
      tools: [LIVE_ROBOT_HIGHLIGHT_TOOL],
      instructions: buildLiveHighlightResponsesInstructions(snapshot),
      tool_choice: 'auto',
      parallel_tool_calls: false,
    },
  } as const;
}

type Event = Record<string, unknown>;
type ExecutionGuard = () => boolean;
type Options = {
  current: () => ClassroomSnapshot | null;
  execute: (scope: ClassroomSnapshot, callId: string, objectId: typeof WINGS, isCurrent: ExecutionGuard) => Promise<boolean>;
  send: (event: Event) => boolean;
  eventId: () => string;
};
type Delegation = {
  id: string;
  responseId: string | null;
  snapshot: ClassroomSnapshot;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  opened: boolean;
  terminal: boolean;
  continued: boolean;
  attempted: boolean;
  pending: number;
  calls: Set<string>;
  previousCalls: Set<string>;
};

const asRecord = (value: unknown): Event | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Event : undefined;
const protocolId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value);

function wantsWings(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 150) return false;
  try {
    const args = asRecord(JSON.parse(value));
    return args?.objectId === WINGS && Object.keys(args).length === 1;
  } catch { return false; }
}

/** The voice model requests a delegation. Only the matching Responses result may request a classroom mark. */
export class LiveHighlightResponses {
  private active: Delegation | undefined;
  private readonly seen = new Set<string>();
  private closed = false;

  constructor(private readonly options: Options) {}

  invalidate() {
    if (this.active) clearTimeout(this.active.timer);
    this.active = undefined;
  }

  close() {
    this.closed = true;
    this.invalidate();
    this.seen.clear();
  }

  private stillCurrent(active: Delegation): boolean {
    if (this.active !== active || performance.now() > active.deadline) return false;
    const current = this.options.current();
    if (!current || !liveHighlightTarget(current)) return false;
    const original = active.snapshot;
    return current.id === original.id && current.connectionEpoch === original.connectionEpoch &&
      current.course.version === original.course.version && current.stepIndex === original.stepIndex;
  }

  private start(event: Event, delegation: Event) {
    const id = delegation.id;
    if (!protocolId(id) || this.seen.has(id) || this.seen.size >= MAX_DELEGATIONS) return;
    this.seen.add(id);
    this.invalidate();

    const snapshot = this.options.current();
    if (!snapshot || !liveHighlightTarget(snapshot)) return;
    const responseId = delegation.response_id ?? event.response_id;
    if (responseId !== undefined && !protocolId(responseId)) return;
    const deadline = performance.now() + RESPONSE_DEADLINE_MS;
    const timer = setTimeout(() => this.invalidate(), RESPONSE_DEADLINE_MS);
    timer.unref();
    this.active = {
      id, responseId: responseId ?? null, snapshot, deadline, timer,
      opened: false, terminal: false, continued: false, attempted: false, pending: 0,
      calls: new Set(), previousCalls: new Set(),
    };
  }

  private send(event: Event) {
    try { return this.options.send({...event, event_id: this.options.eventId()}); }
    catch { return false; }
  }

  private continue(active: Delegation) {
    if (!this.stillCurrent(active) || !active.terminal || active.pending || active.continued) return;
    if (!active.calls.size) {
      this.invalidate();
      return;
    }
    active.continued = true;
    if (!this.send({type: 'response.create'})) this.invalidate();
  }

  private async handleCall(active: Delegation, item: Event) {
    const callId = item.call_id;
    if (!protocolId(callId) || active.calls.has(callId) || active.previousCalls.has(callId)) return;
    if (active.calls.size >= MAX_CALLS_PER_RESPONSE) {
      this.invalidate();
      return;
    }
    active.calls.add(callId);
    active.pending++;

    let confirmed = false;
    if (!active.attempted && item.name === HIGHLIGHT_TOOL_NAME && wantsWings(item.arguments)) {
      active.attempted = true;
      try {
        confirmed = await this.options.execute(active.snapshot, callId, WINGS, () => this.stillCurrent(active));
      } catch { /* A classroom failure returns a bounded unavailable result. */ }
    }
    active.pending--;
    if (!this.stillCurrent(active)) return;
    const output = confirmed ? {status: 'confirmed', highlighted: [WINGS]} : {status: 'unavailable'};
    if (!this.send({type: 'response.item.create', item: {type: 'function_call_output', call_id: callId, output: JSON.stringify(output)}})) {
      this.invalidate();
      return;
    }
    this.continue(active);
  }

  handle(event: Event): boolean {
    if (event.type === 'session.delegation.created') {
      const delegation = asRecord(event.delegation);
      if (delegation?.target !== 'responses') return false;
      if (!this.closed) this.start(event, delegation);
      return true;
    }
    if (event.type !== 'response.event') return false;
    const active = this.active;
    if (!active || event.delegation_id !== active.id || !this.stillCurrent(active)) return true;
    const nested = asRecord(event.event);
    if (!nested) return true;
    const id = asRecord(nested.response)?.id ?? nested.response_id;

    if (nested.type === 'response.created') {
      if (!protocolId(id)) return true;
      if (active.opened) {
        if (!active.continued || id === active.responseId) return true;
        // Allow one model continuation. A continued answer may acknowledge the mark but should not invoke it again.
        if (active.previousCalls.size) {this.invalidate(); return true;}
        active.previousCalls = active.calls;
        active.calls = new Set();
        active.terminal = false;
        active.continued = false;
      } else if (active.responseId && id !== active.responseId) return true;
      active.responseId = id;
      active.opened = true;
      return true;
    }
    if (!active.opened || (id !== undefined && id !== active.responseId)) return true;
    if (nested.type === 'response.output_item.done' && !active.terminal) {
      const item = asRecord(nested.item);
      if (item?.type === 'function_call' && (item.status === undefined || item.status === 'completed')) void this.handleCall(active, item);
    } else if (nested.type === 'response.completed') {
      active.terminal = true;
      this.continue(active);
    } else if (['response.failed', 'response.incomplete', 'response.cancelled'].includes(String(nested.type))) {
      this.invalidate();
    }
    return true;
  }
}
