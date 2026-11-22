'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Clock3, LogOut } from 'lucide-react';
import { topicHistoryResponseSchema, getTopic } from '../../lib/topic-learning';
import { z } from 'zod';
import { AccountRequestError, accountRequest, destination, errorMessage, profileResponse, type ChildProfile } from '../product/account-request';
import { TopicCover, TopicMessage, TopicsHeader, navigateTopic, topicLoginPath, useTopicAccount } from './topics-shell';

type History = z.infer<typeof topicHistoryResponseSchema>;
const time = (seconds: number) => seconds < 60 ? `${Math.round(seconds)} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
const date = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

export function TopicProfile({ navigate = navigateTopic }: { navigate?: (path: string) => void }) {
  const account = useTopicAccount(), mounted = useRef(false), locked = useRef(false);
  const [history, setHistory] = useState<History | null>(null), [profile, setProfile] = useState<ChildProfile | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false), [page, setPage] = useState(0), [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[page];
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (account.loading || account.error) return;
    if (!account.user) { navigate(topicLoginPath('/topics/me')); return; }
    const controller = new AbortController();
    Promise.all([
      accountRequest(`/topics/history?pageSize=6${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, topicHistoryResponseSchema, { signal: controller.signal }),
      accountRequest('/profile', profileResponse, { signal: controller.signal }),
    ]).then(([records, saved]) => { if (!controller.signal.aborted) { setHistory(records); setProfile(saved.profile); setLoading(false); } }).catch(failure => {
      if (controller.signal.aborted) return;
      if (failure instanceof AccountRequestError && failure.status === 401) navigate(topicLoginPath('/topics/me'));
      else { setError(errorMessage(failure)); setLoading(false); }
    });
    return () => controller.abort();
  }, [account.loading, account.error, account.user, attempt, cursor, navigate]);
  async function logout() {
    if (locked.current) return; locked.current = true; setBusy(true); setError('');
    try { await accountRequest('/auth/logout', destination, { body: {} }); if (mounted.current) navigate('/topics'); }
    catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  function nextPage() { if (!history?.nextCursor) return; setLoading(true); setError(''); setCursors(values => [...values.slice(0, page + 1), history.nextCursor]); setPage(value => value + 1); }
  return <main className="tk-product tk-topics">
    <TopicsHeader active="me" user={account.user} loading={account.loading}/>
    <div className="tk-topic-content tk-topic-profile-grid"><aside className="tk-topic-profile-sidebar"><div className="tk-topic-profile-avatar">{profile?.name.slice(0, 1) || '我'}</div><h1>{profile?.name || '我的学习'}</h1>{profile && <p>{profile.ageRange} 岁 · {({ starter: '刚开始学', sentences: '能说简单句', conversation: '能简单聊天', unsure: '一起了解英语基础' })[profile.level]}</p>}<div className="tk-topic-profile-label">学习记录</div><button type="button" onClick={() => { void logout(); }} disabled={busy || !account.user}><LogOut size={15}/>{busy ? '正在退出…' : '退出登录'}</button></aside>
      <section className="tk-topic-history"><div className="tk-topic-history-heading"><div><h2>我的学习记录</h2><p>每次交流，都留在这里。</p></div><Link href="/topics" className="tk-topic-button is-outline is-small">找个新主题<ArrowRight size={15}/></Link></div>
        {account.error ? <TopicMessage title="账号暂时无法连接" retry={account.retry}><p role="alert">{account.error}</p></TopicMessage> : loading || account.loading ? <p className="tk-topic-loading" role="status">正在读取学习记录…</p> : error ? <TopicMessage title="学习记录暂时无法读取" retry={() => { setLoading(true); setError(''); setAttempt(value => value + 1); }}><p role="alert">{error}</p></TopicMessage> : <>
          {history?.activeClassroom && <div className="tk-topic-active"><strong>还有一次学习可以继续</strong><p>回来继续和老师聊，结束后就能查看这次记录。</p><Link className="tk-topic-button is-small" href={`/topics/classroom/${history.activeClassroom.id}`}>继续学习<ArrowRight size={15}/></Link></div>}
          {!history?.records.length ? <TopicMessage title={page ? '这一页暂时没有记录' : '第一次交流，从感兴趣的主题开始'}><p>学习结束后，这里会保存本次记录和有依据的课后建议。</p><Link href="/topics" className="tk-topic-button">去选一个主题<ArrowRight size={16}/></Link></TopicMessage> : <div className="tk-topic-history-list">{history.records.map(record => {
            const topic = getTopic(record.courseId);
            return <Link key={record.id} href={`/topics/classroom/${record.id}`} className="tk-topic-history-card"><TopicCover id={record.courseId} image={topic?.coverImage ?? '/prototype-assets/teeko-head-icon.svg'}/><div><time dateTime={record.endedAt}>{date(record.endedAt)}</time><h3>{record.courseTitle}</h3><p><Clock3 size={13}/>{time(record.elapsedSeconds)}</p><span className={`tk-topic-record-state is-${record.adviceStatus}`}>{record.adviceStatus === 'ready' ? record.noteCount > 0 ? '课堂表达与建议可查看' : '本次记录已整理' : record.adviceStatus === 'pending' ? '建议整理中，可先查看本次记录' : '已保存本次记录'}</span></div><span className="tk-topic-open-record">查看记录<ArrowRight size={15}/></span></Link>;
          })}</div>}
          {(page > 0 || history?.nextCursor) && <nav className="tk-topic-pagination" aria-label="学习记录分页"><button type="button" disabled={page === 0} onClick={() => { setLoading(true); setError(''); setPage(value => value - 1); }}><ArrowLeft size={15}/>上一页</button><span>第 {page + 1} 页</span><button type="button" disabled={!history?.nextCursor} onClick={nextPage}>下一页<ArrowRight size={15}/></button></nav>}
        </>}
      </section>
    </div>
  </main>;
}
