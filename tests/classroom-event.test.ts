import test from 'node:test';
import assert from 'node:assert/strict';
import { captureClassroomState } from '../lib/domain/classroom-context.ts';
import { parseClassroomEvent as parse, validateClassroomEvent as validate } from '../lib/domain/classroom-event.ts';
const context = () => ({ logicalSessionId: 'classroom-1', courseVersion: 'picnic:2', connectionEpoch: 2, stateRevision: 10, pageId: 'page-1', activityId: 'find-apple' });
const state = () => ({ status: 'active', context: context() });
const base = () => ({ id: '0b688a4c-1272-4e71-afb1-8a9d986c55d6', receivedAtMs: 1_794_000_000_000, context: context() });
const speech = () => ({ ...base(), type: 'transcript.final', source: 'voice', payload: { role: 'child', input: 'speech', itemId: 'utterance-1', text: 'I like apples.', boundary: 'provider_final' } });
const typed = () => ({ ...base(), type: 'transcript.final', source: 'action', payload: { role: 'child', input: 'typed', itemId: 'typed-1', text: 'I like apples.' } });
const selection = () => ({ ...base(), type: 'selection.committed', source: 'interaction', payload: { objectIds: ['apple'] } });
const annotation = () => ({ ...base(), type: 'annotation.changed', source: 'action', payload: { action: 'draw', strokeCount: 1, pointCount: 30 } });
const visual = () => ({ ...base(), type: 'visual.state', source: 'vision', payload: { target: 'camera', status: 'sharing', generation: 1 } });
const invalid = { ok: false, reason: 'invalid_event' };

for (const [name, fixture] of [['speech', speech], ['typed text', typed], ['selection', selection], ['pen summary', annotation], ['visual state', visual]] as const) {
  test(`parses a bounded ${name} event without changing it`, () => {
    const input = fixture(), copy = structuredClone(input);
    assert.deepEqual(parse(input), { ok: true, event: copy });
    assert.deepEqual(input, copy);
    assert.deepEqual(validate(state(), input), { accepted: true, event: copy });
  });
}

test('keeps provider-final, application-segment and typed input distinct', () => {
  for (const boundary of ['provider_final', 'application_segment']) {
    const event = { ...speech(), payload: { ...speech().payload, role: 'teacher', boundary } };
    assert.deepEqual(parse(event), { ok: true, event });
  }
  const withoutBoundary: Record<string, unknown> = { ...speech().payload };
  delete withoutBoundary.boundary;
  assert.deepEqual(parse({ ...speech(), payload: withoutBoundary }), invalid);
  assert.deepEqual(parse({ ...typed(), payload: { ...typed().payload, boundary: 'provider_final' } }), invalid);
  assert.deepEqual(parse({ ...typed(), payload: { ...typed().payload, role: 'teacher' } }), invalid);
  assert.deepEqual(parse({ ...speech(), payload: { ...speech().payload, boundary: 'official_final' } }), invalid);
});

test('rejects wrong source and payload combinations', () => {
  for (const fixture of [speech, typed, selection, annotation, visual]) {
    const event = fixture();
    for (const source of ['voice', 'action', 'interaction', 'vision', 'provider']) {
      if (source !== event.source) assert.deepEqual(parse({ ...event, source }), invalid);
    }
    const other = event.type === 'visual.state' ? selection() : visual();
    assert.deepEqual(parse({ ...event, payload: other.payload }), invalid);
  }
});

test('rejects unknown event types, incomplete envelopes and malformed values', () => {
  for (const input of [null, undefined, [], '', 1, {}, { ...speech(), type: 'cheer' }]) assert.deepEqual(parse(input), invalid);
  for (const key of Object.keys(speech())) {
    const input: Record<string, unknown> = speech();
    delete input[key];
    assert.deepEqual(parse(input), invalid);
  }
  for (const key of Object.keys(speech().payload)) {
    const payload: Record<string, unknown> = speech().payload;
    delete payload[key];
    assert.deepEqual(parse({ ...speech(), payload }), invalid);
  }
});

