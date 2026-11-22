'use client';

import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowLeft,ArrowRight,RefreshCw,Search} from 'lucide-react';
import {classroomJournalEventsResponseSchema,classroomJournalListResponseSchema,type ClassroomJournalClassroom,type ClassroomJournalEvent,type ClassroomJournalEvents,type ClassroomJournalList} from '../../lib/classroom-journal';
import {AccountRequestError,errorMessage} from '../product/account-request';
import {adminRequest} from './admin-request';
import {describeAudioContinuity} from '../../lib/classroom-audio-diagnostics';

type Filters={query:string;from:string;to:string};
type ReadEvents={id:string;after?:string;append:boolean};
const providerName={qwen:'通义',openai:'GPT Live',grok:'Grok Voice 3.0'};
const classroomStatus={preflight:'准备中',active:'上课中',paused:'已暂停',ended:'已结束'};
const actorName={child:'学生',teacher:'老师',application:'应用',provider:'语音服务'};
const eventStatus={recorded:'已记录',requested:'已请求',confirmed:'已确认',rejected:'已拒绝',failed:'失败'};
const eventNames:Record<string,string>={transcript:'说话',highlight_objects:'教材高亮',submit_spoken_answer:'回答检查',inspect_current_page:'教材检查',delegate:'教学委派',select:'点选',draw:'绘画',undo:'撤销笔迹',pause:'暂停',resume:'继续',end:'结束',skip:'跳过',next:'下一步',hint:'提示',create:'创建课堂',claim:'建立连接',release:'关闭连接','board.frame':'教材画面','vision.frame':'摄像头画面'};
Object.assign(eventNames,{annotation:'教材笔迹',classroom_created:'创建课堂',connection_started:'建立连接',provider_ready:'语音服务就绪',voice_connected:'课堂已连接',voice_closed:'课堂连接关闭',connection_released:'释放连接',classroom_ended:'课堂结束',lease_expired:'连接有效期结束',camera_state:'摄像头状态',board_state:'教材画面状态',board_commit:'本轮教材参考提交',unsupported_tool:'不支持的工具',interaction_apply:'互动处理',journal_gap:'日志记录缺口'});
const when=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
const duration=(seconds:number)=>`${Math.floor(seconds/60)} 分钟`;
const mergeEvents=(previous:ClassroomJournalEvent[],incoming:ClassroomJournalEvent[])=>[...new Map([...previous,...incoming].map(event=>[event.id,event])).values()].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0);

