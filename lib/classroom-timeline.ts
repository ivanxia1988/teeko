import {projectClassroomLatency,type ClassroomLatencySummary} from './classroom-latency-view';
import {sanitizeClassroomJournalEntry,type ClassroomJournalEvent} from './classroom-journal';
import {CLASSROOM_POINT_CLIENT_STAGES,type ClassroomPointStage} from './classroom-point-diagnostics';
import {audioContinuityHasGap,describeAudioContinuity} from './classroom-audio-diagnostics';

export type ClassroomTimelineItem={id:string;eventIds:string[];at:string;category:'child'|'teacher'|'action'|'visual'|'connection'|'issue';title:string;text:string|null;note:string|null;severity:'normal'|'warning'|'error';events:ClassroomJournalEvent[];latency?:ClassroomLatencySummary};
export type ClassroomProgress={title:string;detail:string;tone:'neutral'|'warning'|'error';at:string|null};
type ProgressOptions={status:'preflight'|'active'|'paused'|'ended';now:number;complete:boolean};
type Identity={correlation:string|null;span:string|null;turn:string|null};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const internalTools=new Set(['delegate','submit_spoken_answer']);
const technicalNames=new Set(['diagnostic_phase','diagnostic_association','assessment_phase','heartbeat','board_commit','provider_ready','voice_response_cancel_ack','connection_released']);
const isIssue=(event:ClassroomJournalEvent)=>event.status==='failed'||event.status==='rejected'||event.details.phase==='error'||event.details.phase==='input_failed'||event.name==='journal_gap';
const severity=(events:readonly ClassroomJournalEvent[]):ClassroomTimelineItem['severity']=>events.some(e=>e.status==='failed'||e.details.phase==='error'||e.details.phase==='input_failed'||e.name==='journal_gap')?'error':events.some(e=>e.status==='rejected')?'warning':'normal';
const last=<T>(values:readonly T[])=>values.at(-1)!;
const validId=(value:string|undefined)=>value&&uuid.test(value)?value.toLowerCase():null;
const correlation=(value:string|null)=>value&&!value.includes('[已隐藏]')?value:null;
const mic='麦克风状态未记录。';

function safeEvents(input:readonly ClassroomJournalEvent[]):ClassroomJournalEvent[]{
 const seen=new Set<string>();
 return [...input].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0).filter(event=>!seen.has(event.id)&&!!seen.add(event.id)).map(event=>{
  const clean=sanitizeClassroomJournalEntry({eventKey:'timeline-read',kind:event.kind,actor:event.actor,status:event.status,name:event.name,text:event.text??undefined,correlationId:event.correlationId??undefined,details:event.details});
  return{id:event.id,createdAt:event.createdAt,epoch:event.epoch,revision:event.revision,stepIndex:event.stepIndex,kind:clean.kind,actor:clean.actor,status:clean.status,name:clean.name,text:clean.text??null,correlationId:clean.correlationId??null,details:clean.details??{}};
 });
}

function identities(events:readonly ClassroomJournalEvent[]){
 const references=new Map<string,{spans:Set<string>;turns:Set<string>}>();
 for(const event of events){
  const current=correlation(event.correlationId);if(!current)continue;
  const key=`${event.epoch}:${current}`,ref=references.get(key)??{spans:new Set<string>(),turns:new Set<string>()};
  const span=validId(event.details.spanId),turn=validId(event.details.turnId);if(span)ref.spans.add(span);if(turn)ref.turns.add(turn);references.set(key,ref);
 }
 return(event:ClassroomJournalEvent):Identity=>{
  const current=correlation(event.correlationId),ref=current?references.get(`${event.epoch}:${current}`):undefined;
  const unambiguous=!ref||ref.turns.size<=1;
  return{correlation:current,span:validId(event.details.spanId)??(unambiguous&&ref?.spans.size===1?[...ref.spans][0]:null),turn:validId(event.details.turnId)??(ref?.turns.size===1?[...ref.turns][0]:null)};
 };
}