test('bounds event identifiers and server receipt time without coercion', () => {
  for (const id of ['', 'x'.repeat(129), 'not-a-uuid', 1]) assert.deepEqual(parse({ ...speech(), id }), invalid);
  for (const receivedAtMs of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null]) {
    assert.deepEqual(parse({ ...speech(), receivedAtMs }), invalid);
  }
  for (const receivedAtMs of [0, Number.MAX_SAFE_INTEGER]) assert.equal(parse({ ...speech(), receivedAtMs }).ok, true);
});

test('bounds final text and evidence identifiers without trimming the original text', () => {
  for (const text of ['', '   ', '\n\t', 'x'.repeat(6001), 1]) {
    assert.deepEqual(parse({ ...speech(), payload: { ...speech().payload, text } }), invalid);
    assert.deepEqual(parse({ ...typed(), payload: { ...typed().payload, text } }), invalid);
  }
  for (const itemId of ['', ' id', 'id\n', 'x'.repeat(201), 1]) assert.deepEqual(parse({ ...speech(), payload: { ...speech().payload, itemId } }), invalid);
  for (const text of [' I like apples. ', 'x'.repeat(6000)]) {
    const event = { ...speech(), payload: { ...speech().payload, text, itemId: 'x'.repeat(200) } };
    assert.deepEqual(parse(event), { ok: true, event });
  }
});

test('bounds selected objects without inventing an assessment or target lookup', () => {
  for (const objectIds of [[], Array.from({ length: 6 }, () => 'apple'), ['x'.repeat(101)], [''], [' apple'], ['apple\n'], [1], 'apple']) {
    assert.deepEqual(parse({ ...selection(), payload: { objectIds } }), invalid);
  }
  assert.equal(parse({ ...selection(), payload: { objectIds: Array.from({ length: 5 }, (_, index) => `${index}${'x'.repeat(99)}`) } }).ok, true);
  // Existence and correctness still belong to the authenticated application transaction.
  assert.equal(validate(state(), { ...selection(), payload: { objectIds: ['unknown-object'] } }).accepted, true);
});

test('pen summaries allow draw and undo while bounding counts', () => {
  for (const action of ['draw', 'undo']) assert.equal(parse({ ...annotation(), payload: { action, strokeCount: 0, pointCount: 0 } }).ok, true);
  assert.equal(parse({ ...annotation(), payload: { action: 'draw', strokeCount: 1000, pointCount: 600 } }).ok, true);
  for (const [field, values] of [['strokeCount', [-1, 0.5, 1001, '1', NaN, Infinity]], ['pointCount', [-1, 0.5, 601, '1', NaN, Infinity]]] as const) {
    for (const value of values) assert.deepEqual(parse({ ...annotation(), payload: { ...annotation().payload, [field]: value } }), invalid);
  }
  assert.deepEqual(parse({ ...annotation(), payload: { ...annotation().payload, action: 'clear' } }), invalid);
});

test('visual events contain only current status metadata for camera or board', () => {
  for (const target of ['camera', 'board']) {
    for (const status of ['off', 'starting', 'sharing', 'error', 'unavailable']) {
      assert.equal(parse({ ...visual(), payload: { target, status, generation: 0 } }).ok, true);
    }
  }
  for (const generation of [-1, 0.5, 2_000_000_001, '1', NaN, Infinity]) assert.deepEqual(parse({ ...visual(), payload: { ...visual().payload, generation } }), invalid);
  assert.equal(parse({ ...visual(), payload: { ...visual().payload, generation: 2_000_000_000 } }).ok, true);
  assert.deepEqual(parse({ ...visual(), payload: { ...visual().payload, target: 'desktop' } }), invalid);
  assert.deepEqual(parse({ ...visual(), payload: { ...visual().payload, status: 'understood' } }), invalid);
});

test('rejects extra authority, media and hidden-data fields at every event boundary', () => {
  for (const fixture of [speech, typed, selection, annotation, visual]) {
    for (const name of ['correct', 'score', 'ended', 'priority', 'image', 'audio', 'points', 'description', 'instructions', 'apiKey']) {
      const extra = { [name]: 'not-permitted' }, event = fixture();
      for (const input of [{ ...event, ...extra }, { ...event, context: { ...context(), ...extra } }, { ...event, payload: { ...event.payload, ...extra } }]) {
        assert.deepEqual(parse(input), invalid);
      }
    }
  }
});

