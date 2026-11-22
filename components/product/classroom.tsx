'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, BookOpen, Check, Mic, MicOff, MousePointer2, Pause, Pencil, PhoneOff, Play, RotateCcw, Undo2, Volume2, VolumeX, Wifi } from 'lucide-react';
import type { ClassroomAction, ClassroomSnapshot } from '../../lib/classroom-contract';
import {ClassroomElapsedClock} from '../../lib/classroom-elapsed';
import {ClassroomChalk} from './classroom-chalk';
import {ClassroomNotes} from './classroom-notes';
import type {ClassroomChalkWriting} from '../../lib/domain/classroom-chalk';
import {captureClassroomToolState} from '../../lib/classroom-tool-state';
import {reportClassroomPointObservation,closeClassroomPointObservations} from '../../lib/classroom-point-diagnostics-client';
import type {ClassroomPointReason} from '../../lib/classroom-point-diagnostics';
import {buildClassroomSummary} from '../../lib/classroom-summary';
import {courseReadingSource,isOpenClassroomConversation,isReadingStep} from '../../lib/classroom-reading';
import type { Point } from '../../lib/types';
import { normalizedPoint, pointsBox, resolveSelection } from '../../lib/classroom';
import { PrototypeSounds } from '../../lib/prototype-sounds';
import {ClassroomCameraButton,ClassroomCameraPreview,useClassroomCamera} from './classroom-camera';
import {TeacherStage} from './teacher-avatar';
import {ClassroomBoardFeed} from './classroom-board-feed';
import type {ClassroomBoardInput} from '../../lib/classroom-board';
import type {ClassroomVisionState} from '../../lib/classroom-vision';
import {useClassroomDiagnosticEntry} from './classroom-diagnostic-entry';
import type {ClassroomVoiceFailure} from '../../lib/classroom-voice-errors';
import type {ClassroomConnectionQuality,ClassroomConnectionUpdate} from '../../lib/classroom-connection';
import { AccountRequestError, accountRequest, errorMessage } from './account-request';
import { classroomResponse, classroomSnapshotSchema, navigateClassroom, readClassroom } from './classroom-request';
import {TopicRecap} from '../topics/topic-recap';

export type ClassroomVoiceHandle = {start():Promise<void>;stop():Promise<void>;dispose():void;setMuted(value:boolean):void;sendText(text:string):unknown;sendPoint?(input:{contextKey:string;objectId:string},eventId?:string):boolean;sendInteraction?(input:import('../../lib/classroom-voice-client').ClassroomAnnotationInput):boolean;sendBoard?(input:ClassroomBoardInput):boolean;stopBoard?():void;chalkDisplayed?(id:string):boolean;chalkExpired?(id:string):void;startVision(stream:MediaStream):boolean;stopVision():void};
export type VoiceFactory = (options:{classroomId:string;provider:'qwen'|'openai'|'grok';onState:(state:'connecting'|'connected'|'closed'|'error')=>void;onSnapshot:(value:ClassroomSnapshot)=>void;onLevel:(role:'child'|'teacher',level:number)=>void;onError:(message:string)=>void;onFailure?:(failure:ClassroomVoiceFailure)=>void;onPlaybackQueue?:(milliseconds:number)=>void;onVisionState?:(state:ClassroomVisionState)=>void;onConnectionQuality?:(update:ClassroomConnectionUpdate)=>void;onChalk?:(writing:ClassroomChalkWriting|null)=>void})=>ClassroomVoiceHandle;
type Props = {classroomId:string;voiceFactory:VoiceFactory;checkMicrophone?:(onLevel:(level:number)=>void,signal:AbortSignal)=>Promise<boolean>;navigate?:(path:string)=>void;variant?:'course'|'topic'};
type Mark = {id:string;pageId:string;points:Point[]};
type Draft = {pointerId:number;stepId:string;points:Point[]};

export async function checkClassroomMicrophone(onLevel:(level:number)=>void,signal:AbortSignal):Promise<boolean>{
 if(!navigator.mediaDevices?.getUserMedia)throw new Error('当前浏览器无法打开麦克风，请使用本机地址或 HTTPS。');
 if(signal.aborted)return false;
 const capture:{stream:MediaStream|null}={stream:null};let context:AudioContext|null=null,finished=false;
 let every:ReturnType<typeof setInterval>|undefined,sampling:ReturnType<typeof setTimeout>|undefined,startup:ReturnType<typeof setTimeout>|undefined;
 let cancel!:()=>void;
 const cancellation=new Promise<null>((resolve,reject)=>{cancel=()=>resolve(null);signal.addEventListener('abort',cancel,{once:true});startup=setTimeout(()=>reject(new Error('麦克风检查超时，请确认浏览器权限后重试。')),12000);});
 try{
  // Safari requires WebAudio activation within the check button's synchronous gesture.
  context=new AudioContext();const resuming=context.resume();
  const media=navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false}).then(stream=>{
   if(finished||signal.aborted){stream.getTracks().forEach(track=>track.stop());return null;}
   capture.stream=stream;return stream;
  });
  const stream=await Promise.race([Promise.all([resuming,media]).then(([,value])=>value),cancellation]);
  if(!stream||signal.aborted)return false;
  if(startup)clearTimeout(startup);
  const analyser=context.createAnalyser();analyser.fftSize=512;context.createMediaStreamSource(stream).connect(analyser);const samples=new Uint8Array(analyser.fftSize);
  const measurement=new Promise<boolean>(resolve=>{
   let heard=false;every=setInterval(()=>{analyser.getByteTimeDomainData(samples);const level=Math.sqrt(samples.reduce((sum,value)=>sum+((value-128)/128)**2,0)/samples.length);heard ||= level>.012;onLevel(Math.min(1,level*8));},80);
   sampling=setTimeout(()=>resolve(heard),2500);
  });
  return (await Promise.race([measurement,cancellation]))??false;
 }finally{
  finished=true;if(startup)clearTimeout(startup);if(sampling)clearTimeout(sampling);if(every)clearInterval(every);signal.removeEventListener('abort',cancel);
  capture.stream?.getTracks().forEach(track=>track.stop());try{void context?.close().catch(()=>{});}catch{}onLevel(0);
 }
}
const time=(seconds:number)=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;

