'use client';

import Link from 'next/link';
import {ArrowRight,BookOpen,Check} from 'lucide-react';
import type {ClassroomSnapshot} from '../../lib/classroom-contract';
import {buildClassroomSummary} from '../../lib/classroom-summary';
import {ClassroomNotes} from '../product/classroom-notes';

export function TopicRecap({state}:{state:ClassroomSnapshot}){
 const summary=buildClassroomSummary(state);
 const date=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',timeZone:'Asia/Shanghai'}).format(new Date(state.endedAt??state.startedAt));
 const duration=`${Math.floor(state.elapsedSeconds/60)} 分 ${Math.floor(state.elapsedSeconds%60)} 秒`;
 const visited=state.course.steps.filter((step,index)=>index<=state.stepIndex&&state.elapsedSeconds>0||state.outcomes.some(outcome=>outcome.stepId===step.id));
 return <main className="tk-product tk-topic-recap">
  <header className="tk-product-header"><Link href="/topics" className="tk-wordmark">Tee<span>ko</span><img src="/prototype-assets/teeko-head-icon.svg" alt=""/></Link><nav><Link href="/topics">主题首页</Link><Link href="/topics/me">我的学习</Link></nav></header>
  <section className="tk-topic-recap-content">
   <div className="tk-topic-recap-heading"><div><span className="tk-topic-recap-eyebrow">本次学习已保存</span><h1>{state.course.title}</h1><p><time dateTime={state.endedAt??state.startedAt}>{date}</time> · {duration}</p></div><img src="/prototype-assets/pose-handoff.svg" alt="Teeko 老师"/></div>
   <div className="tk-topic-recap-grid">
    <section className="tk-topic-recap-card" aria-label="本次学习记录"><h2><BookOpen size={20}/>这次看过的内容</h2>{visited.length?<><ul>{visited.map(step=><li key={step.id}><Check size={16}/><span>{step.chinese||step.english}</span></li>)}</ul><p className="tk-topic-recap-note">根据课堂打开过的活动整理，不代表已经理解或掌握。</p></>:<p>这次还没有足够的学习记录。准备好时，可以重新选择一个主题开口聊聊。</p>}
     {summary.practice.length>0&&<><h3>想再聊时，可以从这里开始</h3><ul>{summary.practice.map(item=><li key={item.stepId}>{item.label}</li>)}</ul></>}
    </section>
    <section className="tk-topic-recap-card" aria-label="老师的表达建议"><h2>Teeko 给你的表达建议</h2><p className="tk-topic-recap-note">回看这次说过的话，以及当时整理出的表达参考。</p><ClassroomNotes classroomId={state.id} courseVersion={`${state.course.id}:${state.course.version}`}/></section>
   </div>
   <div className="tk-topic-recap-actions"><Link href="/topics" className="tk-submit">再选一个感兴趣的主题<ArrowRight size={18}/></Link><Link href="/topics/me">查看我的学习记录<ArrowRight size={16}/></Link></div>
  </section>
 </main>;
}
