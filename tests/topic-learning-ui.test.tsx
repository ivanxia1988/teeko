import React from 'react';
import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TOPIC_CATALOG, encodeTopicHistoryCursor } from '../lib/topic-learning';
import { TOPIC_ROBOT_COURSE } from '../lib/server/topic-courses';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/topics' });
for (const key of ['window', 'self', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle', 'navigator']) Object.defineProperty(globalThis, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true });
const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
const { TopicCatalog } = await import('../components/topics/topic-catalog');
const { TopicDetail } = await import('../components/topics/topic-detail');
const { TopicProfile } = await import('../components/topics/topic-profile');

const id = '10000000-0000-4000-8000-000000000001';
const user = { id: 'learner', email: 'learner@example.com', profileComplete: true };
const profile = { name: 'Mia', ageRange: '10–11', level: 'sentences' };
const preferences = { provider: 'qwen', language: 'bilingual', style: 'gentle', voice: 'female', soundEffects: true };
const options = { providers: [{ id: 'qwen', name: '通义', configured: true }, { id: 'openai', name: 'GPT Live', configured: false }], preferences };
const snapshot = { id, course: TOPIC_ROBOT_COURSE, profile, preferences, status: 'preflight', revision: 0, connectionEpoch: 0, stepIndex: 0, elapsedSeconds: 0, remainingSeconds: 1200, maxSeconds: 1200, outcomes: [], teacherObjectIds: [], feedback: null, endReason: null, startedAt: '2026-11-21T00:00:00Z', endedAt: null, reportStatus: 'unavailable' };
type Call = { path: string; method: string; body?: Record<string, unknown> };
let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;
const ok = (value: Record<string, unknown>) => Response.json({ ok: true, ...value });
const emptyHistory = { records: [], nextCursor: null, activeClassroom: null };
const historyRecord = { id, courseId: 'topic-robot', courseTitle: '会飞又会游的机器人', startedAt: '2026-11-21T00:00:00Z', endedAt: '2026-11-21T00:04:15Z', elapsedSeconds: 255, endReason: 'manual', adviceStatus: 'ready', noteCount: 1 };
beforeEach(() => {
  calls = [];
  handler = ({ path }) => {
    if (path.endsWith('/auth/state')) return ok({ user: null, flow: null });
    if (path.endsWith('/topics')) return ok({ topics: TOPIC_CATALOG });
    if (path.endsWith('/profile')) return ok({ profile });
    if (path.includes('/topics/history')) return ok(emptyHistory);
    if (path.endsWith('/classroom-options')) return ok(options);
    if (path.endsWith('/preferences')) return ok({ preferences });
    if (path.endsWith('/classrooms')) return ok({ classroom: snapshot });
    throw new Error(`Unexpected test request ${path}`);
  };
  globalThis.fetch = async (input, init) => {
    const call = { path: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined };
    calls.push(call); return handler(call);
  };
});
afterEach(cleanup);
after(() => dom.window.close());

test('public catalog reads published topics, filters them, and never creates a classroom or opens devices', async () => {
  let mediaCalls = 0;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { mediaCalls++; throw new Error('must not open'); } } });
  render(<TopicCatalog/>);
  await waitFor(() => assert(screen.getByRole('heading', { name: '会飞又会游的机器人' })));
  assert(screen.getByRole('heading', { name: '一起准备一次野餐' }));
  assert(!screen.queryByText('选一个感兴趣的主题，和 Teeko 一起读、一起聊。'));
  assert(!screen.queryByText('每个主题都可以独立开始，聊到哪里，由你和 Teeko 一起决定。'));
  assert(!screen.queryByText('企鹅为什么不怕冷？'));
  fireEvent.click(screen.getByRole('button', { name: '生活' }));
  assert(!screen.queryByRole('heading', { name: '会飞又会游的机器人' }));
  fireEvent.click(screen.getByRole('button', { name: '全部' }));
  fireEvent.change(screen.getByLabelText('搜索主题或词语'), { target: { value: 'machine' } });
  assert(screen.getByRole('heading', { name: '会飞又会游的机器人' }));
  assert(!screen.queryByRole('heading', { name: '一起准备一次野餐' }));
  assert(calls.every(call => call.method === 'GET')); assert.equal(mediaCalls, 0);
});

test('preview is public and beginning conversation preserves the chosen topic through login', async () => {
  const paths: string[] = [];
  render(<TopicDetail topicId="topic-robot" navigate={path => paths.push(path)}/>);
  await waitFor(() => assert(!(screen.getByRole('button', { name: '和 Teeko 一起学' }) as HTMLButtonElement).disabled));
  assert(screen.getByRole('article', { name: '教材预览' }));
  assert(screen.getByRole('link', { name: /素材来源/ }));
  assert(!screen.queryByText('READ & DISCOVER'));
  assert(!screen.queryByText('和 Teeko 一起读，再聊聊自己的想法。'));
  assert(!screen.queryByText('开始交流前，登录或注册账号。'));
  assert(!screen.queryByText('查看教师提示词'));
  assert(!screen.queryByRole('heading', { name: 'GPT Live 工具注册' }));
  fireEvent.click(screen.getByRole('button', { name: '和 Teeko 一起学' }));
  assert.deepEqual(paths, ['/topics/login?next=%2Ftopics%2Ftopic-robot%3Fstart%3D1']);
  assert(!calls.some(call => call.path.endsWith('/classrooms') || call.path.endsWith('/profile')));
});

