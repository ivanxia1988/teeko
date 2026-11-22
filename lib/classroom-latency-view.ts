import {CLASSROOM_LATENCY_STAGES,sanitizeClassroomJournalEntry,type ClassroomJournalEvent} from './classroom-journal';

export type ClassroomLatencySegment={id:'recognition'|'application'|'reply'|'send'|'playback';label:string;ms:number;clock:'server'|'client'};
export type ClassroomLatencySummary={measurementId:string;inputId:string|null;epoch:number;at:string;progressEventId:string|null;eventIds:string[];events:ClassroomJournalEvent[];status:'waiting'|'played'|'cancelled'|'unmeasured';waitMs:number|null;stage:string;summary:string;detail:string;basisLabel:string|null;segments:ClassroomLatencySegment[]};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier=(value:unknown)=>typeof value==='string'&&uuid.test(value)?value.toLowerCase():null;
const milliseconds=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=120000?value:null;
export const formatLatency=(value:number)=>`${(value/1000).toFixed(1)} 秒`;
const labels:Record<string,string>={input_received:'已接收声音，等待停声',speech_stopped:'等待识别文字',input_final:'识别已完成，等待老师回复',application_started:'课堂正在处理输入',response_requested:'等待老师语音',response_started:'等待老师语音',audio_first_received:'语音已到服务器，等待发送',audio_first_sent:'等待播放确认',playback_started:'浏览器已开始有声播放',cancelled:'本轮已打断',unmeasured:'时延未测完整'};
const waitLabels:Record<string,string>={receiving_input:'已接收声音，等待停声',waiting_reply:'等待老师回复',waiting_audio:'等待老师语音',waiting_playback:'等待播放确认'};
const validWaitUpdate=(event:ClassroomJournalEvent)=>event.details.clock==='server'&&Number.isSafeInteger(event.details.elapsedMs)&&event.details.elapsedMs!>=0&&Object.hasOwn(waitLabels,event.details.state??'');
const reasonLabels:Record<string,string>={capture_gap:'采集出现间断',scope_changed:'课堂任务已变化',context_changed:'课堂任务已变化',interrupted:'发生插话或回复取消',new_input:'收到新的语音输入',new_voice:'收到新的说话信号',response_cancelled:'老师回复已取消',playback_interrupted:'声音播放已打断',input_invalidated:'本轮输入关联已失效',stop_unconfirmed:'停声边界未确认',closed:'本轮连接已关闭',overlapping_input:'多段输入发生重叠',ambiguous_input:'输入关联不唯一',ambiguous_response:'回复关联不唯一',mixed_audio:'音频混合，无法唯一关联',expired:'测量已过期',playback_clock:'浏览器播放时钟发生中断，无法完整测量',playback_unbound:'声音无法唯一关联到本轮回复',advance_timeout:'活动推进确认超时',advance_unverified:'活动推进结果未通过确认'};
const compare=(a:ClassroomJournalEvent,b:ClassroomJournalEvent)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0;

