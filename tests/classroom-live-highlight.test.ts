import test from 'node:test';
import assert from 'node:assert/strict';
import type {ClassroomSnapshot} from '../lib/classroom-contract';
import {TOPIC_ROBOT_COURSE, TOPIC_PICNIC_COURSE} from '../lib/server/topic-courses';
import {LiveHighlightResponses, liveHighlightDelegation, liveHighlightTarget} from '../lib/server/classroom-live-highlight';

const snapshot: ClassroomSnapshot = {
  id: '00000000-0000-4000-8000-000000000001', course: TOPIC_ROBOT_COURSE,
  profile: {name: 'Synthetic', ageRange: '10–11', level: 'starter'},
  preferences: {provider: 'openai', language: 'english', style: 'gentle', voice: 'female', soundEffects: false},
  status: 'active', revision: 1, connectionEpoch: 1, stepIndex: 0, elapsedSeconds: 0,
  remainingSeconds: 1200, maxSeconds: 1200, outcomes: [], teacherObjectIds: [], feedback: null,
  endReason: null, startedAt: new Date(0).toISOString(), endedAt: null, reportStatus: 'unavailable',
};
const delegation = (id = 'item_test', response = 'resp_test') => ({
  type: 'session.delegation.created', delegation: {id, target: 'responses', response_id: response},
});
const nested = (event: Record<string, unknown>, id = 'item_test') => ({type: 'response.event', delegation_id: id, event});
const created = (id = 'item_test', response = 'resp_test') => nested({type: 'response.created', response: {id: response}}, id);
const completed = (id = 'item_test', response = 'resp_test') => nested({type: 'response.completed', response: {id: response}}, id);
const call = (callId = 'call_wings', name = 'highlight_objects', args = '{"objectId":"wings"}', response = 'resp_test') => nested({
  type: 'response.output_item.done', response_id: response,
  item: {type: 'function_call', status: 'completed', name, call_id: callId, arguments: args},
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('GPT registers the strict Responses function and limits teaching to active first-page wings', () => {
  const settings = liveHighlightDelegation('test-backend', snapshot);
  assert.equal(settings.type, 'responses');
  assert.equal(settings.responses.model, 'test-backend');
  assert.equal(settings.responses.tool_choice, 'auto');
  assert.equal(settings.responses.parallel_tool_calls, false);
  assert.deepEqual(settings.responses.tools.map(tool => [tool.type, tool.name, tool.strict]), [['function', 'highlight_objects', true]]);
  assert.deepEqual(settings.responses.tools[0].parameters.properties.objectId.enum, ['wings']);
  assert.match(settings.responses.instructions, /first output must be one call/);
  assert.match(settings.responses.instructions, /wings.*move through the air/i);
  assert.equal(liveHighlightTarget(snapshot), 'wings');
  assert.equal(liveHighlightTarget({...snapshot, stepIndex: 1}), 'wings');
  for (const stale of [{...snapshot, stepIndex: 2}, {...snapshot, course: TOPIC_PICNIC_COURSE}, {...snapshot, status: 'paused'}] as const) {
    assert.equal(liveHighlightTarget(stale), null);
  }
});

function fixture(execute?: (allowed: () => boolean) => Promise<boolean>) {
  let state: ClassroomSnapshot | null = snapshot;
  let nextId = 0;
  const actions: [number, string, string][] = [];
  const sent: Record<string, unknown>[] = [];
  const bridge = new LiveHighlightResponses({
    current: () => state, send: event => {sent.push(event); return true;}, eventId: () => `event_${++nextId}`,
    execute: async (scope, callId, objectId, allowed) => {
      actions.push([scope.stepIndex, callId, objectId]);
      return execute ? execute(allowed) : allowed();
    },
  });
  return {bridge, actions, sent, setState: (value: ClassroomSnapshot | null) => {state = value;}};
}

test('only a completed matching call highlights once and sends its result before continuing', async () => {
  const {bridge, actions, sent} = fixture();
  try {
    assert.equal(bridge.handle({type: 'session.delegation.created', delegation: {id: 'other', target: 'client'}}), false);
    assert.equal(bridge.handle(delegation()), true);
    bridge.handle(created());
    bridge.handle(nested({type: 'response.function_call_arguments.done', call_id: 'call_wings', arguments: '{"objectId":"wings"}'}));
    bridge.handle(call('call_unrelated', 'highlight_objects', '{"objectId":"wings"}', 'resp_unrelated'));
    assert.deepEqual(actions, []);
    bridge.handle(call()); bridge.handle(call());
    await flush();
    assert.deepEqual(actions, [[0, 'call_wings', 'wings']]);
    assert.deepEqual(sent, [{type: 'response.item.create', event_id: 'event_1', item: {
      type: 'function_call_output', call_id: 'call_wings', output: '{"status":"confirmed","highlighted":["wings"]}',
    }}]);
    bridge.handle(completed()); bridge.handle(completed());
    assert.deepEqual(sent.map(event => event.type), ['response.item.create', 'response.create']);
    bridge.handle(created('item_test', 'resp_continued'));
    bridge.handle(completed('item_test', 'resp_continued'));
    assert.equal(sent.length, 2, 'The final teaching response does not start another continuation.');
  } finally { bridge.close(); }
});

test('invalid parameters receive a fixed denial and all same-response results precede continuation', async () => {
  let finish: ((value: boolean) => void) | undefined;
  const {bridge, actions, sent} = fixture(() => new Promise(resolve => {finish = resolve;}));
  try {
    bridge.handle(delegation()); bridge.handle(created());
    bridge.handle(call()); bridge.handle(call('call_invalid', 'highlight_objects', '{"objectId":"tail","contextKey":"wrong"}'));
    bridge.handle(completed());
    assert.deepEqual(actions, [[0, 'call_wings', 'wings']]);
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(sent[0]), /call_invalid.*unavailable/);
    finish?.(true);
    await flush();
    assert.deepEqual(sent.map(event => event.type), ['response.item.create', 'response.item.create', 'response.create']);
  } finally { bridge.close(); }
});

test('a page change or learner interruption voids in-flight application authorization and suppresses continuation', async () => {
  for (const interrupt of [false, true]) {
    let finish: (() => void) | undefined;
    const {bridge, sent, setState} = fixture(allowed => new Promise(resolve => {finish = () => resolve(allowed());}));
    try {
      bridge.handle(delegation()); bridge.handle(created()); bridge.handle(call());
      if (interrupt) bridge.invalidate(); else setState({...snapshot, stepIndex: 1, revision: 2});
      bridge.handle(completed()); finish?.(); await flush();
      assert.deepEqual(sent, []);
    } finally { bridge.close(); }
  }
});

test('unrelated and failed delegation events cannot update the classroom', async () => {
  const {bridge, actions, sent} = fixture();
  try {
    bridge.handle(created()); bridge.handle(call());
    bridge.handle(delegation()); bridge.handle(created());
    bridge.handle(nested({type: 'response.failed', response: {id: 'resp_test'}}));
    bridge.handle(call()); bridge.handle(completed());
    await flush();
    assert.deepEqual(actions, []); assert.deepEqual(sent, []);
  } finally {bridge.close();}
});
