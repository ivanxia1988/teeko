'use client';

import {useState,type ReactNode} from 'react';
import type {ClassroomTimelineItem} from '../../lib/classroom-timeline';
import {formatLatency} from '../../lib/classroom-latency-view';

const relativeTime=(value:string,start:string)=>{
 const seconds=Math.floor((Date.parse(value)-Date.parse(start))/1000);
 if(!Number.isFinite(seconds)||seconds<0)return new Date(value).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
};

function TimelineRow({item,startedAt,target,renderEvent}:{item:ClassroomTimelineItem;startedAt:string;target:string;renderEvent:(id:string)=>ReactNode}){
 const [expanded,setExpanded]=useState(()=>!!target&&item.eventIds.includes(target));
 const speech=item.category==='child'&&!item.events.some(event=>event.kind==='utterance'&&event.details.source==='typed');
 return <li className="td-timeline-item" data-category={item.category} data-severity={item.severity} data-target={item.eventIds.includes(target)}>
  <time dateTime={item.at} title={new Date(item.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}>{relativeTime(item.at,startedAt)}</time>
  <details className="td-timeline-content" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
   <summary className="td-timeline-summary">
    <span className="td-timeline-copy"><span className="td-timeline-title"><strong>{item.title}</strong>{item.severity!=='normal'&&<span>{item.severity==='error'?'异常':'需留意'}</span>}</span>
     {item.text&&<span className="td-timeline-text">{item.text}</span>}
     {(item.latency||speech)&&<span className="td-latency-primary" data-state={item.latency?.status??'unmeasured'}>{item.latency?.summary??'时延未测得'}</span>}
     {item.note&&<span className="td-timeline-note">{item.note}</span>}
    </span><span className="td-detail-hint">详情</span>
   </summary>
   {expanded&&<>
    {(item.latency||speech)&&<section className="td-latency-detail" aria-label="本轮时延分段">
     <p>{item.latency?.detail??'这节记录没有完整的本机停声到有声播放测量；更新后的新课堂可采集。'}</p>
     {!!item.latency?.segments.length&&<dl>{item.latency.segments.map(segment=><div key={segment.id}><dt>{segment.label}</dt><dd>{formatLatency(segment.ms)}<small>{segment.clock==='client'?'浏览器测量':'服务端测量'}</small></dd></div>)}</dl>}
    </section>}
    <ol className="td-events" aria-label={`${item.title}的详细记录`}>{item.eventIds.map(id=>renderEvent(id))}</ol>
   </>}
  </details>
 </li>;
}

export function ClassroomTimeline({items,startedAt,target,locationVersion=0,renderEvent}:{items:ClassroomTimelineItem[];startedAt:string;target:string;locationVersion?:number;renderEvent:(id:string)=>ReactNode}){
 return <ol className="td-timeline" aria-label="课堂时间轴">{items.map(item=><TimelineRow key={`${item.id}:${item.eventIds.includes(target)?`${target}:${locationVersion}`:''}`} item={item} startedAt={startedAt} target={target} renderEvent={renderEvent}/>)}</ol>;
}