/** Server stages share one origin; browser wait is a separate measurement, never a cross-clock subtraction. */
export function projectClassroomLatency(input:readonly ClassroomJournalEvent[]):ClassroomLatencySummary[]{
 const groups=new Map<string,ClassroomJournalEvent[]>(),seen=new Set<string>();
 for(const event of [...input].sort(compare)){
  if(event.name!=='latency_stage'||seen.has(event.id)||!identifier(event.details.measurementId)||!CLASSROOM_LATENCY_STAGES.includes(event.details.latencyStage!))continue;
  seen.add(event.id);
  const safe=sanitizeClassroomJournalEntry({eventKey:'latency-view',kind:event.kind,actor:event.actor,status:event.status,name:event.name,details:event.details});
  const current={...event,text:null,details:safe.details??{}},key=`${event.epoch}:${identifier(event.details.measurementId)}`;
  const list=groups.get(key)??[];list.push(current);groups.set(key,list);
 }
 return [...groups.values()].map(events=>{
  const first=events[0],observations=events.filter(event=>event.details.latencyStage!=='wait_update'||validWaitUpdate(event)),measurementId=identifier(first.details.measurementId)!;
  const inputs=new Set(events.map(event=>identifier(event.details.latencyInputId)).filter((value):value is string=>!!value));
  const bases=new Set(events.map(event=>event.details.latencyBasis).filter(Boolean));
  const inputId=inputs.size===1?[...inputs][0]:null,conflict=inputs.size>1||bases.size>1;
  const basisLabel=bases.has('application_window')?'应用话轮':null;
  const terminal=observations.find(event=>['cancelled','unmeasured','playback_started'].includes(event.details.latencyStage!)),latest=terminal??observations.at(-1)??first;
  const stage=latest.details.latencyStage!,validPlayback=!conflict&&inputId&&bases.size===1&&terminal?.details.latencyStage==='playback_started'&&terminal.details.clock==='client'&&milliseconds(terminal.details.waitMs)!==null?terminal:null;
  const waitMs=validPlayback?milliseconds(validPlayback.details.waitMs):null;
  const status:ClassroomLatencySummary['status']=conflict?'unmeasured':validPlayback?'played':terminal?.details.latencyStage==='cancelled'?'cancelled':terminal?.details.latencyStage==='unmeasured'||terminal?.details.latencyStage==='playback_started'?'unmeasured':'waiting';
  const server=observations.filter(event=>(!terminal||BigInt(event.id)<=BigInt(terminal.id))&&event.details.clock==='server'&&Number.isSafeInteger(event.details.elapsedMs)&&event.details.elapsedMs!>=0);
  const atStage=(name:string)=>{const matches=server.filter(event=>event.details.latencyStage===name);return matches.length===1?matches[0].details.elapsedMs:undefined;};
  const segments:ClassroomLatencySegment[]=[];
  const add=(id:ClassroomLatencySegment['id'],label:string,from:string,to:string)=>{
   const start=atStage(from),end=atStage(to),ms=start===undefined||end===undefined?null:milliseconds(end-start);
   if(ms!==null)segments.push({id,label,ms,clock:'server'});
  };
  if(!conflict){
   add('recognition','识别等待','speech_stopped','input_final');
   add('application','应用处理','input_final','response_requested');
   const responseStart=server.some(event=>event.details.latencyStage==='response_requested')?atStage('response_requested')!==undefined?'response_requested':null:bases.has('provider_turn')?'speech_stopped':null;
   if(responseStart)add('reply','回复等待',responseStart,'audio_first_received');
   add('send','发送排队','audio_first_received','audio_first_sent');
   const playback=validPlayback?milliseconds(validPlayback.details.playbackMs):null;
   if(playback!==null)segments.push({id:'playback',label:'到浏览器后等待播放',ms:playback,clock:'client'});
  }
  const longest=segments.reduce<ClassroomLatencySegment|null>((best,current)=>!best||current.ms>best.ms?current:best,null);
  const stopped=atStage('speech_stopped'),lastServer=server.at(-1)?.details.elapsedMs;
  const pending=waitMs===null&&status==='waiting'&&stopped!==undefined&&lastServer!==undefined?milliseconds(lastServer-stopped):null;
  const stageLabel=stage==='wait_update'?waitLabels[latest.details.state??'']??'等待中':labels[stage]??'等待中';
  const measured=waitMs===null?status==='waiting'?pending!==null&&pending>0?`等待中 · 服务端最近记录已等 ${formatLatency(pending)} · ${stageLabel}`:`${stageLabel} · 总等待尚未测得`:'等待未测完整':`等待 ${formatLatency(waitMs)}`;
  const summary=`${measured}${waitMs!==null?longest?` · 较长的已测阶段：${longest.label} ${formatLatency(longest.ms)}`:' · 分段未测完整':''}${basisLabel?' · 应用话轮':''}`;
  const reason=conflict?'测量关联不唯一。 ':status==='cancelled'||status==='unmeasured'?`${reasonLabels[terminal?.details.state??'']??'本轮被取消或未能唯一关联'}。 `:'';
  const totalDetail=waitMs!==null?'总等待由同一浏览器测得，起点为最后有声采集帧结束，终点为有声播放。 ':status==='waiting'?'总等待尚待测得，正在等待浏览器确认有声播放。 ':'从本机停声到有声播放的总等待未测完整。 ';
  const detail=`${reason}${pending===null||pending===0?'':`截至最近服务端记录，停声后已等待 ${formatLatency(pending)}；这是服务端已记录范围，不是本机停声到播放的总等待。 `}${totalDetail}${basisLabel?'使用应用话轮边界，不代表供应商官方完成事件。 ':''}分段仅用本端同一测量时钟；并行或顺序不明的阶段未拆分，不能相加当作总等待，也不能据此认定纯模型推理或网络故障。`;
  return{measurementId,inputId,epoch:first.epoch,at:first.createdAt,progressEventId:observations.length?latest.id:null,eventIds:events.map(event=>event.id),events,status,waitMs,stage,summary,detail,basisLabel,segments};
 });
}
