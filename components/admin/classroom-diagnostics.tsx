'use client';

import {useCallback,useEffect,useMemo,useRef,useState,type FormEvent} from 'react';
import {ArrowLeft,ArrowRight,Copy,Pause,Play,RefreshCw,Search} from 'lucide-react';
import {sanitizeClassroomJournalText,classroomJournalEventsResponseSchema,classroomJournalListResponseSchema,type ClassroomJournalEvent,type ClassroomJournalEvents,type ClassroomJournalList} from '../../lib/classroom-journal';
import {formatClassroomDiagnosticId,formatPersistentEventDiagnosticId} from '../../lib/classroom-diagnostic-id';
import {projectClassroomDiagnostics,exportClassroomDiagnostics,isDiagnosticAnomaly,type DiagnosticEvent} from '../../lib/classroom-diagnostics';
import {buildClassroomTimeline,describeClassroomProgress} from '../../lib/classroom-timeline';
import {ClassroomTimeline} from './classroom-timeline';
import {describeAudioContinuity} from '../../lib/classroom-audio-diagnostics';
import {AccountRequestError} from '../product/account-request';
import {adminLoginHref} from '../../lib/admin-return-target';
import {adminRequest} from './admin-request';

const MAX_EVENTS=1000;
const providerName={qwen:'通义',openai:'GPT Live',grok:'Grok Voice 3.0'};
const actorName={child:'学生',teacher:'老师',application:'应用',provider:'语音服务'};
const statusName={recorded:'已记录',requested:'已请求',confirmed:'已确认',rejected:'已拒绝',failed:'失败'};
const when=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
const anomaly=isDiagnosticAnomaly;
const merge=(previous:ClassroomJournalEvent[],incoming:ClassroomJournalEvent[])=>[...new Map([...previous,...incoming].map(event=>[event.id,event])).values()].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0);
type Filters={query:string;from:string;to:string};
type Props={classroomId?:string;eventId?:string;refreshIntervalMs?:number};
type DiagnosticIdKind='课堂日志'|'事件';

