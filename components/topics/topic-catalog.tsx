'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Clock3, Search } from 'lucide-react';
import { topicCatalogResponseSchema, type TopicCard } from '../../lib/topic-learning';
import { accountRequest, errorMessage } from '../product/account-request';
import { TopicCover, TopicMessage, TopicsHeader, useTopicAccount } from './topics-shell';

export function TopicCatalog() {
  const account = useTopicAccount();
  const [topics, setTopics] = useState<TopicCard[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const [category, setCategory] = useState('all'), [difficulty, setDifficulty] = useState('all'), [query, setQuery] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    accountRequest('/topics', topicCatalogResponseSchema, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setTopics(result.topics); setLoading(false); }
    }).catch(failure => { if (!controller.signal.aborted) { setError(errorMessage(failure)); setLoading(false); } });
    return () => controller.abort();
  }, [attempt]);
  const categories = Array.from(new Map(topics.map(topic => [topic.category, topic.categoryLabel])).entries());
  const difficulties = Array.from(new Map(topics.map(topic => [topic.difficulty, topic.difficultyLabel])).entries());
  const visible = topics.filter(topic => (category === 'all' || topic.category === category) && (difficulty === 'all' || topic.difficulty === difficulty) && `${topic.title} ${topic.subtitle} ${topic.description} ${topic.words.join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <main className="tk-product tk-topics">
    <TopicsHeader active="home" user={account.user} loading={account.loading}/>
    <div className="tk-topic-content">
      <div className="tk-topic-catalog-heading"><h1>今天，想聊点什么？</h1><label className="tk-topic-search"><Search size={17}/><input aria-label="搜索主题或词语" placeholder="搜索主题或词语" type="search" value={query} onChange={event => setQuery(event.target.value)}/></label></div>
      {account.error && <p className="tk-topic-inline-note">账号连接暂未完成，仍可浏览教材。<button type="button" onClick={account.retry}>重新连接账号</button></p>}
      <div className="tk-topic-filters"><div role="group" aria-label="主题分类"><button type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>全部</button>{categories.map(([value, label]) => <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)}>{label}</button>)}</div><label>难度<select value={difficulty} onChange={event => setDifficulty(event.target.value)}><option value="all">全部难度</option>{difficulties.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      {loading ? <p className="tk-topic-loading" role="status">正在读取主题…</p> : error ? <TopicMessage title="主题暂时无法读取" retry={() => { setLoading(true); setError(''); setAttempt(value => value + 1); }}><p role="alert">{error}</p></TopicMessage> : !topics.length ? <TopicMessage title="暂无主题"/> : !visible.length ? <TopicMessage title="还没有找到匹配的主题"><button type="button" className="tk-topic-button is-outline" onClick={() => { setQuery(''); setCategory('all'); setDifficulty('all'); }}>查看全部主题</button></TopicMessage> : <section className="tk-topic-grid" aria-label="可学习的主题">{visible.map(topic => <Link href={`/topics/${topic.id}`} key={topic.id} className="tk-topic-card"><TopicCover id={topic.id} image={topic.coverImage}/><div className="tk-topic-card-copy"><div className="tk-topic-meta"><span>{topic.categoryLabel}</span><span>{topic.difficultyLabel}</span></div><h2>{topic.title}</h2><p>{topic.description}</p><footer><span><Clock3 size={13}/>{topic.durationMinutes} 分钟左右</span><span>看看教材<ArrowRight size={14}/></span></footer></div></Link>)}</section>}
    </div>
  </main>;
}