test('the authorized preview leads with the wire registration and preserves each prompt verbatim', async () => {
  const promptPreview = {
    voiceModel: 'gpt-live-1',
    registrationJson: '{\n  "type": "responses",\n  "responses": { "tools": [{ "name": "highlight_objects" }] }\n}',
    silenceCue: 'Offer a short example after waiting.',
    activities: [
      { id: 'robot-welcome', label: '第 1 页 · 认识机器', instructions: '# Role\n\n  Explain **one** idea.\nInvite a response.\n', opening: 'Explain what wings do.', backendInstructions: 'Call highlight_objects.\nThen describe the wings.' },
      { id: 'robot-read', label: '第 2 页 · 一起读短文', instructions: '# Role\n\nRead the excerpt.', opening: 'Read the excerpt.', contextUpdate: '{"current":"robot-read"}', advance: 'Introduce the next activity.' },
    ],
  };
  render(<TopicDetail topicId="topic-robot" promptPreview={promptPreview}/>);
  const section = (await screen.findByText('查看教师提示词')).closest('details');
  assert(section?.open);
  assert(screen.getByRole('heading', { name: 'GPT Live 工具注册' }));
  assert.equal(section.querySelector('pre code')?.textContent, promptPreview.registrationJson);
  const prompts = [...section.querySelectorAll('pre code')].map(code => code.textContent);
  assert(prompts.includes(promptPreview.activities[0].instructions));
  assert(prompts.includes(promptPreview.activities[0].opening));
  assert(prompts.includes(promptPreview.activities[0].backendInstructions!));
  assert(prompts.includes(promptPreview.silenceCue));
  const next = screen.getByText('第 2 页 · 一起读短文');
  assert.equal(next.closest('details')?.open, false);
  fireEvent.click(next);
  assert.equal(next.closest('details')?.open, true);
  assert(screen.getByText('{"current":"robot-read"}', { selector: 'pre code' }));
  assert(screen.getByText('Introduce the next activity.'));
  assert(calls.every(call => call.method === 'GET' && !call.path.includes('prompt')));
});

test('a new account saves its profile before reading classroom preferences and starts the selected topic once', async () => {
  const paths: string[] = []; let saved = false; const original = handler;
  handler = call => {
    if (call.path.endsWith('/auth/state')) return ok({ user: { ...user, profileComplete: false }, flow: null });
    if (call.path.endsWith('/profile')) { if (call.method === 'PATCH') saved = true; return ok({ profile: saved ? profile : null }); }
    if (call.path.endsWith('/classroom-options')) assert(saved, 'must save the real profile first');
    return original(call);
  };
  render(<TopicDetail topicId="topic-robot" start navigate={path => paths.push(path)}/>);
  await waitFor(() => assert(screen.getByLabelText('孩子的称呼')));
  assert(!calls.some(call => call.path.endsWith('/classroom-options')));
  fireEvent.change(screen.getByLabelText('孩子的称呼'), { target: { value: 'Mia' } });
  fireEvent.click(screen.getByRole('button', { name: '保存并继续' }));
  await waitFor(() => assert(screen.getByRole('button', { name: '开始这次学习' })));
  assert(screen.getByText('摄像头 · 可选，默认关闭'));
  assert(!screen.queryByText('一起读，也听听你的想法。'));
  fireEvent.click(screen.getByRole('button', { name: '开始这次学习' }));
  fireEvent.click(screen.getByRole('button', { name: '正在准备课堂…' }));
  await waitFor(() => assert.deepEqual(paths, [`/topics/classroom/${id}`]));
  assert.equal(calls.filter(call => call.path.endsWith('/classrooms')).length, 1);
  assert.deepEqual(calls.find(call => call.path.endsWith('/classrooms'))?.body, { courseId: 'topic-robot', preferences });
});

test('an unfinished original classroom is offered for recovery and never replaced with a new topic session', async () => {
  const original = handler;
  handler = call => call.path.endsWith('/auth/state') ? ok({ user, flow: null }) : call.path.includes('/topics/history') ? ok({ ...emptyHistory, activeClassroom: { id, courseId: 'picnic', status: 'paused', provider: 'qwen' } }) : original(call);
  render(<TopicDetail topicId="topic-robot" start/>);
  await waitFor(() => assert(screen.getByRole('link', { name: '回到正在进行的课堂' })));
  assert.equal(screen.getByRole('link', { name: '回到正在进行的课堂' }).getAttribute('href'), `/topics/classroom/${id}`);
  assert(!screen.queryByRole('button', { name: '开始这次学习' }));
  assert(!calls.some(call => call.path.endsWith('/classrooms') || call.path.endsWith('/actions')));
});