const errorLabels:Record<string,string>={
 response_timeout:'等待老师回复超时',provider_error:'语音服务返回异常',provider_response_failed:'老师回复生成失败',provider_invalid_request:'语音请求未被服务接受',provider_server_error:'语音服务处理异常',provider_unknown_error:'语音服务返回异常',
 input_transcription_failed:'语音识别未完成',assessment_unavailable:'教学判断暂时不可用',assessment_cancelled:'教学判断已取消',audio_sync_timeout:'老师声音同步等待超时',configuration_timeout:'老师配置确认超时',
 audio_capture_failed:'麦克风采集异常',audio_capture_backlog:'麦克风采集积压',audio_playback_failed:'浏览器声音播放异常',audio_playback_backlog:'老师声音播放积压',lease_lost:'课堂连接权限已失效',journal_backpressure:'部分过程未记录',journal_write_failed:'部分过程未记录',
};
function issueTitle(event:ClassroomJournalEvent){
 if(event.name==='voice_provider_failure'&&event.details.action==='recovery_check')return '语音请求被拒绝';
 if(event.name==='voice_request_recovery')return '语音恢复失败';
 if(event.name==='journal_gap')return '部分过程未记录';
 if(event.name==='voice_closed')return '语音连接已停止';
 if(event.details.errorCode&&errorLabels[event.details.errorCode])return errorLabels[event.details.errorCode];
 if(event.details.phase==='input_failed'||event.name==='input_transcription_failed')return '语音识别未完成';
 if(event.kind==='tool')return event.status==='rejected'?'课堂操作未执行':'课堂操作失败';
 if(event.kind==='visual')return event.details.source==='camera'?'相机画面分享失败':'教材画面分享失败';
 if(event.name==='assessment_phase')return '教学判断未完成';
 return event.status==='rejected'?'这项操作未执行':'记录到一项异常';
}
function item(event:ClassroomJournalEvent,category:ClassroomTimelineItem['category'],title:string,text:string|null=null,note:string|null=null):ClassroomTimelineItem{
 return{id:event.id,eventIds:[event.id],at:event.createdAt,category,title,text,note,severity:severity([event]),events:[event]};
}
function actionResult(events:readonly ClassroomJournalEvent[]){return events.findLast(e=>e.status==='confirmed'||e.status==='rejected'||e.status==='failed')??last(events);}
const appliedHighlight=(event:ClassroomJournalEvent)=>event.kind==='tool'&&event.actor==='application'&&event.name==='delegate'&&event.status==='confirmed'&&event.details.effectiveTool==='highlight_objects'&&event.details.resultStatus==='confirmed'&&!!event.details.highlighted?.length;
const overlapReplyRequested=(event:ClassroomJournalEvent)=>event.name==='voice_overlap_reply'&&event.actor==='application'&&event.status==='requested';
function actionItem(events:ClassroomJournalEvent[]):ClassroomTimelineItem{
 const first=events[0],current=actionResult(events);
 const labels:Record<string,{request:string;result:string}>={highlight_objects:{request:'圈选教材对象',result:'圈选操作'},chalk_write:{request:'展示书写参考',result:'书写参考'},inspect_current_page:{request:'查看教材画面',result:'教材查看'},review_lesson_notes:{request:'查看课堂笔记',result:'课堂笔记查看'}};
 const label=labels[appliedHighlight(current)?'highlight_objects':first.name]??{request:'执行课堂操作',result:'课堂操作'};
 const confirmed=current.status==='confirmed'&&(['confirmed','reference'].includes(current.details.resultStatus??'')||current.actor==='application'&&!current.details.resultStatus);
 const refused=current.status==='rejected'||current.status==='failed'||['unavailable','retry'].includes(current.details.resultStatus??'');
 const title=refused?`${label.result}${current.status==='failed'?'失败':'未执行'}`:confirmed?`${label.result}已确认`:current.status==='requested'?`${current.actor==='teacher'?'老师':'课堂'}请求${label.request}`:`${label.result}记录`;
 const objects=current.details.highlighted??events.find(e=>e.details.objectIds)?.details.objectIds;
 const result=item(current,'action',title,objects?.length?`对象：${objects.join('、')}`:null,first.name==='inspect_current_page'?'查看请求不代表已经理解画面。':null);
 return{...result,id:first.id,eventIds:events.map(e=>e.id),events,severity:severity(events)};
}
const pointLabels:Record<ClassroomPointStage,string>={clicked:'浏览器记录了教材点击',sent:'浏览器报告点选已发出',send_failed:'浏览器报告点选未发出',acknowledged:'浏览器报告收到点选确认',unavailable:'浏览器报告点选不可用',timeout:'浏览器未收到点选确认',server_received:'服务端已收到点选',server_rejected:'服务端拒绝点选',accepted:'指认已保存',reply_queued:'点选已排队等待老师',reply_requested:'已请求老师回应点选',reply_started:'老师开始生成点选回复',audio_sent:'点选回复声音已发往浏览器',playback_started:'浏览器报告开始播放点选回复',cancelled:'点选回复已取消',expired:'点选回复已过期'};
const pointReasonLabels:Record<string,string>={not_ready:'当时尚未连接',busy:'上一项点选尚未确认',invalid_context:'课堂范围不匹配',unknown_object:'教材对象未识别',send_backpressure:'发送出现积压',send_failed:'发送未成功',ack_timeout:'等待确认超时',server_rejected:'服务端未接受',unsupported:'当前服务不支持',rate_limited:'操作过于频繁',superseded:'被新的输入替代',unknown:'原因未确认',expired:'已超过有效时间',duplicate:'重复点选',lease_lost:'课堂连接权限已失效',persistence_failed:'指认保存失败',stale_context:'课堂内容已变化',pending_response:'老师回复仍在处理中',context_changed:'课堂内容已变化',invalid_request:'请求格式无效',ack_failed:'确认未送达'};
function pointStage(event:ClassroomJournalEvent):ClassroomPointStage|null{
 const stage=event.details.pointStage;if(!stage)return event.name==='point'?'accepted':null;
 if(stage==='playback_started')return event.details.source==='client'&&event.details.clock==='client'?stage:null;
 return (CLASSROOM_POINT_CLIENT_STAGES as readonly string[]).includes(stage)?event.details.source==='client'?stage:null:event.details.source!=='client'?stage:null;
}
function pointItem(events:ClassroomJournalEvent[]):ClassroomTimelineItem{
 const observations=events.map(event=>({event,stage:pointStage(event)})).filter((value):value is {event:ClassroomJournalEvent;stage:ClassroomPointStage}=>!!value.stage);
 const failure=observations.findLast(value=>['send_failed','unavailable','timeout','server_rejected','cancelled','expired'].includes(value.stage));
 const rank:ClassroomPointStage[]=['clicked','sent','acknowledged','server_received','accepted','reply_queued','reply_requested','reply_started','audio_sent','playback_started'];
 const progress=observations.reduce<typeof observations[number]|undefined>((best,value)=>!best||rank.indexOf(value.stage)>rank.indexOf(best.stage)?value:best,undefined),current=failure??progress;
 const saved=observations.some(value=>value.stage==='accepted'),audio=observations.some(value=>value.stage==='audio_sent'),played=observations.some(value=>value.stage==='playback_started'),requested=observations.some(value=>['reply_requested','reply_started'].includes(value.stage));
 const reason=failure?.event.details.pointReason,note=failure?`${saved?'指认已保存。':''}${reason?pointReasonLabels[reason]??'原因未确认。':'详细原因未记录。'}`:played?'浏览器报告开始播放，不代表播放结束。':audio?'服务器已发送声音；浏览器播放尚未确认。':requested?'已请求老师回应；尚无实际音频发送记录。':saved?'指认已保存，不代表答对或理解。':'浏览器观察；尚无服务端接受记录。';
 const row=item(current?.event??events[0],'action',current?pointLabels[current.stage]:'点选过程记录',events.find(event=>event.details.objectIds?.length)?.details.objectIds?.join('、')??null,note);
 return{...row,id:events[0].id,eventIds:events.map(event=>event.id),events,severity:failure?['cancelled','expired'].includes(failure.stage)?'warning':'error':severity(events)};
}
function basicItem(event:ClassroomJournalEvent):ClassroomTimelineItem|null{
 if(event.name==='audio_continuity'){
  const stats=event.details.audioStats;if(!stats||!audioContinuityHasGap(stats))return null;
  const title=stats.playbackGapCount?'浏览器出现播放片间空档':stats.maxScheduleLagMs&&stats.maxScheduleLagMs>=100?'后台音频发送调度延后':'音频片段到达间隔偏大';
  return {...item(event,'connection',title,describeAudioContinuity(stats),'这是片段传输与播放排程观察，不等于已确认网络丢包或实际听到断音。'),severity:'warning'};
 }
 if(event.name==='voice_request_recovery'){
  if(event.details.state==='checking'&&event.status==='requested')return item(event,'connection','正在核验语音连接',null,'尚未确认恢复，核验结果会另行记录。');
  if(event.details.state==='recovered'&&event.status==='confirmed')return item(event,'connection','语音连接已恢复',null,'配置和语音链路核验通过，不代表老师已开口。');
  if(event.status!=='failed')return null;
 }
 if(event.kind==='utterance'&&(event.actor==='child'||event.actor==='teacher'))return item(event,event.actor,event.actor==='child'?'学生发言':'老师回复',event.text,event.actor==='teacher'?'播放未确认':event.details.source==='typed'?'文字输入。':null);
 if(isIssue(event))return item(event,'issue',issueTitle(event),null,event.name==='voice_provider_failure'&&event.details.action==='recovery_check'?'正在核验连接，尚未确认是否可以继续。':event.name==='voice_closed'&&event.details.errorCode?errorLabels[event.details.errorCode]??'具体原因尚未确认。':null);
 if(overlapReplyRequested(event))return item(event,'connection','已请求老师补答最新一句',null,'上一轮发生打断；这里记录的是补答请求，声音与播放结果另行记录。');
 if(event.kind==='tool')return internalTools.has(event.name)&&!appliedHighlight(event)?null:actionItem([event]);
 if(technicalNames.has(event.name)||event.details.phase)return null;
 if(event.name==='camera_state'||event.name==='board_state'){
  const camera=event.details.source==='camera'||event.name==='camera_state',subject=camera?'相机画面分享':'教材画面分享';
  const state=event.details.state;
  const action=state==='sharing'?'已开启':state==='off'?'已关闭':state==='starting'?'正在开启':state==='unavailable'?'不可用':state==='error'?'失败':null;
  return action?item(event,'visual',action==='正在开启'?`正在开启${subject}`:`${subject}${action}`,null,null):null;
 }
 const labels:Record<string,{category:ClassroomTimelineItem['category'];title:string}>={
  classroom_created:{category:'connection',title:'创建课堂'},connection_started:{category:'connection',title:'正在连接课堂'},voice_connected:{category:'connection',title:'课堂语音已连接'},voice_closed:{category:'connection',title:'语音连接已关闭'},connection_released:{category:'connection',title:'课堂连接已释放'},
  pause:{category:'connection',title:'课堂已暂停'},resume:{category:'connection',title:'继续课堂'},end:{category:'connection',title:'课堂已结束'},select:{category:'action',title:'学生选择了教材对象'},next:{category:'action',title:'进入下一项活动'},skip:{category:'action',title:'学生选择跳过'},hint:{category:'action',title:'学生请求帮助'},silence_prompt:{category:'action',title:'已请求老师温和接话'},
 };
 if(event.name==='voice_response_cancel')return item(event,'connection',event.details.state==='learner_speech'?'说话信号触发了老师回复打断':'课堂更新触发了老师回复取消');
 if(event.name==='annotation')return item(event,'action',event.details.action==='undo'?'学生撤销了教材笔迹':'学生在教材上画笔标注');
 if(event.name==='point')return item(event,'action','学生指向了教材对象',event.details.objectIds?.join('、')??null,'指认不代表答对或理解。');
 const label=labels[event.name];return label?item(event,label.category,label.title):null;
}