function ClassroomRecap({state}:{state:ClassroomSnapshot}){
 const summary=buildClassroomSummary(state),[tab,setTab]=useState<'summary'|'notes'>('summary');
 const tabId=`tk-recap-${state.id}`;
 return <main className="tk-product tk-real-summary">
  <header className="tk-product-header"><Link href="/courses" className="tk-wordmark">Tee<span>ko</span></Link><span>本次小结</span></header>
  <section><div className="tk-real-summary-hero"><img src="/prototype-assets/pose-handoff.svg" alt="Teeko"/><div><h1>{summary.headline}</h1><p>{state.course.title}</p><p className="tk-summary-note">{summary.description}</p></div></div>
   <div className="tk-real-summary-tabs" role="tablist" aria-label="课后内容" onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?1:tab==='summary'?1:0;setTab(index===0?'summary':'notes');event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();}}>
    <button type="button" role="tab" id={`${tabId}-summary-tab`} aria-controls={`${tabId}-summary-panel`} aria-selected={tab==='summary'} tabIndex={tab==='summary'?0:-1} onClick={()=>setTab('summary')}>本次小结</button><button type="button" role="tab" id={`${tabId}-notes-tab`} aria-controls={`${tabId}-notes-panel`} aria-selected={tab==='notes'} tabIndex={tab==='notes'?0:-1} onClick={()=>setTab('notes')}>课堂表达</button>
   </div>
   <div className="tk-real-summary-panel" role="tabpanel" tabIndex={0} id={`${tabId}-summary-panel`} aria-labelledby={`${tabId}-summary-tab`} hidden={tab!=='summary'}>
   <div className={`tk-real-summary-stats${summary.reading?' is-reading':''}`}><div><strong>{time(state.elapsedSeconds)}</strong><span>本次课堂时长</span></div>{summary.reading?<div><strong>{summary.browsed.length}</strong><span>已浏览活动</span></div>:<><div><strong>{summary.completed.filter(item=>item.status==='independent').length}</strong><span>独立完成</span></div><div><strong>{summary.completed.filter(item=>item.status==='assisted').length}</strong><span>提示后完成</span></div></>}</div>
   <div className="tk-real-summary-details">{summary.reading?<section aria-label="已浏览的带读活动"><h2>已浏览的带读活动</h2>{summary.browsed.length?<ul tabIndex={0} aria-label="带读浏览记录">{summary.browsed.map(item=><li key={item.stepId}><BookOpen size={16}/><span>{item.label}</span><small>已浏览</small></li>)}</ul>:<p>还没有已浏览的带读活动。</p>}</section>:<section aria-label="本次完成"><h2>本次完成</h2>{summary.completed.length?<ul tabIndex={0} aria-label="完成记录">{summary.completed.map(item=><li key={item.stepId}><Check size={16}/><span>{item.label}</span><small>{item.status==='assisted'?'提示后完成':'独立完成'}</small></li>)}</ul>:<p>还没有完成的答题记录。</p>}</section>}
    <section aria-label="再练一点"><h2>再练一点</h2>{summary.practice.length?<ul tabIndex={0} aria-label="再练建议">{summary.practice.map(item=><li key={item.stepId}><div><strong>{item.label}</strong><p>{item.reason}</p></div></li>)}</ul>:<p>{summary.reading?'可以按兴趣继续聊，或下次接着阅读。':summary.empty?'先从本课的小问题开始。':'这次没有需要特别再练的记录。'}</p>}</section></div>
   <p className="tk-real-summary-next">{summary.nextStep}</p></div>
   <div className="tk-real-summary-panel" role="tabpanel" tabIndex={0} id={`${tabId}-notes-panel`} aria-labelledby={`${tabId}-notes-tab`} hidden={tab!=='notes'}>{tab==='notes'&&<ClassroomNotes classroomId={state.id} courseVersion={`${state.course.id}:${state.course.version}`}/>}</div><Link className="tk-submit" href="/courses">回到我的课程<ArrowRight size={18}/></Link>
  </section>
 </main>;
}

function ConnectionStatus({quality,connected,connecting,role}:{quality:ClassroomConnectionQuality;connected:boolean;connecting:boolean;role:'teacher'|'device'}){
 const label=connected?({checking:'检测中',good:'连接良好',fair:'连接一般',poor:'连接较差',unavailable:'未测得'}[quality.status]):connecting?'连接中':'未连接';
 const detail=role==='teacher'?'老师语音服务连接':'你的设备连接';
 const title=connected?`${detail}：${quality.rttMs===null?'尚无有效延迟结果':`往返延迟 ${Math.round(quality.rttMs)} 毫秒`}。连接质量根据延迟与检测超时估计，不代表带宽。`:detail;
 return <div className="tk-real-connection" data-quality={connected?quality.status:'unavailable'} aria-label={role==='teacher'?'老师连接质量':'你的连接质量'} title={title}><Wifi size={14}/>{label}</div>;
}