function EventDetails({event}:{event:ClassroomJournalEvent}){
 const detail=event.details;
 const values:[string,string|number|undefined][]=[['对象',detail.objectIds?.join('、')],['高亮对象',detail.highlighted?.join('、')],['问题',detail.question],['回答',detail.answer],['结果',detail.message],['结果状态',detail.resultStatus],['错误代码',detail.errorCode],['操作',detail.action],['笔迹数',detail.strokeCount],['点数',detail.pointCount],['连接代次',event.epoch],['题目序号',event.stepIndex+1],['状态修订',event.revision],['实际工具',detail.effectiveTool],['状态',detail.state]];
 return <details className="ta-journal-event-details"><summary>操作详情</summary>{detail.audioStats&&<p>{describeAudioContinuity(detail.audioStats)}。片间空档不等于已确认网络故障或实际听到断音。</p>}<dl>{values.filter(([,value])=>value!==undefined&&value!=='').map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>;
}

function JournalEvent({event}:{event:ClassroomJournalEvent}){
 return <li className={`ta-journal-event ta-journal-${event.kind}`} aria-label={`事件 ${event.id}`}>
  <div className="ta-journal-event-meta"><span className="ta-journal-actor">{actorName[event.actor]}</span><time dateTime={event.createdAt}>{when(event.createdAt)}</time><span className="ta-journal-event-state" data-status={event.status}>{eventStatus[event.status]}</span></div>
  <div className="ta-journal-event-content">{event.kind!=='utterance'&&<strong>{event.kind==='tool'?'工具 · ':''}{eventNames[event.name]??event.name}{event.kind==='tool'&&<code>{event.name}</code>}</strong>}{event.text&&<p>{event.text}</p>}{event.correlationId&&<small className="ta-journal-correlation">关联 {event.correlationId}</small>}{event.kind!=='utterance'&&<EventDetails event={event}/>}</div>
 </li>;
}

export function ClassroomJournal(){
 const [filters,setFilters]=useState<Filters>({query:'',from:'',to:''}),[applied,setApplied]=useState<Filters>({query:'',from:'',to:''}),[page,setPage]=useState(0),[attempt,setAttempt]=useState(0);
 const [list,setList]=useState<ClassroomJournalList|null>(null),[listLoading,setListLoading]=useState(true),[listError,setListError]=useState('');
 const [selected,setSelected]=useState<ClassroomJournalClassroom|null>(null),[detail,setDetail]=useState<ClassroomJournalEvents|null>(null),[detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState(''),[accessDenied,setAccessDenied]=useState(false);
 const selectedId=selected?.id,activeId=useRef<string|null>(null),requestVersion=useRef(0),detailController=useRef<AbortController|null>(null),lastRead=useRef<ReadEvents|null>(null),coverage=useRef<ClassroomJournalEvents['coverage']|null>(null),heading=useRef<HTMLHeadingElement|null>(null);
 const permissionFailure=useCallback((failure:unknown)=>{
  if(failure instanceof AccountRequestError&&(failure.status===401||failure.status===403)){setAccessDenied(true);setList(null);setDetail(null);return true;}return false;
 },[]);
 useEffect(()=>{
  if(selectedId||accessDenied)return;
  const controller=new AbortController();
  const query=new URLSearchParams({page:String(page),pageSize:'20'});if(applied.query)query.set('query',applied.query);if(applied.from)query.set('from',applied.from);if(applied.to)query.set('to',applied.to);
  adminRequest(`/classrooms?${query}`,classroomJournalListResponseSchema,{signal:controller.signal}).then(result=>{if(!controller.signal.aborted)setList(result);}).catch(failure=>{if(!controller.signal.aborted&&!permissionFailure(failure))setListError(errorMessage(failure));}).finally(()=>{if(!controller.signal.aborted)setListLoading(false);});
  return()=>controller.abort();
 },[selectedId,applied,page,attempt,accessDenied,permissionFailure]);
 const readEvents=useCallback((request:ReadEvents)=>{
  const version=++requestVersion.current;detailController.current?.abort();const controller=new AbortController();detailController.current=controller;lastRead.current=request;
  setDetailLoading(true);setDetailError('');const query=new URLSearchParams({limit:'100'});if(request.after)query.set('after',request.after);
  const current=()=>!controller.signal.aborted&&requestVersion.current===version&&activeId.current===request.id;
  void adminRequest(`/classrooms/${request.id}/events?${query}`,classroomJournalEventsResponseSchema,{signal:controller.signal}).then(async initial=>{
   if(!current())return;let result=initial,append=request.append;
   if(append&&coverage.current&&coverage.current!==result.coverage){
    lastRead.current={id:request.id,append:false};
    result=await adminRequest(`/classrooms/${request.id}/events?limit=100`,classroomJournalEventsResponseSchema,{signal:controller.signal});append=false;
   }
   if(!current())return;if(result.classroom.id!==request.id)throw new Error('课堂日志不匹配，请重试。');coverage.current=result.coverage;
   setDetail(previous=>({...result,events:append&&previous?.classroom.id===request.id?mergeEvents(previous.events,result.events):result.events}));
  }).catch(failure=>{if(current()&&!permissionFailure(failure))setDetailError(errorMessage(failure));}).finally(()=>{if(current())setDetailLoading(false);});
 },[permissionFailure]);
 useEffect(()=>{if(selectedId)heading.current?.focus();},[selectedId]);
 useEffect(()=>()=>{detailController.current?.abort();},[]);
 function open(value:ClassroomJournalClassroom){activeId.current=value.id;coverage.current=null;setDetail(null);setDetailError('');setSelected(value);readEvents({id:value.id,append:false});}
 function back(){activeId.current=null;coverage.current=null;requestVersion.current++;detailController.current?.abort();setSelected(null);setDetail(null);setDetailError('');setDetailLoading(false);setListLoading(true);setListError('');}
 function listPage(next:number){setListLoading(true);setListError('');setPage(next);}
 function submit(event:FormEvent){event.preventDefault();if(filters.from&&filters.to&&filters.from>filters.to){setListError('开始日期不能晚于结束日期。');return;}setListLoading(true);setListError('');setPage(0);setApplied({...filters,query:filters.query.trim()});}
 if(accessDenied)return <section className="ta-section ta-journal"><div className="ta-journal-empty"><p role="alert">当前没有查看课堂日志的权限，请重新登录管理后台。</p><a href="/admin/login">返回管理登录</a></div></section>;
 if(selected){const classroom=detail?.classroom??selected;const missingLegacyTeacher=detail?.coverage==='legacy_transcripts'&&!detail.nextCursor&&detail.events.length>=classroom.eventCount&&detail.events.some(event=>event.kind==='utterance'&&event.actor==='child')&&!detail.events.some(event=>event.kind==='utterance'&&event.actor==='teacher'&&event.text?.trim());return <section className="ta-section ta-journal" aria-label="课堂日志详情">
  <div className="ta-journal-heading"><button type="button" onClick={back}><ArrowLeft size={16}/>返回课堂列表</button><button type="button" disabled={detailLoading} onClick={()=>readEvents({id:selected.id,after:detail?.events.at(-1)?.id,append:true})}><RefreshCw size={16}/>刷新课堂日志</button></div>
  <header className="ta-journal-classroom"><div><h2 ref={heading} tabIndex={-1}>{classroom.childName} · {classroom.courseTitle}</h2><p>{classroom.email}</p></div><span className="ta-chip">{classroomStatus[classroom.status]}</span><dl><div><dt>开始</dt><dd>{when(classroom.startedAt)}</dd></div><div><dt>课堂时长</dt><dd>{duration(classroom.elapsedSeconds)}</dd></div><div><dt>服务</dt><dd>{providerName[classroom.provider]}</dd></div>{classroom.agentName&&<div><dt>智能体</dt><dd>{classroom.agentName}{classroom.agentVersion!==null?` v${classroom.agentVersion}`:''}</dd></div>}{classroom.model&&<div><dt>实时模型</dt><dd>{classroom.model}</dd></div>}</dl></header>
  <p className="ta-journal-note">完整互动日志从本次更新起记录；更早历史可能不完整。老师文字是生成转写，不代表孩子已听完；图片状态不代表识别正确。</p>
  {detail?.coverage==='legacy_transcripts'&&<p className="ta-journal-legacy" role="status">{missingLegacyTeacher?'这节历史课堂没有保留老师回答，无法补回；仅显示现有学生转写。':'仅保留部分历史转写，互动和工具记录从日志功能启用后开始。'}</p>}
  {detailError&&<div className="ta-journal-error"><p className="ta-error" role="alert">{detailError}</p><button type="button" disabled={detailLoading} onClick={()=>{if(lastRead.current)readEvents(lastRead.current);}}>重试读取日志</button></div>}
  {detailLoading&&<p className="ta-journal-loading" role="status">正在读取课堂日志…</p>}
  {!!detail?.events.length&&<ol className="ta-journal-timeline" aria-label="课堂事件时间线">{detail.events.map(event=><JournalEvent key={event.id} event={event}/>)}</ol>}
  {detail&&!detail.events.length&&!detailLoading&&!detailError&&<p className="ta-journal-empty">{detail.coverage==='none'?'这节课堂没有可查看的日志。':'还没有新的事件。'}</p>}
  {detail?.nextCursor&&<div className="ta-journal-pagination"><button type="button" disabled={detailLoading} onClick={()=>readEvents({id:selected.id,after:detail.nextCursor!,append:true})}>加载更多事件<ArrowRight size={16}/></button></div>}
 </section>;}
 return <section className="ta-section ta-journal" aria-label="课堂日志列表">
  <form className="ta-journal-filters" onSubmit={submit}><label>邮箱或孩子昵称<input value={filters.query} maxLength={100} onChange={event=>setFilters(current=>({...current,query:event.target.value}))}/></label><label>开始日期<input type="date" value={filters.from} onChange={event=>setFilters(current=>({...current,from:event.target.value}))}/></label><label>结束日期<input type="date" value={filters.to} onChange={event=>setFilters(current=>({...current,to:event.target.value}))}/></label><button type="submit" disabled={listLoading}><Search size={16}/>查询日志</button></form>
  {listError&&<div className="ta-journal-error"><p className="ta-error" role="alert">{listError}</p><button type="button" disabled={listLoading} onClick={()=>{setListLoading(true);setListError('');setAttempt(value=>value+1);}}>重试读取日志</button></div>}
  {listLoading&&<p className="ta-journal-loading" role="status">正在读取课堂日志…</p>}
  {list&&!!list.classrooms.length&&<><p className="ta-journal-count">共 {list.total} 节课堂 · 北京时间</p><div className="ta-journal-table-wrap" tabIndex={0} aria-label="课堂列表，可横向滚动"><table className="ta-journal-table"><thead><tr><th scope="col">用户</th><th scope="col">课程</th><th scope="col">服务 / 状态</th><th scope="col">开始时间</th><th scope="col">时长</th><th scope="col">操作</th></tr></thead><tbody>{list.classrooms.map(item=><tr key={item.id}><td><strong>{item.childName}</strong><small>{item.email}</small></td><td>{item.courseTitle}</td><td>{providerName[item.provider]}<small>{classroomStatus[item.status]}</small></td><td><time dateTime={item.startedAt}>{when(item.startedAt)}</time></td><td>{duration(item.elapsedSeconds)}</td><td><button type="button" aria-label={`查看 ${item.childName} 的课堂日志`} onClick={()=>open(item)}>查看<ArrowRight size={15}/></button></td></tr>)}</tbody></table></div><div className="ta-journal-pagination"><span>第 {page+1} / {Math.max(1,Math.ceil(list.total/list.pageSize))} 页</span><button type="button" aria-label="上一页课堂" disabled={listLoading||page===0} onClick={()=>listPage(Math.max(0,page-1))}><ArrowLeft size={16}/>上一页</button><button type="button" aria-label="下一页课堂" disabled={listLoading||(page+1)*list.pageSize>=list.total} onClick={()=>listPage(page+1)}>下一页<ArrowRight size={16}/></button></div></>}
  {list&&!list.classrooms.length&&!listLoading&&!listError&&<p className="ta-journal-empty">没有符合条件的课堂。</p>}
 </section>;
}