/** Explicit identities attach detail; nearby timestamps never establish a shared action or playback. */
export function buildClassroomTimeline(input:readonly ClassroomJournalEvent[]):ClassroomTimelineItem[]{
 const events=safeEvents(input),latencies=projectClassroomLatency(events),latencyEventIds=new Set(latencies.flatMap(value=>value.eventIds)),identity=identities(events),rows:ClassroomTimelineItem[]=[],actionGroups=new Map<string,ClassroomJournalEvent[]>();
 const points=new Map<string,ClassroomJournalEvent[]>(),pointGroups=new Map<string,ClassroomJournalEvent[]>();
 for(const event of events){const pointId=event.name==='point_trace'?validId(event.details.pointId):event.name==='point'?validId(event.correlationId??undefined):null;if(pointId){const key=`${event.epoch}:${pointId}`,group=points.get(key)??[];group.push(event);points.set(key,group);}}
 for(const group of points.values())for(const event of group)pointGroups.set(event.id,group);
 for(const event of events){
  if(event.kind!=='tool'||internalTools.has(event.name))continue;
  const id=identity(event),key=id.correlation?`${event.epoch}:${event.name}:correlation:${id.correlation}`:id.span?`${event.epoch}:${event.name}:span:${id.span}`:id.turn?`${event.epoch}:${event.name}:turn:${id.turn}`:null;
  if(key){const group=actionGroups.get(key)??[];group.push(event);actionGroups.set(key,group);}
 }
 const grouped=new Map<string,ClassroomJournalEvent[]>();
 for(const group of actionGroups.values()){
  const explicitCorrelation=group.every(e=>!!identity(e).correlation),requests=group.filter(e=>e.status==='requested').length,terminals=group.filter(e=>['confirmed','rejected','failed'].includes(e.status)).length;
  const turns=new Set(group.map(e=>identity(e).turn).filter(Boolean));
  if(group.length>1&&turns.size<=1&&(explicitCorrelation||requests<=1&&terminals<=1))for(const event of group)grouped.set(event.id,group);
 }
 const connections=new Map<number,ClassroomJournalEvent[]>();
 for(const event of events)if(event.kind==='connection'&&!isIssue(event)&&['connection_started','provider_ready','voice_connected'].includes(event.name)){const group=connections.get(event.epoch)??[];group.push(event);connections.set(event.epoch,group);}
 const connectionGroups=new Map<string,ClassroomJournalEvent[]>();
 for(const group of connections.values())if(group.filter(e=>e.name==='voice_connected').length===1)for(const event of group)connectionGroups.set(event.id,group);
 const used=new Set<string>(latencyEventIds);
 for(const event of events){
  if(used.has(event.id))continue;
  const point=pointGroups.get(event.id);if(point){rows.push(pointItem(point));for(const member of point)used.add(member.id);continue;}
  const connection=connectionGroups.get(event.id);
  if(connection){const connected=connection.find(e=>e.name==='voice_connected')!;rows.push({...item(connected,'connection','课堂语音已连接'),events:[...connection],eventIds:connection.map(e=>e.id)});for(const member of connection)used.add(member.id);continue;}
  const group=grouped.get(event.id);
  if(group){rows.push(actionItem(group));for(const member of group)used.add(member.id);continue;}
  const row=basicItem(event);if(row){rows.push(row);used.add(event.id);}
 }
 const owners=new Map(rows.map(row=>[row,row.events.map(event=>({epoch:event.epoch,...identity(event)}))]));
 const order=new Map(rows.map(row=>[row,row.category==='action'&&row.events.every(e=>e.kind==='tool')?actionResult(row.events).id:row.id]));
 for(const event of events){
  if(used.has(event.id))continue;
  const id=identity(event);let candidates:ClassroomTimelineItem[]=[];
  for(const key of ['correlation','span','turn'] as const){
   if(!id[key])continue;
   candidates=rows.filter(row=>owners.get(row)!.some(target=>{
    if(target.epoch!==event.epoch)return false;
    if(id.span&&target.span&&id.span!==target.span)return false;
    if(id.turn&&target.turn&&id.turn!==target.turn)return false;
    return target[key]===id[key];
   }));
   if(candidates.length)break;
  }
  if(candidates.length===1){const row=candidates[0];row.events.push(event);row.eventIds.push(event.id);used.add(event.id);}
 }
 const audibleReplies=new Set(latencies.flatMap(latency=>latency.status==='played'?latency.events.filter(event=>event.id===latency.progressEventId&&validId(event.details.spanId)).map(event=>`${event.epoch}:${validId(event.details.spanId)}`):[]));
 for(const row of rows){
  row.events.sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0);row.eventIds=row.events.map(e=>e.id);
  if(row.category==='teacher'){
   const owner=owners.get(row)!.find(value=>value.span!==null);
   const playback=owner?row.events.filter(e=>e.details.clock==='client'&&e.details.source==='client'&&e.epoch===owner.epoch&&identity(e).span===owner.span):[];
   if(playback.some(e=>e.details.phase==='playback_finished'))row.note='浏览器报告播放结束';
   else if(owner&&audibleReplies.has(`${owner.epoch}:${owner.span}`))row.note='浏览器报告开始有声播放';
   else if(playback.some(e=>e.details.phase==='playback_started'))row.note='浏览器报告开始播放';
  }
 }
 const latencyByInput=new Map<string,ClassroomLatencySummary[]>();
 for(const latency of latencies){if(!latency.inputId)continue;const key=`${latency.epoch}:${latency.inputId}`,values=latencyByInput.get(key)??[];values.push(latency);latencyByInput.set(key,values);}
 for(const latency of latencies){
  const matching=rows.filter(row=>row.category==='child'&&row.events.some(event=>{
   if(event.kind!=='utterance'||event.actor!=='child'||event.details.source==='typed'||event.epoch!==latency.epoch)return false;
   const measurement=validId(event.details.measurementId);
   return measurement?measurement===latency.measurementId:!!latency.inputId&&validId(event.details.latencyInputId)===latency.inputId&&latencyByInput.get(`${latency.epoch}:${latency.inputId}`)?.length===1;
  }));
  if(matching.length===1&&!matching[0].latency){
   const row=matching[0];row.latency=latency;row.events=[...row.events,...latency.events].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);row.eventIds=[...new Set(row.events.map(event=>event.id))];row.severity=severity(row.events);
  }else{
   const row=item(latency.events[0],'child','本轮语音');row.latency=latency;row.events=latency.events;row.eventIds=latency.eventIds;row.severity=severity(row.events);rows.push(row);
  }
 }
 return rows.sort((a,b)=>BigInt(order.get(a)??a.id)<BigInt(order.get(b)??b.id)?-1:BigInt(order.get(a)??a.id)>BigInt(order.get(b)??b.id)?1:0);
}