export function Classroom({classroomId,voiceFactory,checkMicrophone=checkClassroomMicrophone,navigate=navigateClassroom,variant='course'}:Props){
 const topic=variant==='topic',returnPath=topic?'/topics':'/courses',returnLabel=topic?'回到主题首页':'回到我的课程';
 const loginPath=topic?`/topics/login?next=${encodeURIComponent(`/topics/classroom/${classroomId}`)}`:'/login';
 const diagnosticEntry=useClassroomDiagnosticEntry(classroomId);
 const [snapshot,setSnapshot]=useState<ClassroomSnapshot|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[attempt,setAttempt]=useState(0),[busy,setBusy]=useState(false);
 const [exitRequested,setExitRequested]=useState(false),[muted,setMuted]=useState(false),[elapsed,setElapsed]=useState(0);
 const elapsedClock=useRef(new ClassroomElapsedClock()),voiceConnected=useRef(false);
 const [connections,setConnections]=useState<{device:ClassroomConnectionQuality;teacher:ClassroomConnectionQuality}>({device:{status:'checking',rttMs:null},teacher:{status:'checking',rttMs:null}});
 const [vision,setVision]=useState<ClassroomVisionState>({status:'off',generation:0});
 const [chalk,setChalk]=useState<ClassroomChalkWriting|null>(null);
 const [voiceFailure,setVoiceFailure]=useState<ClassroomVoiceFailure|null>(null),[playbackQueue,setPlaybackQueue]=useState(0);
 const [point,setPoint]=useState<{contextKey:string;objectId:string}|null>(null),[pointError,setPointError]=useState('');
 const lastPointSentAt=useRef<number|null>(null);
 const clearPoint=useCallback(()=>{setPoint(null);setPointError('');lastPointSentAt.current=null;},[]);
 const [mic,setMic]=useState<'unchecked'|'checking'|'passed'|'failed'>('unchecked'),[micLevel,setMicLevel]=useState(0),[voiceState,setVoiceState]=useState<'idle'|'connecting'|'connected'|'closed'|'error'>('idle');
 const [levels,setLevels]=useState({child:0,teacher:0}),[tool,setTool]=useState<'pointer'|'pen'>('pointer'),[marks,setMarks]=useState<Mark[]>([]),[draft,setDraft]=useState<Draft|null>(null),[endDialog,setEndDialog]=useState(false),[reward,setReward]=useState(false),[sound,setSound]=useState(true),[notice,setNotice]=useState('');
 const camera=useClassroomCamera(classroomId,!!snapshot&&snapshot.status!=='paused'&&snapshot.status!=='ended'&&!endDialog);
 const stopCamera=camera.stop;
 const textbookImage=useRef<HTMLImageElement>(null);
 const visionAttempt=useRef<{stream:MediaStream;client:ClassroomVoiceHandle}|null>(null);
 const mounted=useRef(false),current=useRef<ClassroomSnapshot|null>(null),ended=useRef(false),locked=useRef(false),voice=useRef<ClassroomVoiceHandle|null>(null),voiceEpoch=useRef(0),disconnectRead=useRef<{epoch:number;controller:AbortController}|null>(null),micController=useRef<AbortController|null>(null),draftRef=useRef<Draft|null>(null),seenFeedback=useRef(new Set<string>()),rewardTimer=useRef<ReturnType<typeof setTimeout>|null>(null),continueButton=useRef<HTMLButtonElement>(null),soundEnabled=useRef(true),sounds=useRef(new PrototypeSounds());
 const stopMedia=useCallback(async()=>{
  clearPoint();
  setChalk(null);voiceConnected.current=false;elapsedClock.current.setRunning(false,performance.now());setElapsed(elapsedClock.current.read(performance.now()));
  voice.current?.stopVision();setVision({status:'off',generation:0});stopCamera();voiceEpoch.current++;disconnectRead.current?.controller.abort();disconnectRead.current=null;const previous=voice.current;voice.current=null;setLevels({child:0,teacher:0});setPlaybackQueue(0);setVoiceState('closed');sounds.current?.stop();setReward(false);
  if(previous){try{await previous.stop();}finally{previous.dispose();}}
 },[stopCamera,clearPoint]);
 const accept=useCallback((value:ClassroomSnapshot,initial=false)=>{
  const parsed=classroomSnapshotSchema.safeParse(value);if(!parsed.success||!mounted.current||value.id!==classroomId||ended.current)return;
  if(current.current&&value.revision<current.current.revision)return;
  if(!current.current||current.current.stepIndex!==value.stepIndex||current.current.connectionEpoch!==value.connectionEpoch||current.current.status!==value.status||current.current.course.id!==value.course.id||current.current.course.version!==value.course.version)clearPoint();
  if(current.current?.stepIndex!==value.stepIndex||current.current?.status!==value.status){draftRef.current=null;setDraft(null);setNotice('');}
  const previous=current.current;current.current=value;setSnapshot(value);
  elapsedClock.current.synchronize(value.elapsedSeconds,value.maxSeconds,performance.now(),value.status==='active');elapsedClock.current.setRunning(value.status==='active'&&voiceConnected.current,performance.now());setElapsed(elapsedClock.current.read(performance.now()));
  if(initial){setSound(value.preferences.soundEffects);soundEnabled.current=value.preferences.soundEffects;}
  if(value.status==='ended'){ended.current=true;micController.current?.abort();void stopMedia();setEndDialog(false);return;}
  const feedback=value.feedback;
  if(feedback&&!seenFeedback.current.has(feedback.id)){
   seenFeedback.current.add(feedback.id);
   const newAnswer=value.outcomes.some(outcome=>(outcome.status==='independent'||outcome.status==='assisted')&&value.course.steps.some(task=>task.id===outcome.stepId)&&!previous?.outcomes.some(old=>old.stepId===outcome.stepId));
   if(!initial&&value.status==='active'&&feedback.kind==='correct'&&newAnswer){
    setReward(true);if(rewardTimer.current)clearTimeout(rewardTimer.current);rewardTimer.current=setTimeout(()=>setReward(false),2200);
    if(soundEnabled.current)void sounds.current?.play('correct');
   }else if(feedback.kind!=='correct'){if(rewardTimer.current)clearTimeout(rewardTimer.current);setReward(false);}
  }
 },[classroomId,stopMedia,clearPoint]);
 useEffect(()=>{
  mounted.current=true;const controller=new AbortController();
  readClassroom(classroomId,controller.signal).then(result=>{if(controller.signal.aborted)return;accept(result.classroom,true);setLoading(false);}).catch(failure=>{if(controller.signal.aborted)return;if(failure instanceof AccountRequestError&&failure.status===401){navigate(loginPath);return;}setError(errorMessage(failure));setLoading(false);});
  return()=>{mounted.current=false;controller.abort();micController.current?.abort();disconnectRead.current?.controller.abort();voiceEpoch.current++;voice.current?.dispose();voice.current=null;if(rewardTimer.current)clearTimeout(rewardTimer.current);sounds.current?.stop();closeClassroomPointObservations(classroomId);};
 },[classroomId,attempt,accept,navigate,loginPath]);
 useEffect(()=>()=>{sounds.current?.dispose();},[]);
 useEffect(()=>{
  if(snapshot?.status!=='active'||voiceState!=='connected')return;
  const timer=setInterval(()=>setElapsed(elapsedClock.current.read(performance.now())),250);return()=>clearInterval(timer);
 },[snapshot?.status,voiceState]);
 useEffect(()=>{
  if(camera.state.status!=='on'||!camera.state.stream){visionAttempt.current=null;voice.current?.stopVision();return;}
  const client=voice.current;
  if(!client||voiceState!=='connected'||snapshot?.status!=='active'||endDialog)return;
  if(visionAttempt.current?.stream===camera.state.stream&&visionAttempt.current.client===client)return;
  // A camera-on gesture also authorizes sharing, including when made during preflight.
  visionAttempt.current={stream:camera.state.stream,client};
  if(!client.startVision(camera.state.stream))setVision({status:'unavailable',generation:0});
 },[camera.state.status,camera.state.stream,voiceState,snapshot?.status,endDialog]);
 useEffect(()=>{if(snapshot?.status==='paused'&&voice.current)void stopMedia();},[snapshot?.status,stopMedia]);
 useEffect(()=>{
  if(!snapshot||snapshot.status==='ended')return;
  const leave=(event:BeforeUnloadEvent)=>{if(ended.current)return;event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',leave);return()=>window.removeEventListener('beforeunload',leave);
 },[snapshot?.status]);
 useEffect(()=>{if(endDialog)continueButton.current?.focus();},[endDialog]);
 async function reload(){const result=await readClassroom(classroomId);accept(result.classroom);return result.classroom;}
 function syncDisconnected(epoch:number){
  if(disconnectRead.current?.epoch===epoch)return;
  disconnectRead.current?.controller.abort();const controller=new AbortController();disconnectRead.current={epoch,controller};
  const valid=()=>mounted.current&&!ended.current&&voiceEpoch.current===epoch&&!controller.signal.aborted;
  void(async()=>{
   for(const delay of [0,200,500,1000]){
    if(delay)await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,delay);controller.signal.addEventListener('abort',finish,{once:true});});
    if(!valid())return;
    try{
     const result=await readClassroom(classroomId,AbortSignal.any([controller.signal,AbortSignal.timeout(2500)]));
     if(!valid())return;accept(result.classroom);
     if(result.classroom.status!=='active')return;
    }catch(failure){if(!valid())return;if(failure instanceof AccountRequestError&&failure.status===401){navigate(loginPath);return;}}
   }
  })();
 }
 async function action(type:ClassroomAction['type'],objectIds?:string[]){
  const state=current.current;if(!state||ended.current||locked.current)return null;locked.current=true;setBusy(true);setError('');setNotice('');
  const eventId=crypto.randomUUID(),closing=type==='pause'||type==='end';let target=state;
  const refreshed=async()=>{target=await reload();return target.status==='ended'||(type==='pause'&&target.status==='paused');};
  try{
   if(closing){await stopMedia();if(await refreshed())return target;}
   for(let retry=0;retry<2;retry++){
    try{
     const result=await accountRequest(`/classrooms/${classroomId}/actions`,classroomResponse,{body:{eventId,expectedRevision:target.revision,type,...(objectIds?{objectIds}:{})}});
     accept(result.classroom);return result.classroom;
    }catch(failure){
     if(!closing||retry>0||!(failure instanceof AccountRequestError)||failure.status!==409)throw failure;
     if(await refreshed())return target;
    }
   }
   return null;
  }catch(failure){if(mounted.current){setError(errorMessage(failure));try{await reload();}catch{ /* Keep the last confirmed state visible. */ }}return null;}
  finally{locked.current=false;if(mounted.current)setBusy(false);}
 }
 function connect(){
  const state=current.current;if(!state||ended.current||voice.current||locked.current||mic!=='passed')return;
  setError('');setVoiceFailure(null);setNotice('');setMuted(false);setConnections({device:{status:'checking',rttMs:null},teacher:{status:'checking',rttMs:null}});disconnectRead.current?.controller.abort();disconnectRead.current=null;const epoch=++voiceEpoch.current;
  try{
   if(soundEnabled.current)void sounds.current?.play('hint');
   const client=voiceFactory({classroomId,provider:state.preferences.provider,onState:value=>{if(mounted.current&&epoch===voiceEpoch.current&&!ended.current){voiceConnected.current=value==='connected';elapsedClock.current.setRunning(voiceConnected.current&&current.current?.status==='active',performance.now());setElapsed(elapsedClock.current.read(performance.now()));setVoiceState(value);if(value==='closed'||value==='error'){clearPoint();setChalk(null);setVision({status:'off',generation:0});camera.stop();voice.current?.stopVision();voice.current?.dispose();voice.current=null;syncDisconnected(epoch);}}},onSnapshot:value=>{if(epoch===voiceEpoch.current)accept(value);},onLevel:(role,level)=>{if(mounted.current&&epoch===voiceEpoch.current&&!ended.current)setLevels(previous=>({...previous,[role]:level}));},onError:message=>{if(mounted.current&&epoch===voiceEpoch.current&&!ended.current)setError(message);},onFailure:failure=>{if(mounted.current&&epoch===voiceEpoch.current&&!ended.current)setVoiceFailure(failure);},onPlaybackQueue:milliseconds=>{if(mounted.current&&epoch===voiceEpoch.current&&!ended.current)setPlaybackQueue(milliseconds);},onVisionState:value=>{if(mounted.current&&epoch===voiceEpoch.current&&!ended.current)setVision(value);},onConnectionQuality:update=>{if(mounted.current&&epoch===voiceEpoch.current&&!ended.current)setConnections(previous=>({...previous,[update.link]:update.quality}));},onChalk:writing=>{if(mounted.current&&epoch===voiceEpoch.current&&!ended.current)setChalk(writing);}});
   voice.current=client;setVoiceState('connecting');
   void client.start().catch(failure=>{if(mounted.current&&epoch===voiceEpoch.current&&!ended.current){elapsedClock.current.setRunning(false,performance.now());setError(errorMessage(failure));setVoiceState('error');client.dispose();voice.current=null;syncDisconnected(epoch);}});
  }catch(failure){setError(errorMessage(failure));setVoiceState('error');voice.current?.dispose();voice.current=null;}
 }
 async function check(){
  if(mic==='checking'||ended.current)return;micController.current?.abort();const controller=new AbortController();micController.current=controller;setMic('checking');setError('');
  try{const heard=await checkMicrophone(value=>{if(!controller.signal.aborted&&mounted.current)setMicLevel(value);},controller.signal);if(controller.signal.aborted||!mounted.current)return;setMic(heard?'passed':'failed');if(!heard)setError('还没有听到声音，请靠近麦克风说一句 Hello，再检查一次。');}
  catch(failure){if(!controller.signal.aborted&&mounted.current){setMic('failed');setError(failure instanceof DOMException&&failure.name==='NotAllowedError'?'请允许浏览器使用麦克风，再重新检查。':errorMessage(failure));}}
 }
 function pointObject(objectId:string,at:number){
  if(topic)return;
  const state=current.current,step=state?.course.steps[state.stepIndex];
  const captured=state&&captureClassroomToolState(state);if(!state||!step||!captured?.ok)return;
  const pointId=crypto.randomUUID(),object=state.course.pages.find(page=>page.id===step.pageId)?.objects.find(object=>object.id===objectId);
  const observation={pointId,context:captured.snapshot.context,...(object?{objectId:object.id}:{})};
  reportClassroomPointObservation(classroomId,{...observation,stage:'clicked'});
  const refused=(reason:ClassroomPointReason)=>{reportClassroomPointObservation(classroomId,{...observation,stage:'send_failed',reason});};
  if(state.status!=='active'||voiceState!=='connected'){refused('not_ready');return;}
  if(tool!=='pointer'||busy||locked.current||endDialog){refused('busy');return;}
  if(step.kind==='select'||!Number.isFinite(at)||at<0){refused('invalid_context');return;}
  if(!object){refused('unknown_object');return;}
  if(lastPointSentAt.current!==null&&at-lastPointSentAt.current<500){refused('rate_limited');return;}
  const contextKey=[state.id,state.connectionEpoch,state.stepIndex].join(':');
  setPoint({contextKey,objectId});setError('');
  let sent=false;
  if(!voice.current?.sendPoint)refused('unsupported');
  else try{sent=voice.current.sendPoint({contextKey,objectId},pointId)===true;}catch{refused('unknown');}
  if(sent){lastPointSentAt.current=at;setPointError('');}
  else setPointError('这次指认没有发出，请再点一下。');
 }
 function startDraw(event:PointerEvent<SVGSVGElement>){
  if(topic||tool!=='pen'||busy||voiceState!=='connected'||current.current?.status!=='active')return;
  const state=current.current,step=state.course.steps[state.stepIndex];if(!step)return;
  const value:Draft={pointerId:event.pointerId,stepId:step.id,points:[normalizedPoint(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect())]};draftRef.current=value;setDraft({...value});event.currentTarget.setPointerCapture?.(event.pointerId);event.preventDefault();
 }
 function moveDraw(event:PointerEvent<SVGSVGElement>){const value=draftRef.current;if(!value||value.pointerId!==event.pointerId)return;value.points.push(normalizedPoint(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect()));if(value.points.length>600)value.points.splice(1,1);setDraft({...value,points:[...value.points]});}
 function finishDraw(event:PointerEvent<SVGSVGElement>){
  const value=draftRef.current;draftRef.current=null;setDraft(null);if(!value||value.pointerId!==event.pointerId||current.current?.status!=='active'||voiceState!=='connected')return;
  const state=current.current,step=state.course.steps[state.stepIndex];if(!step||step.id!==value.stepId)return;
  const page=state.course.pages.find(item=>item.id===step.pageId);if(!page)return;
  setMarks(previous=>[...previous,{id:crypto.randomUUID(),pageId:page.id,points:value.points}].slice(-100));
  voice.current?.sendInteraction?.({contextKey:`${state.id}:${state.connectionEpoch}:${state.stepIndex}`,action:'draw',strokeCount:Math.min(100,marks.length+1),pointCount:value.points.length});
  const box=pointsBox(value.points),closed=value.points.length>=8&&box.w>.035&&box.h>.035&&Math.hypot(value.points[0].x-value.points.at(-1)!.x,value.points[0].y-value.points.at(-1)!.y)<.065;
  if(!closed||step.kind!=='select')return;
  const selection=resolveSelection(value.points,page.objects,'pen');
  if(selection.status==='selected'&&selection.ids.length===1)void action('select',selection.ids);else setNotice(selection.status==='ambiguous'?'圈到不止一个了，试着只圈一个。':'这个圈里还没有找到图片。');
 }
 function undoDrawing(){
  const state=current.current,last=marks.at(-1);if(!state||state.status!=='active'||voiceState!=='connected'||!last)return;
  setMarks(value=>value.slice(0,-1));voice.current?.sendInteraction?.({contextKey:`${state.id}:${state.connectionEpoch}:${state.stepIndex}`,action:'undo',strokeCount:marks.length-1,pointCount:last.points.length});
 }
 const state=snapshot,step=state?.course.steps[state.stepIndex],page=state?.course.pages.find(item=>item.id===step?.pageId)??state?.course.pages[0];
 const pointedLabel=point&&state&&point.contextKey===[state.id,state.connectionEpoch,state.stepIndex].join(':')?page?.objects.find(object=>object.id===point.objectId)?.label:null;
 const live=state?.status==='active'&&voiceState==='connected'&&!busy;
 const readingSource=state?courseReadingSource(state.course):null;
 const chalkScope=state?captureClassroomToolState(state):null;
 const chalkCurrent=chalkScope?.ok?{...chalkScope.snapshot,status:voiceState==='connected'&&!endDialog?chalkScope.snapshot.status:'paused'}:null;
 const teacherTalking=levels.teacher>.008,childTalking=!muted&&levels.child>.015;
 const preflight=!!state&&(state.status==='preflight'||(state.status==='active'&&voiceState!=='connected'&&voiceState!=='connecting'));
 const blocked=endDialog||state?.status==='paused'||preflight;
 const visionControls={state:vision,enabled:!!live&&camera.state.status==='on',stop:()=>{voice.current?.stopVision();setVision({status:'off',generation:vision.generation});},toggle:()=>{if(!live||camera.state.status!=='on'||!camera.state.stream)return;if(!voice.current?.startVision(camera.state.stream))setVision({status:'unavailable',generation:vision.generation});}};
 if(loading)return <main className="tk-product tk-real-classroom"><p className="tk-class-loading" role="status">正在读取课堂…</p></main>;
 if(!state)return <main className="tk-product tk-real-classroom"><section className="tk-class-loading"><p className="tk-account-error" role="alert">{error||'课堂暂时无法读取。'}</p><button type="button" className="tk-submit" onClick={()=>{setLoading(true);setAttempt(value=>value+1);}}>重新读取</button><Link href={returnPath}>{returnLabel}</Link></section></main>;
 if(state.status==='ended')return topic?<TopicRecap key={state.id} state={state}/>:<ClassroomRecap key={state.id} state={state}/>;
 return <main className={`tk-product tk-real-classroom${topic?' tk-topic-classroom':''}`}>
  <header className="tk-real-class-header" aria-hidden={blocked||undefined} inert={blocked}><BookOpen size={20}/><strong>{state.course.title}</strong><span>{state.course.subtitle}</span>{diagnosticEntry&&<a href={diagnosticEntry} target="_blank" rel="noopener noreferrer">课堂排查</a>}<time aria-label="已上课时间">{time(state.status==='paused'?state.elapsedSeconds:Math.max(state.elapsedSeconds,elapsed))}</time><button type="button" className="tk-real-exit" aria-label="退出课堂" disabled={busy} onClick={()=>{setExitRequested(true);setEndDialog(true);}}><ArrowLeft size={17}/>退出课堂</button></header>
  <div className="tk-real-call-body" aria-hidden={blocked||undefined} inert={blocked}><section className="tk-real-book-area" aria-label="教材">
   {page&&<div className="tk-real-paper" style={{aspectRatio:`${page.width}/${page.height}`,'--paper-ratio':page.width/page.height} as CSSProperties}><img ref={textbookImage} src={page.image} alt={isReadingStep(step)?`${step.chinese}。${step.reading.passage}`:state.course.title} draggable={false}/>
    <ClassroomChalk key={`${state.id}:${state.connectionEpoch}`} current={chalkCurrent} writing={chalk} onDisplayed={id=>{voice.current?.chalkDisplayed?.(id);}} onExpire={id=>{voice.current?.chalkExpired?.(id);}}/>
    {!topic&&<><ClassroomBoardFeed snapshot={state} enabled={!!live&&!endDialog} image={textbookImage} marks={marks} client={voice} onError={setError}/><div className="tk-real-hotspots">{page.objects.map(object=><button key={object.id} type="button" className={[state.teacherObjectIds.includes(object.id)?'is-highlighted':'',point?.objectId===object.id&&point.contextKey===[state.id,state.connectionEpoch,state.stepIndex].join(':')?'is-pointed':''].filter(Boolean).join(' ')} aria-label={`${step?.kind==='select'?'选择':'指认'} ${object.label}`} aria-pressed={step?.kind==='select'?undefined:point?.objectId===object.id} disabled={!live||tool==='pen'} style={{left:`${object.box.x*100}%`,top:`${object.box.y*100}%`,width:`${object.box.w*100}%`,height:`${object.box.h*100}%`,zIndex:1+page.objects.filter(other=>other.box.w*other.box.h>object.box.w*object.box.h).length}} onClick={event=>{if(step?.kind==='select')void action('select',[object.id]);else pointObject(object.id,event.timeStamp);}}/>)}</div></>}
    <svg className={`tk-real-annotation is-${tool}`} viewBox={`0 0 ${page.width} ${page.height}`} preserveAspectRatio="none" aria-label="教材标注区域" role="img" onPointerDown={startDraw} onPointerMove={moveDraw} onPointerUp={finishDraw} onPointerCancel={()=>{draftRef.current=null;setDraft(null);}}>
     {state.teacherObjectIds.map(id=>{const object=page.objects.find(item=>item.id===id);return object?<ellipse key={id} cx={(object.box.x+object.box.w/2)*page.width} cy={(object.box.y+object.box.h/2)*page.height} rx={object.box.w*page.width*.56} ry={object.box.h*page.height*.56} fill="none" stroke="#19877b" strokeWidth={4}/>:null;})}
     {[...marks.filter(mark=>mark.pageId===page.id),...(draft?[{id:'draft',pageId:page.id,points:draft.points}]:[])].map(mark=><g key={mark.id} className="tk-real-stroke" fill="none" strokeLinecap="round" strokeLinejoin="round"><polyline points={mark.points.map(point=>`${point.x*page.width},${point.y*page.height}`).join(' ')} stroke="#fffdf6" strokeWidth={8}/><polyline points={mark.points.map(point=>`${point.x*page.width},${point.y*page.height}`).join(' ')} stroke="#c95739" strokeWidth={4}/></g>)}
    </svg>
    {readingSource&&<a className="tk-reading-source" href={readingSource.sourceUrl} target="_blank" rel="noopener noreferrer" title={readingSource.sourceTitle} aria-label={`阅读 ${readingSource.sourceTitle} 原文`}>阅读原文<ArrowRight size={13}/></a>}
    {reward&&<div className="tk-real-fireworks" aria-hidden="true">{Array.from({length:16},(_,index)=><i key={index} style={{'--spark-angle':`${index*22.5}deg`,'--spark-color':['#e77838','#e4b64d','#239a8d','#7a87c8'][index%4]} as CSSProperties}/>)}</div>}
   </div>}
   <span className="sr-only" role="status">{pointedLabel?'指向 '+pointedLabel+'。':notice||state.feedback?.message||''}</span>
  </section><aside className="tk-real-call-rail">
   <section className={`tk-real-video-tile tk-real-teacher ${teacherTalking?'is-speaking':''}`}><ConnectionStatus quality={connections.teacher} connected={voiceState==='connected'} connecting={voiceState==='connecting'} role="teacher"/><TeacherStage level={levels.teacher} connected={voiceState==='connected'&&state.status==='active'} childSpeaking={childTalking} celebrating={reward} allowHandoff={state.preferences.provider==='openai'||playbackQueue<=0}/><footer><strong>Teeko 老师</strong><div className="tk-real-level" aria-label="老师声音">{[.35,.7,1,.55].map((scale,index)=><i key={index} style={{height:`${5+Math.min(1,levels.teacher*10)*scale*19}px`}}/>)}</div></footer></section>
   <section className={`tk-real-video-tile tk-real-child ${childTalking?'is-speaking':''}`}><ConnectionStatus quality={connections.device} connected={voiceState==='connected'} connecting={voiceState==='connecting'} role="device"/><div className="tk-real-child-stage">{!preflight&&<ClassroomCameraPreview camera={camera} name={state.profile.name} vision={visionControls} controls={false}/>}</div><footer><strong>{state.profile.name}</strong><div className="tk-real-device-controls"><ClassroomCameraButton camera={camera} vision={visionControls} compact/><button type="button" disabled={voiceState!=='connected'||busy} aria-label={muted?'开启麦克风':'关闭麦克风'} aria-pressed={!muted} title={muted?'开启麦克风':'关闭麦克风'} onClick={()=>{const next=!muted;voice.current?.setMuted(next);setMuted(next);if(next)setLevels(previous=>({...previous,child:0}));}}>{muted?<MicOff size={18}/>:<Mic size={18}/>}</button></div></footer></section>
  </aside></div>
  {(error||pointError)&&!preflight&&!endDialog&&state.status!=='paused'&&<div className="tk-real-error" role="alert">{error||pointError}{diagnosticEntry&&<a href={diagnosticEntry} target="_blank" rel="noopener noreferrer">查看连接轨迹</a>}{voiceState==='error'||voiceState==='closed'?<button type="button" disabled={busy} onClick={()=>{void action('resume').then(result=>{if(result)setVoiceState('idle');});}}>准备重新连接</button>:null}</div>}
  <footer className="tk-real-controls" aria-hidden={blocked||undefined} inert={blocked}>{topic?<span className="tk-topic-speaking-hint"><Mic size={16}/>直接开口，和 Teeko 聊聊</span>:<div className="tk-real-tools"><button type="button" aria-label="指针" aria-pressed={tool==='pointer'} disabled={!live} onClick={()=>setTool('pointer')}><MousePointer2 size={20}/></button><button type="button" aria-label="画笔" aria-pressed={tool==='pen'} disabled={!live} onClick={()=>setTool('pen')}><Pencil size={20}/></button><button type="button" aria-label="撤销笔迹" disabled={!live||!marks.length} onClick={undoDrawing}><Undo2 size={20}/></button></div>}<div className="tk-real-main-controls"><button type="button" aria-label={sound?'关闭互动音效':'开启互动音效'} aria-pressed={sound} onClick={()=>{const next=!sound;setSound(next);soundEnabled.current=next;if(!next)sounds.current?.stop();}}>{sound?<Volume2 size={20}/>:<VolumeX size={20}/>}</button>{!topic&&isReadingStep(step)&&!isOpenClassroomConversation(step)&&<button type="button" aria-label="下一段" disabled={!live} onClick={()=>{void action('next');}}>下一段<ArrowRight size={16}/></button>}{!topic&&isOpenClassroomConversation(step)&&<button type="button" disabled={!live} onClick={()=>{void action('next');}}>查看小结<ArrowRight size={16}/></button>}<button type="button" aria-label="暂停课堂" disabled={busy||voiceState!=='connected'} onClick={()=>{void action('pause');}}><Pause size={18}/>暂停</button><button type="button" className="tk-real-end" aria-label="结束课堂" disabled={busy} onClick={()=>{setExitRequested(false);setEndDialog(true);}}><PhoneOff size={18}/>结束</button></div></footer>
  {preflight&&voiceState!=='connecting'&&!endDialog&&<div className="tk-real-scrim"><section className="tk-real-preflight" aria-label="准备上课"><div className="tk-real-preflight-art"><ClassroomCameraPreview camera={camera} name={state.profile.name} vision={visionControls}/></div><div><h1>准备上课</h1><p>{state.preferences.provider==='grok'?'声音用于实时对话。Grok当前仅支持语音，摄像头仅作本机预览。':'声音用于实时对话。开启摄像头后，老师就能看到你；关闭即停止分享。不出镜也能上课。'}</p><button className="tk-real-check" type="button" disabled={mic==='checking'} onClick={()=>{void check();}}>{mic==='passed'?<Check size={20}/>:<Mic size={20}/>}<span>{mic==='checking'?'请说一句 Hello…':mic==='passed'?'麦克风检查通过':'检查麦克风'}</span>{mic==='checking'&&<meter min={0} max={1} value={micLevel} aria-label="麦克风音量"/>}</button>{error&&<p className="tk-account-error" role="alert">{error}</p>}{(voiceState==='error'||voiceState==='closed')&&<button type="button" className="tk-real-check" disabled={busy} onClick={()=>{void action('resume').then(result=>{if(result)setVoiceState('idle');});}}>准备重新连接<RotateCcw size={16}/></button>}<button type="button" className="tk-submit" disabled={mic!=='passed'||busy||voiceState==='error'||voiceState==='closed'} onClick={connect}>开始上课<ArrowRight size={18}/></button><Link className="tk-real-back" href={returnPath}>{returnLabel}</Link></div></section></div>}
  {voiceState==='connecting'&&!endDialog&&<div className="tk-real-connecting"><span role="status">正在连接老师…</span><button type="button" onClick={()=>{void stopMedia().then(reload).catch(failure=>setError(errorMessage(failure)));}}>取消连接</button></div>}
  {state.status==='paused'&&!endDialog&&<div className="tk-real-scrim"><section className="tk-real-pause" role="dialog" aria-modal="true" aria-label="课堂已暂停"><Pause size={24}/><h2>{voiceFailure?'课堂连接中断':'已暂停'}</h2>{voiceFailure&&<p role="alert" data-voice-failure={voiceFailure.code}>{voiceFailure.message}</p>}{voiceFailure&&diagnosticEntry&&<a href={diagnosticEntry} target="_blank" rel="noopener noreferrer">查看本次连接轨迹</a>}<div><button type="button" className="tk-submit" disabled={busy} onClick={()=>{void action('resume').then(result=>{if(result){setVoiceState('idle');setVoiceFailure(null);setError('');}});}}><Play size={18}/>继续上课</button><button type="button" disabled={busy} onClick={()=>{setExitRequested(false);setEndDialog(true);}}>结束课堂</button></div></section></div>}
  {endDialog&&<div className="tk-real-scrim"><section className="tk-real-pause" role="dialog" aria-modal="true" aria-label={exitRequested?'退出确认':'结束确认'} onKeyDown={event=>{if(event.key==='Escape'&&!busy){event.preventDefault();setEndDialog(false);}if(event.key==='Tab'){const buttons=event.currentTarget.querySelectorAll<HTMLButtonElement>('button');const first=buttons[0],last=buttons[buttons.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}}><h2>{exitRequested?'退出这节课堂？':'今天就学到这里？'}</h2><p>{exitRequested?`保存本次记录后，${returnLabel}。`:'结束后保留本次记录。'}</p>{error&&<p className="tk-account-error" role="alert">{error}</p>}<div><button type="button" className="tk-submit" ref={continueButton} disabled={busy} onClick={()=>setEndDialog(false)}>继续上课</button><button type="button" className="tk-real-danger" disabled={busy} onClick={()=>{void action('end').then(result=>{if(exitRequested&&result?.status==='ended'&&mounted.current)navigate(returnPath);});}}>{exitRequested?'保存并退出':'结束并保存'}</button></div></section></div>}
 </main>;
}