test('requires the shared complete and bounded task context', () => {
  for (const field of Object.keys(context())) {
    const incomplete: Record<string, unknown> = context();
    delete incomplete[field];
    assert.deepEqual(parse({ ...speech(), context: incomplete }), invalid);
  }
  for (const field of ['logicalSessionId', 'courseVersion', 'pageId', 'activityId']) {
    for (const value of ['', ' id', 'id\n', 'x'.repeat(129)]) assert.deepEqual(parse({ ...speech(), context: { ...context(), [field]: value } }), invalid);
  }
  for (const field of ['connectionEpoch', 'stateRevision']) {
    for (const value of [-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) assert.deepEqual(parse({ ...speech(), context: { ...context(), [field]: value } }), invalid);
  }
});

for (const [field, value, reason] of [
  ['logicalSessionId', 'other', 'session_mismatch'], ['courseVersion', 'picnic:3', 'course_version_mismatch'],
  ['connectionEpoch', 3, 'connection_epoch_mismatch'], ['stateRevision', 9, 'stale_revision'],
  ['stateRevision', 11, 'future_revision'], ['pageId', 'other', 'page_mismatch'], ['activityId', 'other', 'activity_mismatch'],
] as const) {
  test(`rejects a well-formed event with ${reason}`, () => {
    const event = { ...speech(), context: { ...context(), [field]: value } };
    assert.equal(parse(event).ok, true);
    assert.deepEqual(validate(state(), event), { accepted: false, reason });
  });
}

test('checks current state then event format then active scope', () => {
  assert.deepEqual(validate(null, null), { accepted: false, reason: 'invalid_state' });
  assert.deepEqual(validate({ ...state(), status: 'ended' }, null), { accepted: false, reason: 'invalid_event' });
  for (const status of ['created', 'preflight', 'paused', 'ending', 'ended']) {
    assert.deepEqual(validate({ ...state(), status }, { ...speech(), context: { ...context(), logicalSessionId: 'other' } }), { accepted: false, reason: 'not_active' });
  }
});

test('pause/resume and reconnect invalidate old events even on the same task', () => {
  const event = speech();
  assert.deepEqual(validate({ ...state(), context: { ...context(), stateRevision: 12 } }, event), { accepted: false, reason: 'stale_revision' });
  assert.deepEqual(validate({ ...state(), context: { ...context(), stateRevision: 12, connectionEpoch: 3 } }, event), { accepted: false, reason: 'connection_epoch_mismatch' });
});

test('returns deeply frozen event copies and leaves the authority snapshot untouched', () => {
  const event = selection(), current = state(), before = structuredClone(current);
  const captured = captureClassroomState(current);
  assert(captured.ok);
  const result = validate(captured.snapshot, event);
  assert(result.accepted);
  const original = structuredClone(event);
  event.context.activityId = 'changed';
  event.payload.objectIds.push('banana');
  event.receivedAtMs++;
  assert.deepEqual(result.event, original);
  assert.deepEqual(current, before);
  assert(Object.isFrozen(result.event));
  assert(Object.isFrozen(result.event.context));
  assert(Object.isFrozen(result.event.payload));
  assert(result.event.type === 'selection.committed');
  const objectIds = result.event.payload.objectIds;
  assert(Object.isFrozen(objectIds));
  assert.throws(() => Object.assign(result.event.payload, { score: 100 }), TypeError);
  assert.throws(() => (objectIds as string[]).push('banana'), TypeError);
  for (const fixture of [speech, typed, annotation, visual]) {
    const parsed = parse(fixture());
    assert(parsed.ok);
    assert(Object.isFrozen(parsed.event.payload));
  }
});

test('format and context acceptance do not authorize execution or apply time policy', () => {
  const input = { ...speech(), receivedAtMs: 0 };
  assert.deepEqual(validate(state(), input), { accepted: true, event: input });
  assert.deepEqual(state(), { status: 'active', context: context() });
  // The authenticated boundary must assign source/time; this pure contract cannot attest provenance.
  assert.equal(parse({ ...speech(), payload: { ...speech().payload, role: 'teacher' } }).ok, true);
});