const phaseLabels:Record<string,string>={
 session_started:'课堂语音已连接',session_ended:'语音连接已关闭',input_received:'已收到学生文字',speech_started:'收到说话开始信号',speech_stopped:'等待识别文字',input_final:'已收到学生文字',application_started:'课堂正在处理输入',application_completed:'课堂处理已返回',model_started:'等待教学判断',model_completed:'教学判断已返回',response_requested:'等待老师回复',response_started:'老师开始生成回复',audio_first_received:'老师语音已到服务器',audio_first_sent:'老师语音已发往浏览器',response_completed:'老师已完成生成',response_cancelled:'老师回复已取消',tool_requested:'课堂操作正在处理',tool_completed:'课堂操作处理已返回',
};
function progressTitle(event:ClassroomJournalEvent):string|null{
 if(event.name==='voice_request_recovery'){
  if(event.status==='failed')return '语音恢复失败';
  if(event.details.state==='checking'&&event.status==='requested')return '正在核验语音连接';
  if(event.status==='confirmed')return({configuration_verified:'语音配置已核验',audio_verified:'语音链路已核验',recovered:'语音连接已恢复'}as Record<string,string>)[event.details.state??'']??null;
  return null;
 }
 if(event.name==='point_trace'){const stage=pointStage(event);return stage?pointLabels[stage]:null;}
 if(isIssue(event))return issueTitle(event);
 if(overlapReplyRequested(event))return '已请求老师补答最新一句';
 if(appliedHighlight(event))return '教材圈选已确认';
 const phase=event.details.phase;
 if(phase==='playback_started'||phase==='playback_finished')return event.details.source==='client'&&event.details.clock==='client'?`浏览器报告${phase==='playback_started'?'开始播放':'播放结束'}`:null;
 if(phase&&phaseLabels[phase]){
  if(phase==='application_completed'&&event.details.rttMs!==undefined)return null;
  return phaseLabels[phase];
 }
 if(event.kind==='utterance')return event.actor==='child'?'学生文字已记录':event.actor==='teacher'?'老师回复文字已生成':null;
 if(event.name==='silence_prompt')return '已请求老师温和接话';
 if(event.name==='voice_response_cancel')return '已请求取消老师回复';
 if(event.name==='voice_response_cancel_ack')return '老师回复取消已确认';
 if(event.name==='voice_connected')return '课堂语音已连接';
 if(event.name==='connection_started')return '正在连接课堂';
 if(event.name==='voice_closed')return '语音连接已关闭';
 if(event.kind==='tool'&&event.status==='requested')return '课堂操作正在处理';
 return null;
}

