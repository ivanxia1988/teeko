import React from 'react';
import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/topics/login' });
for (const key of ['window', 'self', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle', 'navigator']) {
  Object.defineProperty(globalThis, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true });
}
const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react');
const { TopicAccount, topicAccountDestination, topicAccountHref } = await import('../components/topics/topic-account.tsx');
const calls: { path: string; body?: Record<string, unknown> }[] = [];
type Handler = (path: string, body?: Record<string, unknown>) => Response | Promise<Response>;
let handler: Handler;
const success = (value = {}) => Response.json({ ok: true, ...value });
const target = '/topics/topic-robot?start=1';
beforeEach(() => {
  calls.length = 0;
  handler = path => path.endsWith('/state') ? success({ user: null, flow: null }) : path.endsWith('/cancel') ? success() : Response.json({ ok: false, error: { code: 'UNAVAILABLE', message: '账号服务暂不可用。' } }, { status: 503 });
  globalThis.fetch = async (input, init) => {
    const path = String(input), body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ path, body }); return handler(path, body);
  };
});
afterEach(cleanup);
after(() => dom.window.close());
async function loaded() { await waitFor(() => assert(!screen.queryByText('正在检查账号…'))); }
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });

test('account destinations allow only catalog startup, personal history and exact classroom paths', () => {
  for (const path of ['/topics', '/topics/me', target, '/topics/topic-picnic?start=1', '/topics/classroom/483c2055-90e2-4d27-b56c-f86bee1db2b8']) assert.equal(topicAccountDestination(path), path);
  for (const path of ['https://elsewhere.test/topics', '//elsewhere.test', '/topics/unknown?start=1', '/topics/topic-robot?start=1&next=https://elsewhere.test', '/topics/%2f%2felsewhere.test', '/topics/classroom/not-a-uuid', '/courses', '/topics/me#anything']) assert.equal(topicAccountDestination(path), '/topics');
  assert.equal(new URL(topicAccountHref('recover', target), 'https://example.test').searchParams.get('next'), target);
});

test('existing login and recovery links retain the selected topic and shared login returns there', async () => {
  const destinations: string[] = [];
  handler = path => path.endsWith('/state') ? success({ user: null, flow: null }) : success({ next: '/courses' });
  render(<TopicAccount next={target} navigate={path => destinations.push(path)} />); await loaded();
  assert.equal(screen.getByRole('link', { name: '注册账号' }).getAttribute('href'), topicAccountHref('register', target));
  assert.equal(screen.getByRole('link', { name: '忘记密码？' }).getAttribute('href'), topicAccountHref('recover', target));
  fill('邮箱', 'learner@example.com'); fill('密码', 'fixture-password');
  fireEvent.click(screen.getByRole('button', { name: '登录并继续' }));
  await waitFor(() => assert.deepEqual(destinations, [target]));
  assert(calls.some(call => call.path === '/api/v1/auth/login'));
  assert.equal(dom.window.localStorage.length, 0);
});

test('open signup verifies email and explicit agreement before returning to the selected topic', async () => {
  const destinations: string[] = [];
  handler = (path, body) => {
    if (path.endsWith('/state')) return success({ user: null, flow: null });
    if (path.endsWith('/cancel')) return success();
    if (path.endsWith('/code')) return success({ stage: 'code', retryAfter: 60 });
    if (path.endsWith('/verify')) return body?.code === '123456' ? success({ stage: 'password' }) : Response.json({ ok: false, error: { code: 'CODE_INVALID', message: '验证码不正确。' } }, { status: 400 });
    return success({ next: '/onboarding' });
  };
  render(<TopicAccount intent="register" next={target} navigate={path => destinations.push(path)} />); await loaded();
  assert(!screen.queryByLabelText('邀请码'));
  fill('邮箱', 'learner@example.com'); fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
  await waitFor(() => assert(screen.getByLabelText('验证码')));
  assert(!screen.queryByLabelText('密码', { exact: true }));
  assert.deepEqual(calls.find(call => call.path === '/api/v1/topics/auth/code')?.body, { email: 'learner@example.com' });
  fill('验证码', '123456'); fireEvent.click(screen.getByRole('button', { name: '验证邮箱' }));
  await waitFor(() => assert(screen.getByLabelText('密码', { exact: true })));
  assert.equal((screen.getByRole('checkbox') as HTMLInputElement).checked, false);
  fill('密码', 'fixture-password'); fill('确认密码', 'fixture-password');
  fireEvent.click(screen.getByRole('button', { name: '注册并继续' }));
  await waitFor(() => assert(screen.getByRole('alert').textContent?.includes('用户协议')));
  assert(!calls.some(call => call.path === '/api/v1/topics/auth/register'));
  fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: '注册并继续' }));
  await waitFor(() => assert.deepEqual(destinations, [target]));
  assert.deepEqual(calls.find(call => call.path === '/api/v1/topics/auth/register')?.body, { password: 'fixture-password', confirmation: 'fixture-password', agreed: true });
});

test('refresh resumes only a topic registration proof; invitation proofs are cancelled before topic signup', async () => {
  handler = path => path.endsWith('/state') ? success({ user: null, flow: { purpose: 'register', stage: 'password', email: 'learner@example.com', registration: 'topic' } }) : success();
  const view = render(<TopicAccount intent="register" next={target} />); await loaded();
  assert(screen.getByLabelText('确认密码')); assert.equal(calls.filter(call => call.path.endsWith('/cancel')).length, 0);
  view.unmount(); calls.length = 0;
  handler = path => path.endsWith('/state') ? success({ user: null, flow: { purpose: 'register', stage: 'password', email: 'learner@example.com', registration: 'invitation' } }) : success();
  render(<TopicAccount intent="register" next={target} />); await loaded();
  assert(screen.getByLabelText('邮箱')); assert(!screen.queryByLabelText('确认密码'));
  assert.equal(calls.filter(call => call.path.endsWith('/cancel')).length, 1);
});

test('password recovery uses the shared reset flow and retains the personal destination', async () => {
  const destinations: string[] = [];
  handler = path => path.endsWith('/state') ? success({ user: null, flow: { purpose: 'reset', stage: 'password', email: 'learner@example.com' } }) : success({ next: '/login' });
  render(<TopicAccount intent="recover" next="/topics/me" navigate={path => destinations.push(path)} />); await loaded();
  fill('密码', 'replacement-123'); fill('确认密码', 'replacement-123');
  fireEvent.click(screen.getByRole('button', { name: '保存新密码' }));
  await waitFor(() => assert.deepEqual(destinations, [topicAccountHref('login', '/topics/me')]));
  assert(calls.some(call => call.path === '/api/v1/auth/reset'));
});

test('unavailable signup stays at email and does not claim mail was sent', async () => {
  render(<TopicAccount intent="register" next={target} />); await loaded();
  fill('邮箱', 'learner@example.com'); fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
  await waitFor(() => assert.equal(screen.getByRole('alert').textContent, '账号服务暂不可用。'));
  assert(!screen.queryByLabelText('验证码')); assert(!screen.queryByText(/已发送|注册成功/));
});
