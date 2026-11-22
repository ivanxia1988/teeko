'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BookOpen, RotateCcw, UserRound } from 'lucide-react';
import { accountRequest, accountState, errorMessage } from '../product/account-request';

export type TopicUser = { id: string; email: string; profileComplete: boolean };
export const navigateTopic = (path: string) => { window.location.assign(path); };
export const topicLoginPath = (next: string) => `/topics/login?next=${encodeURIComponent(next)}`;

export function useTopicAccount() {
  const [user, setUser] = useState<TopicUser | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    accountRequest('/auth/state', accountState, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setUser(result.user); setLoading(false); }
    }).catch(failure => {
      if (!controller.signal.aborted) { setError(errorMessage(failure)); setLoading(false); }
    });
    return () => controller.abort();
  }, [attempt]);
  return { user, loading, error, retry: () => { setLoading(true); setError(''); setAttempt(value => value + 1); } };
}

export function TopicsHeader({ active, user, loading = false }: { active?: 'home' | 'me'; user?: TopicUser | null; loading?: boolean }) {
  return <header className="tk-topic-header">
    <Link className="tk-topic-logo" href="/topics" aria-label="Teeko 主题首页"><img src="/prototype-assets/teeko-head-icon.svg" alt=""/><span>Tee<b>ko</b></span></Link>
    <nav aria-label="主题学习导航"><Link href="/topics" aria-current={active === 'home' ? 'page' : undefined}>找个主题</Link><Link href="/topics/me" aria-current={active === 'me' ? 'page' : undefined}>我的学习</Link></nav>
    {loading ? <span className="tk-topic-account-state" role="status">连接账号…</span> : user ? <Link href="/topics/me" className="tk-topic-avatar" aria-label="个人中心"><UserRound size={18}/></Link> : <Link href="/topics/login" className="tk-topic-button is-small is-outline">登录 / 注册</Link>}
  </header>;
}

export function TopicMessage({ title, children, retry }: { title: string; children?: React.ReactNode; retry?: () => void }) {
  return <section className="tk-topic-message"><BookOpen size={34} strokeWidth={1.4}/><h2>{title}</h2>{children}{retry && <button type="button" className="tk-topic-button" onClick={retry}><RotateCcw size={16}/>重新读取</button>}</section>;
}

export function TopicCover({ id, image, className = '' }: { id: string; image: string; className?: string }) {
  return id === 'topic-robot' ? <div className={`tk-topic-cover is-robot ${className}`} role="img" aria-label="会飞又会游的机器人插画"/> : <div className={`tk-topic-cover ${className}`}><img src={image} alt=""/></div>;
}

export function TopicBackLink() { return <Link className="tk-topic-back" href="/topics"><ArrowRight size={15}/>回到主题</Link>; }
