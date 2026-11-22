'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { z } from 'zod';
import { accountSubmissionError, passwordSubmissionError, type AccountIntent } from '../product/account-state';
import { accountRequest, accountState, completed, destination, errorMessage, sentCode, verifiedCode } from '../product/account-request';
import { TopicAgreementNotice } from './topic-agreement-notice';
import { topicIdSchema } from '../../lib/topic-learning';

export function topicAccountDestination(value?: string) {
  if (value === '/topics' || value === '/topics/me') return value;
  const topic = value?.match(/^\/topics\/([a-z0-9-]+)\?start=1$/);
  if (topic && topicIdSchema.safeParse(topic[1]).success && !['classroom', 'login', 'me'].includes(topic[1])) return value!;
  const classroom = value?.match(/^\/topics\/classroom\/([^/?#]+)$/);
  if (classroom && z.string().uuid().safeParse(classroom[1]).success) return value!;
  return '/topics';
}
export function topicAccountHref(intent: AccountIntent, next: string) {
  return `/topics/login?${new URLSearchParams({ intent, next: topicAccountDestination(next) })}`;
}
const stateSchema = accountState.extend({ flow: z.object({ purpose: z.enum(['register', 'reset']), stage: z.enum(['email', 'code', 'password']), email: z.string().email().optional(), registration: z.enum(['invitation', 'topic']).optional() }).nullable() });
const navigatePage = (path: string) => window.location.assign(path);
type Stage = 'email' | 'code' | 'password';

export function TopicAccount({ intent = 'login', next, navigate = navigatePage }: { intent?: AccountIntent; next?: string; navigate?: (path: string) => void }) {
  const returnTo = topicAccountDestination(next), register = intent === 'register', recover = intent === 'recover', purpose = register ? 'register' : 'reset';
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [code, setCode] = useState('');
  const [stage, setStage] = useState<Stage>('email'), [visible, setVisible] = useState(false), [agreed, setAgreed] = useState(false), [agreement, setAgreement] = useState(false);
  const [loading, setLoading] = useState(true), [loadFailed, setLoadFailed] = useState(false), [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false), [cooldown, setCooldown] = useState(0), [error, setError] = useState('');
  const mounted = useRef(false), locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const state = await accountRequest('/auth/state', stateSchema, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (state.user && !recover) { navigate(returnTo); return; }
        if (intent !== 'login') {
          if (state.flow?.purpose === purpose && (!register || state.flow.registration === 'topic')) {
            setStage(state.flow.stage); setEmail(state.flow.email ?? '');
          } else {
            // A stale or invitation flow must not be reused by the public topic signup.
            await accountRequest('/auth/cancel', completed, { body: {}, signal: controller.signal });
            if (controller.signal.aborted) return;
          }
        }
        setLoading(false); setLoadFailed(false); setError('');
      } catch (failure) {
        if (controller.signal.aborted) return;
        setLoading(false); setLoadFailed(true); setError(errorMessage(failure));
      }
    })();
    return () => { mounted.current = false; controller.abort(); };
  }, [attempt, intent, navigate, purpose, recover, register, returnTo]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  async function perform(action: () => Promise<void>) {
    if (locked.current || loading || loadFailed) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); } catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  async function cancel() {
    await accountRequest('/auth/cancel', completed, { body: {} });
    if (!mounted.current) return;
    setPassword(''); setConfirmation(''); setCode(''); setAgreed(false); setCooldown(0); setEmail(''); setStage('email');
  }
  function follow(event: MouseEvent<HTMLAnchorElement>, path: string) {
    if (locked.current || loading) { event.preventDefault(); return; }
    if (loadFailed) return;
    event.preventDefault(); void perform(async () => { await cancel(); if (mounted.current) navigate(path); });
  }
  async function send() {
    const validation = accountSubmissionError('recover', { email, password, invitation: '' });
    if (validation) { setError(validation); return; }
    const result = await accountRequest(register ? '/topics/auth/code' : '/auth/code', sentCode, { body: register ? { email: email.trim() } : { purpose: 'reset', email: email.trim() } });
    if (mounted.current) { setStage('code'); setCode(''); setCooldown(result.retryAfter); }
  }
  async function submit() {
    if (intent === 'login') {
      const validation = accountSubmissionError('login', { email, password, invitation: '' });
      if (validation) { setError(validation); return; }
      await accountRequest('/auth/login', destination, { body: { email: email.trim(), password } });
      if (mounted.current) { setPassword(''); navigate(returnTo); } return;
    }
    if (stage === 'email') { await send(); return; }
    if (stage === 'code') {
      if (!/^\d{6}$/.test(code)) { setError('请输入 6 位验证码。'); return; }
      await accountRequest('/auth/verify', verifiedCode, { body: { purpose, code } });
      if (mounted.current) { setCode(''); setCooldown(0); setStage('password'); } return;
    }
    const validation = passwordSubmissionError(password, confirmation);
    if (validation) { setError(validation); return; }
    if (register && !agreed) { setError('请阅读并同意《用户协议》。'); return; }
    await accountRequest(register ? '/topics/auth/register' : '/auth/reset', destination, { body: { password, confirmation, ...(register ? { agreed: true } : {}) } });
    if (mounted.current) { setPassword(''); setConfirmation(''); navigate(register ? returnTo : topicAccountHref('login', returnTo)); }
  }
  const label = intent === 'login' ? '登录并继续' : stage === 'email' ? '获取验证码' : stage === 'code' ? '验证邮箱' : register ? '注册并继续' : '保存新密码';
  const loginHref = topicAccountHref('login', returnTo), registerHref = topicAccountHref('register', returnTo), recoverHref = topicAccountHref('recover', returnTo);
  return <div className="tk-product tk-account tk-topic-account">
    <section className="tk-account-story">
      <Link href="/topics" className="tk-wordmark" aria-label="Teeko 主题首页" onClick={event => follow(event, '/topics')}>Tee<span>ko</span><img src="/prototype-assets/teeko-head-icon.svg" alt="" /></Link>
      <div><span className="tk-age">选个话题，聊出新发现</span><h1>和 Teeko，<br />聊聊这个世界。</h1><p>{returnTo === '/topics/me' ? '登录后查看学习记录，和每次交流后的建议。' : '登录后继续刚才选中的主题，和老师一起读、聊、练习。'}</p></div>
      <img className="tk-account-bird" src="/prototype-assets/pose-handoff.svg" alt="Teeko 小麻雀老师" />
    </section>
    <section className="tk-account-main"><form noValidate onSubmit={event => { event.preventDefault(); void perform(submit); }} aria-labelledby="tk-topic-account-title">
      <h2 id="tk-topic-account-title">{recover ? stage === 'password' ? '设置新密码' : '找回密码' : intent === 'login' ? '欢迎回来' : stage === 'password' ? '设置密码' : stage === 'code' ? '验证邮箱' : '注册，开始一次交流'}</h2>
      {loading && <p role="status">正在检查账号…</p>}
      {error && <p className="tk-account-error" id="tk-topic-account-error" role="alert">{error}</p>}
      {loadFailed && <button type="button" className="tk-submit" onClick={() => { setLoading(true); setLoadFailed(false); setAttempt(value => value + 1); }}>重新连接</button>}
      <fieldset className="tk-account-fields" disabled={busy || loading || loadFailed}>
        {intent === 'login' || stage === 'email' ? <label htmlFor="tk-topic-email">邮箱<input id="tk-topic-email" type="email" name="email" autoComplete="email" value={email} onChange={event => { setEmail(event.target.value); setError(''); }} maxLength={254} placeholder="输入邮箱地址" aria-describedby={error ? 'tk-topic-account-error' : undefined} /></label> : <div className="tk-verified-email"><span>{email}</span><button type="button" onClick={() => { void perform(cancel); }}>更换邮箱</button></div>}
        {stage === 'code' && intent !== 'login' && <><label htmlFor="tk-topic-code">验证码<input id="tk-topic-code" name="code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => { setCode(event.target.value); setError(''); }} maxLength={6} placeholder="6 位验证码" /></label><button type="button" className="tk-resend" disabled={cooldown > 0} onClick={() => { void perform(send); }}>{cooldown > 0 ? `${cooldown} 秒后可重发` : '重新发送验证码'}</button></>}
        {(intent === 'login' || stage === 'password') && <><label htmlFor="tk-topic-password">密码</label><div className="tk-password"><input id="tk-topic-password" type={visible ? 'text' : 'password'} name="password" autoComplete={intent === 'login' ? 'current-password' : 'new-password'} value={password} onChange={event => { setPassword(event.target.value); setError(''); }} maxLength={64} placeholder={intent === 'login' ? '输入密码' : '8–64 个字符'} /><button type="button" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>{stage === 'password' && <label htmlFor="tk-topic-confirmation">确认密码<input id="tk-topic-confirmation" type={visible ? 'text' : 'password'} name="confirmation" autoComplete="new-password" maxLength={64} value={confirmation} onChange={event => { setConfirmation(event.target.value); setError(''); }} placeholder="再次输入密码" /></label>}{intent === 'login' && <Link href={recoverHref} className="tk-forgot" onClick={event => follow(event, recoverHref)}>忘记密码？</Link>}</>}
        {register && stage === 'password' && <div className="tk-consent"><label><input type="checkbox" checked={agreed} onChange={event => { setAgreed(event.target.checked); setError(''); }} />已阅读并同意</label><button type="button" onClick={() => setAgreement(true)}>《用户协议》</button></div>}
        <button type="submit" className="tk-submit">{busy ? '正在处理…' : label}<ArrowRight size={18} /></button>
      </fieldset>
      <div className="tk-account-links">{intent === 'login' ? <Link href={registerHref} aria-disabled={busy || loading} onClick={event => follow(event, registerHref)}>注册账号</Link> : <Link href={loginHref} aria-disabled={busy || loading} onClick={event => follow(event, loginHref)}><ArrowLeft size={15} />返回登录</Link>}<button type="button" onClick={() => setAgreement(true)}>用户协议</button></div>
    </form></section>
    {agreement && <TopicAgreementNotice onClose={() => setAgreement(false)} />}
  </div>;
}
