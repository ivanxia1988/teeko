'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BookOpen, Check, Clock3, ExternalLink, Mic, Video } from 'lucide-react';
import { topicCatalogResponseSchema, topicHistoryResponseSchema, type TopicCard } from '../../lib/topic-learning';
import type { ClassroomPreferences } from '../../lib/classroom-contract';
import type { TopicPromptPreview } from '../../lib/topic-prompt-preview';
import { AccountRequestError, accountRequest, childProfile, errorMessage, profileResponse, type ChildProfile } from '../product/account-request';
import { classroomOptionsResponse, classroomResponse, savedPreferencesResponse } from '../product/classroom-request';
import { TopicBackLink, TopicMessage, TopicsHeader, navigateTopic, topicLoginPath, useTopicAccount } from './topics-shell';
import { TopicPromptPanel } from './topic-prompt-preview';

type ActiveClassroom = { id: string; courseId: string; status: string; provider?: ClassroomPreferences['provider'] };
const initialProfile: ChildProfile = { name: '', ageRange: '10–11', level: 'unsure' };
const defaultPreferences: ClassroomPreferences = { provider: 'qwen', language: 'bilingual', style: 'gentle', voice: 'female', soundEffects: true };

export function TopicDetail({ topicId, start = false, navigate = navigateTopic, promptPreview }: { topicId: string; start?: boolean; navigate?: (path: string) => void; promptPreview?: TopicPromptPreview | null }) {
  const account = useTopicAccount(), mounted = useRef(false), locked = useRef(false);
  const [topic, setTopic] = useState<TopicCard | null>(null), [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [attempt, setAttempt] = useState(0);
  const [preparing, setPreparing] = useState(start), [prepLoading, setPrepLoading] = useState(true), [prepError, setPrepError] = useState(''), [prepAttempt, setPrepAttempt] = useState(0), [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<ChildProfile>(initialProfile), [needsProfile, setNeedsProfile] = useState(false), [preferences, setPreferences] = useState<ClassroomPreferences>(defaultPreferences);
  const [providers, setProviders] = useState<{ id: ClassroomPreferences['provider']; name: string; configured: boolean }[]>([]), [active, setActive] = useState<ActiveClassroom | null>(null), [ready, setReady] = useState(false);
  const next = `/topics/${encodeURIComponent(topicId)}?start=1`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    accountRequest('/topics', topicCatalogResponseSchema, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setTopic(result.topics.find(item => item.id === topicId) ?? null); setLoading(false); } }).catch(failure => { if (!controller.signal.aborted) { setLoadError(errorMessage(failure)); setLoading(false); } });
    return () => controller.abort();
  }, [topicId, attempt]);
  useEffect(() => {
    if (!preparing || account.loading || account.error || !topic) return;
    if (!account.user) { navigate(topicLoginPath(next)); return; }
    const controller = new AbortController();
    void (async () => {
      const saved = await accountRequest('/profile', profileResponse, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!saved.profile) { setNeedsProfile(true); setPrepLoading(false); return; }
      setProfile(saved.profile); setNeedsProfile(false);
      const [options, history] = await Promise.all([
        accountRequest('/classroom-options', classroomOptionsResponse, { signal: controller.signal }),
        accountRequest('/topics/history?pageSize=1', topicHistoryResponseSchema, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      setPreferences(options.preferences); setProviders(options.providers); setActive(history.activeClassroom); setReady(true); setPrepLoading(false);
    })().catch(failure => {
      if (controller.signal.aborted) return;
      if (failure instanceof AccountRequestError && failure.status === 401) navigate(topicLoginPath(next));
      else { setPrepError(errorMessage(failure)); setPrepLoading(false); }
    });
    return () => controller.abort();
  }, [account.loading, account.error, account.user, preparing, topic, prepAttempt, next, navigate]);
  function begin() {
    if (account.loading) return;
    if (account.error) { account.retry(); return; }
    if (!account.user) navigate(topicLoginPath(next)); else { setPrepLoading(true); setPrepError(''); setReady(false); setPreparing(true); }
  }
  async function submit() {
    if (locked.current || prepLoading || !topic || !account.user) return;
    locked.current = true; setBusy(true); setPrepError('');
    try {
      if (needsProfile) {
        const parsed = childProfile.safeParse(profile);
        if (!parsed.success) throw new Error('请填写孩子的称呼（1–20 个字符）。');
        const saved = await accountRequest('/profile', profileResponse, { method: 'PATCH', body: parsed.data });
        if (!saved.profile) throw new Error('档案尚未保存，请重试。');
        if (mounted.current) { setPrepLoading(true); setReady(false); setPrepAttempt(value => value + 1); }
      } else {
        if (!ready || active || !providers.some(provider => provider.id === preferences.provider && provider.configured)) return;
        await accountRequest('/preferences', savedPreferencesResponse, { method: 'PATCH', body: preferences });
        if (!mounted.current) return;
        const result = await accountRequest('/classrooms', classroomResponse, { body: { courseId: topic.id, preferences } });
        if (mounted.current) navigate(`/topics/classroom/${result.classroom.id}`);
      }
    } catch (failure) {
      if (mounted.current) {
        if (failure instanceof AccountRequestError && failure.status === 401) navigate(topicLoginPath(next));
        else { setPrepError(errorMessage(failure)); if (failure instanceof AccountRequestError && failure.status === 409) { setPrepLoading(true); setReady(false); setPrepAttempt(value => value + 1); } }
      }
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  const configured = providers.some(provider => provider.id === preferences.provider && provider.configured);
  return <main className="tk-product tk-topics">
    <TopicsHeader user={account.user} loading={account.loading}/>
    <div className="tk-topic-content"><TopicBackLink/>
      {loading ? <p className="tk-topic-loading" role="status">正在打开教材…</p> : loadError ? <TopicMessage title="教材暂时无法读取" retry={() => { setLoading(true); setLoadError(''); setAttempt(value => value + 1); }}><p role="alert">{loadError}</p></TopicMessage> : !topic ? <TopicMessage title="这个主题暂未开放"><Link href="/topics" className="tk-topic-button">看看其他主题</Link></TopicMessage> : preparing && account.user ? <section className="tk-topic-prepare" aria-labelledby="topic-prepare-title">
        <div className="tk-topic-prepare-heading"><h1 id="topic-prepare-title">准备好，开口聊聊。</h1><p>{topic.title} · {topic.durationMinutes} 分钟左右</p></div>
        <div className="tk-topic-prepare-grid"><aside className="tk-topic-ready-teacher"><img src="/prototype-assets/pose-idle-listening.svg" alt="Teeko 小麻雀老师"/><h2>Hi{profile.name.trim() ? `, ${profile.name.trim()}` : ', I’m Teeko'}!</h2><p>一起读，也听听你的想法。</p></aside>
        <form className="tk-topic-setup" onSubmit={event => { event.preventDefault(); void submit(); }}>
          {prepLoading ? <p role="status">正在读取学习设置…</p> : <>
          {prepError && <div className="tk-topic-error" role="alert"><p>{prepError}</p>{!ready && !needsProfile && <button type="button" className="tk-topic-button is-outline" onClick={() => { setPrepLoading(true); setPrepError(''); setReady(false); setPrepAttempt(value => value + 1); }}>重新读取</button>}</div>}
          <fieldset disabled={busy || (!ready && !needsProfile)} className="tk-topic-fields">
          {needsProfile ? <><h2>先认识一下</h2><label>孩子的称呼<input autoComplete="nickname" maxLength={20} value={profile.name} placeholder="Teeko 该怎么称呼你？" onChange={event => setProfile(current => ({ ...current, name: event.target.value }))}/></label><label>年龄<select value={profile.ageRange} onChange={event => setProfile(current => ({ ...current, ageRange: event.target.value as ChildProfile['ageRange'] }))}>{(['8–9', '10–11', '12–13'] as const).map(age => <option value={age} key={age}>{age} 岁</option>)}</select></label><label>英语基础<select value={profile.level} onChange={event => setProfile(current => ({ ...current, level: event.target.value as ChildProfile['level'] }))}><option value="unsure">不确定，聊一聊再了解</option><option value="starter">刚开始学，认识 Hello、apple</option><option value="sentences">能说简单句，例如 I like apples.</option><option value="conversation">能用英语聊兴趣、学校或周末</option></select></label><button type="submit" className="tk-topic-button">{busy ? '正在保存…' : '保存并继续'}<ArrowRight size={17}/></button></> : <>
            <div className="tk-topic-device-note"><Mic size={19}/><div><strong>麦克风</strong><p>进入课堂后检查，允许 Teeko 听到你的声音。</p></div></div><div className="tk-topic-device-note"><Video size={19}/><div><strong>摄像头 · 可选</strong><p>默认关闭，课堂内可自行开启。关闭摄像头也能学习。</p></div></div>
            <div className="tk-topic-pref-grid"><label>语音老师<select value={preferences.provider} onChange={event => setPreferences(current => ({ ...current, provider: event.target.value as ClassroomPreferences['provider'] }))}>{providers.map(provider => <option value={provider.id} key={provider.id} disabled={!provider.configured}>{provider.name}{provider.configured ? '' : ' · 暂不可用'}</option>)}</select></label><label>授课语言<select value={preferences.language} onChange={event => setPreferences(current => ({ ...current, language: event.target.value as ClassroomPreferences['language'] }))}><option value="bilingual">允许中文辅助</option><option value="english">全英文</option></select></label><label>老师风格<select value={preferences.style} onChange={event => setPreferences(current => ({ ...current, style: event.target.value as ClassroomPreferences['style'] }))}><option value="gentle">温柔</option><option value="focused">认真</option><option value="strict">严格</option></select></label><label>声音<select value={preferences.voice} onChange={event => setPreferences(current => ({ ...current, voice: event.target.value as ClassroomPreferences['voice'] }))}><option value="female">女声</option><option value="male">男声</option></select></label></div>
            {!configured && ready && <p className="tk-topic-inline-note">请选择已配置的语音服务；如果都不可用，请稍后再试。</p>}
            {active ? <div className="tk-topic-active"><strong>还有一次学习尚未结束</strong><p>{active.courseId === topic.id ? '可以回到刚才的内容，继续和老师聊。' : '请先回到正在进行的课堂，结束并保存后，再开始这个主题。'}</p><Link href={`${active.courseId.startsWith('topic-') ? '/topics/classroom' : '/classroom'}/${active.id}`} className="tk-topic-button">回到正在进行的课堂<ArrowRight size={16}/></Link></div> : <button type="submit" className="tk-topic-button" disabled={!ready || !configured}>{busy ? '正在准备课堂…' : '开始这次学习'}<ArrowRight size={17}/></button>}
          </>}
          </fieldset></>}
          <button type="button" className="tk-topic-text-button" disabled={busy} onClick={() => setPreparing(false)}>回看教材</button>
        </form></div>
      </section> : <div className="tk-topic-detail-grid"><article className="tk-topic-paper" aria-label="教材预览"><div className="tk-topic-paper-label"><span>READ & DISCOVER</span><span>教材预览</span></div><h1>{topic.subtitle}</h1><img className="tk-topic-preview-image" src={topic.preview.image} width={topic.preview.width} height={topic.preview.height} alt={`${topic.title}教材插画`}/><p lang="en" className="tk-topic-preview-passage">{topic.preview.passage}</p><footer><BookOpen size={14}/><span>和 Teeko 一起读，再聊聊自己的想法。</span></footer></article><section className="tk-topic-detail-copy"><div className="tk-topic-meta"><span>{topic.categoryLabel}</span><span>{topic.difficultyLabel}</span></div><h2>{topic.title}</h2><p>{topic.description}</p><div className="tk-topic-detail-time"><Clock3 size={15}/>{topic.durationMinutes} 分钟左右<span>语音交流 · 摄像头可选</span></div><h3>这次我们会…</h3><ul>{topic.objectives.map(item => <li key={item}><Check size={15}/>{item}</li>)}</ul><div className="tk-topic-words">{topic.words.map(word => <span key={word}>{word}</span>)}</div>{topic.source && <a className="tk-topic-source" href={topic.source.url} target="_blank" rel="noopener noreferrer">素材来源 · {topic.source.title}<ExternalLink size={13}/></a>}{account.error && <p role="alert" className="tk-topic-error">{account.error}</p>}<button className="tk-topic-button" type="button" disabled={account.loading} onClick={begin}>{account.error ? '重新连接账号' : '和 Teeko 一起学'}<ArrowRight size={17}/></button><small>{account.user ? '进入后按需开启麦克风和摄像头。' : '开始交流前，登录或注册账号。'}</small></section></div>}
      {promptPreview && <TopicPromptPanel preview={promptPreview}/>}
    </div>
  </main>;
}