/** A journal snapshot describes last observed progress, never an unobserved microphone or a live API diagnosis. */
export function describeClassroomProgress(input:readonly ClassroomJournalEvent[],options:ProgressOptions):ClassroomProgress{
 const all=safeEvents(input),epoch=all.reduce((value,event)=>Math.max(value,event.epoch),0),events=all.filter(e=>e.epoch===epoch),latencies=projectClassroomLatency(events),latencyByEvent=new Map(latencies.filter(value=>value.progressEventId!==null).map(value=>[value.progressEventId!,value])),latest=events.findLast(e=>progressTitle(e)!==null||latencyByEvent.has(e.id));
 const latency=latest?latencyByEvent.get(latest.id):undefined,title=latency?.summary??(latest?progressTitle(latest):null),at=latest?.createdAt??null,gap=events.some(e=>e.name==='journal_gap'),failure=events.findLast(isIssue);
 const missing=!options.complete||gap?'记录存在缺口或尚未读取完整，无法确认当前进展。 ':'';
 if(options.status==='ended')return{title:'课堂已结束',detail:`${missing}时间轴保留已记录的过程。`,tone:missing?'warning':'neutral',at};
 if(options.status==='paused'){
  const voiceFailure=events.findLast(e=>e.status==='failed'&&['voice_closed','voice_response_timeout','voice_provider_failure'].includes(e.name)&&!(e.name==='voice_provider_failure'&&['recovery_check','retained_idle'].includes(e.details.action??'')));
  const explicitPause=events.findLast(e=>e.name==='pause'&&e.actor==='child');
  const manual=explicitPause&&(!voiceFailure||BigInt(explicitPause.id)>BigInt(voiceFailure.id));
  const reason=voiceFailure?.details.errorCode?errorLabels[voiceFailure.details.errorCode]:null;
  const cause=missing?`${reason?`已加载记录曾出现${reason}，`:''}当前暂停原因无法确认。 `:manual?'学生主动暂停了课堂。 ':reason?`因${reason}而暂停。 `:failure?`此前记录：${issueTitle(failure)}。 `:'';
  return{title:'课堂已暂停',detail:`${cause}${missing}${mic}`,tone:voiceFailure&&!manual?'warning':missing?'warning':'neutral',at};
 }
 if(options.status==='preflight')return{title:'课堂尚未连接',detail:`${missing}连接状态以开课检查结果为准。 ${mic}`,tone:missing?'warning':'neutral',at};
 if(missing)return{title:'无法确认当前进展',detail:`${missing}${title?`最近记录：${title}。 `:''}${mic}`,tone:'warning',at};
 if(!latest||!title)return{title:'无法确认当前进展',detail:`尚无可判断语音阶段的记录。 ${mic}`,tone:'neutral',at};
 const age=options.now-Date.parse(latest.createdAt);
 if(!Number.isFinite(age)||age<0||age>15000)return{title:'无法确认当前进展',detail:`最近记录：${title}；记录较早或时间尚未确认，不能据此判断现在是否卡住。 ${mic}`,tone:'warning',at};
 const extra=latency?'本轮总等待以浏览器有声播放测量为准，分段仅含已记录范围。 ':latest.details.phase==='response_completed'?'生成结束不代表声音已播放完。 ':latest.details.phase==='playback_finished'?'后续状态尚未确认，不能仅凭无新记录判断学生是否沉默。 ':latest.kind==='utterance'&&latest.actor==='teacher'?'文字已生成，播放状态尚未确认。 ':'';
 return{title:`最近记录：${title}`,detail:`${extra}${mic}`,tone:isIssue(latest)?latest.status==='rejected'?'warning':'error':'neutral',at};
}