function EventCard({event,target,classroomId,coverage,onCopyId,showText=true,business}:{event:DiagnosticEvent;target:boolean;classroomId:string;coverage:ClassroomJournalEvents['coverage'];onCopyId:(value:string,kind:DiagnosticIdKind)=>Promise<void>;showText?:boolean;business?:ClassroomJournalEvent['details']}){
 const diagnosticId=formatPersistentEventDiagnosticId({classroomId,eventId:event.id},coverage);
 const diagnosticFacts:[string,string|number|undefined][]=[
  ['恢复阶段',event.recoveryState?{checking:'核验中',configuration_verified:'配置已核验',audio_verified:'语音链路已核验',recovered:'已恢复',failed:'恢复失败'}[event.recoveryState]:undefined],
  ['服务错误处理',event.providerErrorAction?{recovery_check:'正在核验连接（尚未确认恢复）',retained_idle:'保留空闲连接',stopped:'停止连接'}[event.providerErrorAction]:undefined],
  ['点选ID',event.pointId],['点选阶段',event.pointStage],['点选原因',event.pointReason],['客户端诊断版本',event.clientDiagnosticsVersion],['客户端点选版本',event.clientPointVersion],
  ['服务错误类型',event.providerErrorType],['服务错误分类',event.providerErrorReason],['服务错误代码类别',event.providerErrorCode],['错误字段类别',event.providerErrorCodeKind],['错误字段形态',event.providerErrorCodeShape],
  ['错误代码指纹',event.providerErrorCodeFingerprint],['错误消息指纹',event.providerErrorMessageFingerprint],['技术类别',event.providerErrorMessageCategories?.join('、')],['错误参数类别',event.providerErrorParam],['请求关联',event.requestCorrelation],['请求类型',event.requestType],['应用请求ID',event.requestId],
 ];
 const businessFacts=business?[
  ['请求对象',business.objectIds?.join('、')],['已标记对象',business.highlighted?.join('、')],['动作',business.action],['应用结果',business.resultStatus],
  ['请求内容',business.question??business.answer],['结果说明',business.message],['笔迹条数',business.strokeCount],['笔迹点数',business.pointCount],
 ] .filter(([,value])=>value!==undefined&&value!=='').map(([label,value])=>[label,sanitizeClassroomJournalText(String(value),1000)]):[];
 return <li id={`diagnostic-event-${event.id}`} tabIndex={-1} className="td-event" data-anomaly={anomaly(event)} data-target={target} aria-label={`事件 ${event.id}`}>
  <header><strong>{actorName[event.actor]}</strong><span>{event.name}</span><span className="ta-chip">{statusName[event.status]}</span><a href={`/admin/diagnostics?classroomId=${classroomId}&eventId=${event.id}`} aria-label={`事件 ${event.id} 的定位链接`}>#{event.id}</a>{diagnosticId&&<button type="button" aria-label={`复制事件 ${event.id} 的排查ID`} onClick={()=>{void onCopyId(diagnosticId,'事件');}}><Copy size={14}/>复制ID</button>}</header>
  {showText&&event.text&&<p className="td-utterance">{event.text}</p>}
  <div className="td-tags"><time dateTime={event.createdAt}>{when(event.createdAt)} · 记录时间</time><span>{event.clock==='server'?'服务端时钟':event.clock==='client'?'客户端时钟':'时钟未采集'}</span><span>{event.playback==='client_reported'?'客户端报告播放（未独立核验）':event.playback==='generated'||(event.kind==='utterance'&&event.actor==='teacher')?'生成文字（不代表已播放）':event.source?`来源：${event.source}`:'来源未采集'}</span></div>
  {event.audioStats&&<p className="td-note">{describeAudioContinuity(event.audioStats)}。这是本端排程与传输观察，不等于已确认网络故障或实际听到断音。</p>}
  <dl className="td-event-facts"><div><dt>阶段</dt><dd>{event.pointStage??event.latencyStage??event.phase??'未采集'}</dd></div><div><dt>本端耗时</dt><dd>{event.elapsedMs===null?'未采集':`${event.elapsedMs} ms`}</dd></div><div><dt>排队</dt><dd>{event.queueMs===null?'未采集':`${event.queueMs} ms`}</dd></div><div><dt>往返</dt><dd>{event.rttMs===null?'未采集':`${event.rttMs} ms`}</dd></div><div><dt>故障码</dt><dd>{event.errorCode??'未采集'}</dd></div><div><dt>状态</dt><dd>{event.state??'未采集'}</dd></div><div><dt>连接 / 题目</dt><dd>{event.epoch} / {event.stepIndex+1}</dd></div></dl>
  {diagnosticFacts.some(([,value])=>value!==undefined&&value!=='')&&<dl className="td-business-facts">{diagnosticFacts.filter(([,value])=>value!==undefined&&value!=='').map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
  {!!businessFacts.length&&<dl className="td-business-facts">{businessFacts.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
  {(diagnosticId||event.turnId||event.spanId||event.correlationId)&&<details><summary>关联标识</summary><p>{diagnosticId&&<>事件排查ID：<code>{diagnosticId}</code><br/></>}话轮：{event.turnId??'未采集'}<br/>片段：{event.spanId??'未采集'}<br/>工具：{event.correlationId??'未采集'}</p></details>}
 </li>;
}

export function ClassroomDiagnostics(props:Props={}){return <DiagnosticsSession key={`${props.classroomId??''}:${props.eventId??''}`} {...props}/>;}

function DiagnosticsSession({classroomId,eventId,refreshIntervalMs=5000}:Props){
 const [selected,setSelected]=useState(classroomId??''),[filters,setFilters]=useState<Filters>({query:'',from:'',to:''}),[applied,setApplied]=useState<Filters>({query:'',from:'',to:''}),[page,setPage]=useState(0),[attempt,setAttempt]=useState(0);
 const [list,setList]=useState<ClassroomJournalList|null>(null),[detail,setDetail]=useState<ClassroomJournalEvents|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[denied,setDenied]=useState(false),[automatic,setAutomatic]=useState(true),[view,setView]=useState<'timeline'|'turns'|'events'>('timeline'),[onlyAnomalies,setOnlyAnomalies]=useState(false),[target,setTarget]=useState(eventId??''),[notice,setNotice]=useState(''),[capped,setCapped]=useState(false),[windowed,setWindowed]=useState(false);
 const [locateVersion,setLocateVersion]=useState(0);
 const [now,setNow]=useState(()=>Date.now()),[visible,setVisible]=useState(()=>typeof document==='undefined'||document.visibilityState!=='hidden');
 const activeId=useRef(selected),controller=useRef<AbortController|null>(null),locked=useRef(false),requestVersion=useRef(0),detailRef=useRef<ClassroomJournalEvents|null>(null),lastRequest=useRef<{append:boolean;after?:string}>({append:false}),heading=useRef<HTMLHeadingElement>(null),focusedTarget=useRef('');
 const loginHref=adminLoginHref(`/admin/diagnostics${selected?`?classroomId=${selected}${target?`&eventId=${target}`:''}`:''}`);
 const failure=useCallback((value:unknown)=>{
  if(value instanceof AccountRequestError&&(value.status===401||value.status===403)){setDenied(true);setAutomatic(false);setDetail(null);detailRef.current=null;setList(null);setError('登录已失效或没有管理权限，请重新登录管理后台。');}
  else setError('课堂记录读取失败，请重试。');
 },[]);
 const read=useCallback(async(append=false,after?:string)=>{
  if(locked.current||!activeId.current)return;const id=activeId.current,version=++requestVersion.current,request=new AbortController();controller.current=request;locked.current=true;lastRequest.current={append,after};
  const current=()=>!request.signal.aborted&&requestVersion.current===version&&activeId.current===id;
  try{
   const query=new URLSearchParams({limit:'100'}),previous=detailRef.current;if(after)query.set('after',after);else if(append&&previous?.events.length)query.set('after',previous.events.at(-1)!.id);
   let result=await adminRequest(`/classrooms/${id}/events?${query}`,classroomJournalEventsResponseSchema,{signal:request.signal});
   if(!current())return;
   if(result.classroom.id!==id)throw new Error('Classroom mismatch');
   let combining=append&&previous?.classroom.id===id;
   if(combining&&previous!.coverage!==result.coverage){result=await adminRequest(`/classrooms/${id}/events?limit=100`,classroomJournalEventsResponseSchema,{signal:request.signal});combining=false;if(!current())return;if(result.classroom.id!==id)throw new Error('Classroom mismatch');}
   const events=combining?merge(previous!.events,result.events):result.events;
   if(events.length>=MAX_EVENTS){setAutomatic(false);setCapped(true);setNotice(`已达到本页 ${MAX_EVENTS} 条事件上限；复制仅含已加载范围。可继续读取下一段事件。`);}
   const next={...result,events:events.slice(0,MAX_EVENTS)};detailRef.current=next;setDetail(next);setNow(Date.now());
  }catch(value){if(current()){setAutomatic(false);failure(value);}}
  finally{if(current()){locked.current=false;setLoading(false);}}
 },[failure]);
 const startRead=useCallback((append:boolean,after?:string)=>{if(locked.current)return;setLoading(true);setError('');void read(append,after);},[read]);
 useEffect(()=>{
  activeId.current=selected;
  // Initial loading is already set; read commits state only after awaiting the admin response.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  if(selected){void read(false);heading.current?.focus();}return()=>{controller.current?.abort();locked.current=false;};
 },[selected,read]);
 useEffect(()=>{
  if(selected||denied)return;const request=new AbortController(),query=new URLSearchParams({page:String(page),pageSize:'20'});if(applied.query)query.set('query',applied.query);if(applied.from)query.set('from',applied.from);if(applied.to)query.set('to',applied.to);
  adminRequest(`/classrooms?${query}`,classroomJournalListResponseSchema,{signal:request.signal}).then(result=>{if(!request.signal.aborted)setList(result);}).catch(value=>{if(!request.signal.aborted)failure(value);}).finally(()=>{if(!request.signal.aborted)setLoading(false);});return()=>request.abort();
 },[selected,denied,page,applied,attempt,failure]);
 useEffect(()=>{
  if(!selected||!automatic||denied||capped)return;
  const timer=setInterval(()=>{if(document.visibilityState!=='hidden'&&detailRef.current&&!locked.current)startRead(true);},Math.max(25,refreshIntervalMs));return()=>clearInterval(timer);
 },[selected,automatic,denied,capped,startRead,refreshIntervalMs]);
 useEffect(()=>{if(!selected)return;const timer=setInterval(()=>setNow(Date.now()),1000);const visibility=()=>{setVisible(document.visibilityState!=='hidden');setNow(Date.now());};document.addEventListener('visibilitychange',visibility);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visibility);};},[selected]);
 const classroomDiagnosticId=detail?formatClassroomDiagnosticId({classroomId:detail.classroom.id}):null;
 const projection=useMemo(()=>projectClassroomDiagnostics(detail?.events??[],{coverage:detail?.coverage??'none',complete:!!detail&&!detail.nextCursor&&!capped&&!windowed,totalEventCount:detail?.classroom.eventCount}),[detail,capped,windowed]);
 const timeline=useMemo(()=>buildClassroomTimeline(detail?.events??[]),[detail]);
 const recordedProgress=detail?describeClassroomProgress(detail.events,{status:detail.classroom.status,now,complete:projection.coverage.complete}):null;
 const progress=recordedProgress&&(error?{...recordedProgress,title:'读取中断，当前进展无法确认',detail:`仅保留上次读取的记录。${recordedProgress.detail}`,tone:'warning' as const}:!automatic?{...recordedProgress,title:'记录更新已暂停',detail:`恢复更新后再确认当前进展。最近记录：${recordedProgress.title}`,tone:'neutral' as const}:!visible?{...recordedProgress,title:'页面未更新，当前进展无法确认',detail:'页面隐藏时暂停读取；显示的仍是上次记录。',tone:'neutral' as const}:recordedProgress);
 const rawById=useMemo(()=>new Map((detail?.events??[]).map(event=>[event.id,event])),[detail]);
 const diagnosticById=useMemo(()=>new Map(projection.events.map(event=>[event.id,event])),[projection]);
 const effectiveView=view==='timeline'&&target&&projection.events.some(event=>event.id===target)&&!timeline.some(item=>item.eventIds.includes(target))?'events':view;
 useEffect(()=>{if(!target||focusedTarget.current===target||!projection.events.some(event=>event.id===target))return;const element=document.getElementById(`diagnostic-event-${target}`);if(element){for(let parent=element.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')(parent as HTMLDetailsElement).open=true;focusedTarget.current=target;element.focus();element.scrollIntoView?.({block:'nearest'});}},[target,projection,effectiveView,onlyAnomalies,locateVersion]);
 function locate(){const first=projection.firstAnomaly;if(first){focusedTarget.current='';setOnlyAnomalies(false);setView(timeline.some(item=>item.eventIds.includes(first.id))?'timeline':'events');setTarget(first.id);setLocateVersion(value=>value+1);document.getElementById(`diagnostic-event-${first.id}`)?.focus();}}
 function changeClassroom(id:string){setView('timeline');setOnlyAnomalies(false);controller.current?.abort();locked.current=false;detailRef.current=null;setDetail(null);setError('');setNotice('');setCapped(false);setWindowed(false);setAutomatic(true);setLoading(true);setTarget('');setSelected(id);}
 function listPage(value:number){setLoading(true);setError('');setPage(value);}
 function submit(event:FormEvent){event.preventDefault();if(filters.from&&filters.to&&filters.from>filters.to){setError('开始日期不能晚于结束日期。');return;}setLoading(true);setError('');setPage(0);setApplied({...filters,query:filters.query.trim()});}
 async function copyId(value:string,kind:DiagnosticIdKind){
  const scope=activeId.current;
  try{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText(value);if(activeId.current===scope)setNotice(`已复制${kind}ID：${value}`);}
  catch{if(activeId.current===scope)setNotice(`复制未成功，请手动复制：${value}`);}
 }
 async function copy(){if(!detail)return;const scope=activeId.current;try{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText(JSON.stringify(exportClassroomDiagnostics(projection,detail.classroom.id),null,2));if(activeId.current===scope)setNotice('已复制脱敏排查包，仅含已加载诊断元数据，不含对话正文或账号资料。');}catch{if(activeId.current===scope)setNotice('复制失败，请允许浏览器访问剪贴板后重试。');}}
 if(denied)return <section className="ta-section td-diagnostics"><p className="ta-error" role="alert">{error}</p><a href={loginHref}>重新登录管理后台</a></section>;
 return <section className="ta-section td-diagnostics" aria-label="课堂排查台">
  {selected?<>
   <header className="td-heading"><div><h2 ref={heading} tabIndex={-1}>{detail?`${detail.classroom.childName} · ${detail.classroom.courseTitle}`:'课堂排查'}</h2><p>{detail?`${providerName[detail.classroom.provider]}${detail.classroom.agentName?` · ${detail.classroom.agentName}`:''}`:''}</p></div>
    <div className="td-header-actions"><button type="button" onClick={()=>changeClassroom('')}><ArrowLeft size={16}/>课堂列表</button><button type="button" disabled={loading||capped} onClick={()=>startRead(true)}><RefreshCw size={16}/>刷新事件</button><button type="button" disabled={capped} onClick={()=>setAutomatic(value=>!value)}>{automatic?<Pause size={16}/>:<Play size={16}/>} {automatic?'暂停自动刷新':'恢复自动刷新'}</button>{classroomDiagnosticId&&<button type="button" onClick={()=>{void copyId(classroomDiagnosticId,'课堂日志');}}><Copy size={15}/>复制课堂日志ID</button>}</div>
   </header>
   {progress&&<section className="td-progress" data-tone={progress.tone} aria-label="最近进展"><span>最近进展</span><strong>{progress.title}</strong><p>{progress.detail}</p></section>}
   <details className="td-classroom-details"><summary>课堂信息与日志ID</summary>
    {detail&&<p>{detail.classroom.email} · {detail.classroom.model??'模型未采集'}{detail.classroom.agentVersion!==null?` · 教师版本 ${detail.classroom.agentVersion}`:''}</p>}
    {classroomDiagnosticId&&<div className="td-log-reference"><span>课堂日志ID</span><code>{classroomDiagnosticId}</code></div>}
    <p className="td-note">老师文字是生成记录；播放信息来自设备报告，不能证明实际听见。图片状态不代表识别正确。</p>
    {detail?.coverage==='legacy_transcripts'&&<p className="td-note">历史转写没有稳定的事件ID，可复制课堂日志ID定位。</p>}
    {detail&&<div className="td-coverage">仅含已加载 {projection.coverage.loadedEventCount} / {detail.classroom.eventCount} 条 · {projection.coverage.complete?'当前已读取到底':'覆盖不完整'} · {detail.coverage==='legacy_transcripts'?'仅部分历史转写，互动与工具未完整采集':detail.coverage==='none'?'未采集课堂日志':'课堂事件日志'}<br/>事件范围 {projection.coverage.firstEventId??'无'} — {projection.coverage.lastEventId??'无'}；没有明确关联标识的事件不按时间邻近合并。</div>}
   </details>
   <div className="td-toolbar td-view-toolbar"><label className="td-checkbox"><input type="checkbox" checked={onlyAnomalies} onChange={event=>setOnlyAnomalies(event.target.checked)}/>仅看异常</label><button type="button" disabled={!projection.firstAnomaly} onClick={locate}>定位首个异常</button><button type="button" aria-pressed={effectiveView!=='timeline'} onClick={()=>{setTarget('');setView(effectiveView==='timeline'?'events':'timeline');}}>{effectiveView==='timeline'?'技术详情':'返回时间轴'}</button><span className="td-refresh-state">{automatic?'每 5 秒更新':'自动刷新已暂停'}</span></div>
   {target&&!projection.events.some(event=>event.id===target)&&detail&&<p className="td-gap" role="status">目标事件尚未加载：#{target}。{detail.nextCursor?'请加载更多事件继续定位。':'当前覆盖范围内未找到该事件，可能未采集或不属于本课。'}</p>}
   {effectiveView==='timeline'?<>
    <p className="td-timeline-caption">课堂时间轴 · 左侧为距开课时间；每轮等待从本机停声算到老师有声播放，展开查看已测分段。</p>
    <ClassroomTimeline items={timeline.filter(item=>!onlyAnomalies||item.severity!=='normal')} startedAt={detail?.classroom.startedAt??''} target={target} locationVersion={locateVersion} renderEvent={id=>{const event=diagnosticById.get(id);return event?<EventCard key={id} event={event} target={target===id} classroomId={selected} coverage={detail?.coverage??'none'} onCopyId={copyId} business={rawById.get(id)?.details} showText={false}/>:null;}}/>
    {detail?.events.length&&!timeline.length?<p className="td-empty">当前只有技术记录，可打开技术详情查看。</p>:null}
   </>:<>
    <div className="td-toolbar"><div className="ta-segments" aria-label="技术事件视图"><button type="button" aria-pressed={effectiveView==='turns'} onClick={()=>setView('turns')}>按话轮</button><button type="button" aria-pressed={effectiveView==='events'} onClick={()=>setView('events')}>完整事件</button></div><button type="button" disabled={!detail?.events.length} onClick={()=>{void copy();}}><Copy size={16}/>复制脱敏排查包</button></div>
    <p className="td-note">分段耗时只使用本端时钟；缺失时未采集，不跨设备相减。</p>
    {effectiveView==='events'?<ol className="td-events" aria-label="完整课堂事件">{projection.events.filter(event=>!onlyAnomalies||anomaly(event)).map(event=><EventCard key={event.id} event={event} target={target===event.id} classroomId={selected} coverage={detail?.coverage??'none'} onCopyId={copyId} business={rawById.get(event.id)?.details}/>)}</ol>:<div className="td-turns" aria-label="明确关联的话轮">{projection.turns.filter(turn=>!onlyAnomalies||turn.events.some(anomaly)).map(turn=><section className="td-turn" key={turn.id}><h3>{turn.association==='measurement'?'本轮时延':turn.association==='turn'?'话轮':turn.association==='span'?'片段':turn.association==='correlation'?'工具关联':'未关联事件'} <code>{turn.association==='unknown'?'关联未采集':turn.id}</code></h3><ol className="td-events">{turn.events.filter(event=>!onlyAnomalies||anomaly(event)).map(event=><EventCard key={event.id} event={event} target={target===event.id} classroomId={selected} coverage={detail?.coverage??'none'} onCopyId={copyId} business={rawById.get(event.id)?.details}/>)}</ol></section>)}</div>}
   </>}
   {detail&&!detail.events.length&&!loading&&!error&&<p className="td-empty">这节课堂没有可查看的日志。</p>}{onlyAnomalies&&detail?.events.length&&!projection.events.some(anomaly)?<p className="td-empty">已加载范围内没有记录到异常。</p>:null}
   {detail?.nextCursor&&!capped&&<button type="button" disabled={loading} onClick={()=>startRead(true)}>加载更多事件<ArrowRight size={16}/></button>}
   {capped&&<div className="td-toolbar">{detail?.nextCursor&&<button type="button" disabled={loading} onClick={()=>{setWindowed(true);setCapped(false);setNotice('仅查看后续事件窗口，之前的事件不包含在当前复制包中。');startRead(false,detail.events.at(-1)?.id);}}>读取下一段事件<ArrowRight size={16}/></button>}<button type="button" disabled={loading} onClick={()=>{setWindowed(false);setCapped(false);setNotice('');startRead(false);}}>重新读取前 100 条</button></div>}
  </>:<>
   <form className="td-filters" onSubmit={submit}><label>邮箱或孩子昵称<input maxLength={100} value={filters.query} onChange={event=>setFilters(value=>({...value,query:event.target.value}))}/></label><label>开始日期<input type="date" value={filters.from} onChange={event=>setFilters(value=>({...value,from:event.target.value}))}/></label><label>结束日期<input type="date" value={filters.to} onChange={event=>setFilters(value=>({...value,to:event.target.value}))}/></label><button type="submit" disabled={loading}><Search size={16}/>查询课堂</button></form>
   {list?.classrooms.length?<><p className="td-note">共 {list.total} 节课堂 · 北京时间</p><ul className="td-classrooms">{list.classrooms.map(item=><li key={item.id}><div><strong>{item.childName} · {item.courseTitle}</strong><small>{item.email}</small><small>{providerName[item.provider]} · {when(item.startedAt)} · {item.eventCount} 条记录</small></div><div className="td-classroom-actions"><button type="button" aria-label={`复制 ${item.childName} 的课堂日志ID`} title={formatClassroomDiagnosticId({classroomId:item.id})} onClick={()=>{void copyId(formatClassroomDiagnosticId({classroomId:item.id}),'课堂日志');}}><Copy size={15}/>复制ID</button><button type="button" aria-label={`排查 ${item.childName} 的课堂`} onClick={()=>changeClassroom(item.id)}>排查<ArrowRight size={16}/></button></div></li>)}</ul><div className="td-toolbar"><span>第 {page+1} 页</span><button type="button" aria-label="上一页课堂" disabled={loading||page===0} onClick={()=>listPage(Math.max(0,page-1))}>上一页</button><button type="button" aria-label="下一页课堂" disabled={loading||(page+1)*list.pageSize>=list.total} onClick={()=>listPage(page+1)}>下一页</button></div></>:list&&!loading&&!error&&<p className="td-empty">没有符合条件的课堂。</p>}
  </>}
  {loading&&<p role="status">{selected?'正在读取课堂事件…':'正在读取课堂列表…'}</p>}
  {error&&<div className="td-error"><p role="alert" className="ta-error">{error}</p><button type="button" disabled={loading} onClick={()=>{if(selected)startRead(lastRequest.current.append,lastRequest.current.after);else{setLoading(true);setError('');setAttempt(value=>value+1);}}}>重试读取</button></div>}
  {notice&&<p className="td-coverage" role="status">{notice}</p>}
 </section>;
}
