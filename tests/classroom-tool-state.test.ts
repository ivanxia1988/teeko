import test from 'node:test';
import assert from 'node:assert/strict';
import { teacherSnapshot } from './teacher-runtime-fixture';

import * as adapter from '../lib/classroom-tool-state';
test('tool scope comes from the full authoritative snapshot, not the legacy key', () => {
  assert.ok(adapter, 'Classroom tool state adapter is not implemented');
  const input = teacherSnapshot();
  const capture = adapter.captureClassroomToolState(input);
  assert.deepEqual(capture, { ok: true, snapshot: { status: 'active', context: {
    logicalSessionId: input.id, courseVersion: 'picnic:2', connectionEpoch: 1, stateRevision: 1,
    pageId: 'picnic-table', activityId: 'say-apple',
  } } });
});
test('invalid task indexes and absent material do not produce invented scope identifiers', () => {
  assert.ok(adapter);
  for (const stepIndex of [-1, .5, 999, NaN]) assert.deepEqual(adapter.captureClassroomToolState(teacherSnapshot({ stepIndex })), { ok: false, reason: 'invalid_state' });
  const input = structuredClone(teacherSnapshot());input.course.pages = [];
  assert.deepEqual(adapter.captureClassroomToolState(input), { ok: false, reason: 'invalid_state' });
});
test('scope capture keeps pause/end state and is immutable after course mutation', () => {
  assert.ok(adapter);
  for (const status of ['preflight', 'paused', 'ended'] as const) {
    const capture = adapter.captureClassroomToolState(teacherSnapshot({ status }));assert(capture.ok);assert.equal(capture.snapshot.status, status);
  }
  const input = structuredClone(teacherSnapshot()), capture = adapter.captureClassroomToolState(input);assert(capture.ok);
  input.course.version = 'changed';input.course.steps[1].id = 'changed';input.revision++;
  assert.equal(capture.snapshot.context.activityId, 'say-apple');assert.equal(capture.snapshot.context.stateRevision, 1);
  assert(Object.isFrozen(capture.snapshot.context));
});