test('a course package uses the same topic catalog and resume URLs as built-in topics', async () => {
  const idFromPackage = 'seabird-flights';
  const card = {...TOPIC_CATALOG[0], id: idFromPackage, title: '海鸟为什么会飞？'};
  const original = handler;
  handler = call => {
    if (call.path.endsWith('/auth/state')) return ok({user, flow: null});
    if (call.path.endsWith('/topics')) return ok({topics: [card]});
    if (call.path.includes('/topics/history')) return ok({...emptyHistory, activeClassroom: {id, courseId: idFromPackage, status: 'paused', provider: 'qwen'}});
    return original(call);
  };
  const catalog = render(<TopicCatalog/>);
  assert.equal((await screen.findByRole('link', {name: /海鸟为什么会飞/})).getAttribute('href'), `/topics/${idFromPackage}`);
  catalog.unmount();
  const detail = render(<TopicDetail topicId={idFromPackage} start/>);
  assert.equal((await screen.findByRole('link', {name: '回到正在进行的课堂'})).getAttribute('href'), `/topics/classroom/${id}`);
  detail.unmount();
  render(<TopicProfile/>);
  assert.equal((await screen.findByRole('link', {name: '继续学习'})).getAttribute('href'), `/topics/classroom/${id}`);
});

test('no configured voice service prevents classroom creation and honestly explains availability', async () => {
  const original = handler;
  handler = call => call.path.endsWith('/auth/state') ? ok({ user, flow: null }) : call.path.endsWith('/classroom-options') ? ok({ ...options, providers: [{ id: 'qwen', name: '通义', configured: false }] }) : original(call);
  render(<TopicDetail topicId="topic-robot" start/>);
  await waitFor(() => assert(screen.getByText(/请选择已配置的语音服务/)));
  assert((screen.getByRole('button', { name: '开始这次学习' }) as HTMLButtonElement).disabled);
  assert(!calls.some(call => call.path.endsWith('/classrooms')));
});

test('personal history is paginated from saved records and links to the same session without reconnecting', async () => {
  const original = handler, cursor = encodeTopicHistoryCursor({ endedAt: historyRecord.endedAt, id });
  handler = call => call.path.endsWith('/auth/state') ? ok({ user, flow: null }) : call.path.includes('/topics/history') ? ok({ ...emptyHistory, records: [{ ...historyRecord, ...(call.path.includes('cursor=') ? { courseTitle: '另一条真实记录' } : {}) }], nextCursor: call.path.includes('cursor=') ? null : cursor }) : original(call);
  render(<TopicProfile/>);
  await waitFor(() => assert(screen.getByRole('link', { name: /会飞又会游的机器人/ })));
  assert.equal(screen.getByRole('link', { name: /会飞又会游的机器人/ }).getAttribute('href'), `/topics/classroom/${id}`);
  assert(screen.getByText('4 分 15 秒')); assert(screen.getByText('课堂表达与建议可查看'));
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => assert(screen.getByText('另一条真实记录')));
  assert(calls.some(call => call.path.includes(`cursor=${encodeURIComponent(cursor)}`)));
  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  await waitFor(() => assert(screen.getByRole('link', { name: /会飞又会游的机器人/ })));
  assert(calls.every(call => call.method === 'GET'));
});

test('history empty state contains no demo progress or invented advice and account expiry returns to the personal area', async () => {
  const original = handler, paths: string[] = [];
  handler = call => call.path.endsWith('/auth/state') ? ok({ user, flow: null }) : original(call);
  render(<TopicProfile navigate={path => paths.push(path)}/>);
  await waitFor(() => assert(screen.getByRole('heading', { name: '第一次交流，从感兴趣的主题开始' })));
  assert(!screen.queryByText('课堂表达与建议可查看'));
  cleanup(); handler = original;
  render(<TopicProfile navigate={path => paths.push(path)}/>);
  await waitFor(() => assert.deepEqual(paths, ['/topics/login?next=%2Ftopics%2Fme']));
});

test('a finished history job with no expression notes does not claim advice is available', async () => {
  const original = handler;
  handler = call => call.path.endsWith('/auth/state') ? ok({ user, flow: null }) : call.path.includes('/topics/history') ? ok({ ...emptyHistory, records: [{ ...historyRecord, adviceStatus: 'ready', noteCount: 0 }] }) : original(call);
  render(<TopicProfile/>);
  await waitFor(() => assert(screen.getByText('本次记录已整理')));
  assert(!screen.queryByText('课堂表达与建议可查看'));
  assert.equal(screen.getByRole('link', { name: /会飞又会游的机器人/ }).getAttribute('href'), `/topics/classroom/${id}`);
});

test('catalog network failure offers a retry rather than displaying static example courses as published', async () => {
  let unavailable = true; const original = handler;
  handler = call => call.path.endsWith('/topics') && unavailable ? Response.json({ ok: false, error: { code: 'UNAVAILABLE', message: '主题暂时无法读取。' } }, { status: 503 }) : original(call);
  render(<TopicCatalog/>);
  await waitFor(() => assert(screen.getByRole('alert')));
  assert(!screen.queryByRole('heading', { name: '会飞又会游的机器人' }));
  unavailable = false; fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
  await waitFor(() => assert(screen.getByRole('heading', { name: '会飞又会游的机器人' })));
});
