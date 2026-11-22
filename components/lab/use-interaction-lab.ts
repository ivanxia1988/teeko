import {useCallback,useEffect,useRef,useState} from 'react';
import type {ClassroomSnapshot} from '../../lib/classroom-contract';
import {ClassroomVoiceClient} from '../../lib/classroom-voice-client';
import {LAB_EVENT_LIMIT,labBase64Bytes,labBrowserWireEvent,type LabEvent,type LabEventBatch,type LabEventInput,type LabSession} from '../../lib/interaction-lab';
import {labTeacherMark,type LabTeacherMark} from '../../lib/interaction-lab-mark';
import {labVisualContext,parseLabVisualMessage,type LabVisualMessage,type LabVisualPrepare,type LabVisualReady} from '../../lib/interaction-lab-visual';
import {PcmVoiceAudio,type PcmVoiceAudioOptions} from '../../lib/voice-audio';

type LabState='idle'|'connecting'|'connected'|'closing'|'closed'|'error';
export type LabMode='guided'|'gpt-live';
export type InteractionLabController={
 state:LabState;snapshot:ClassroomSnapshot|null;events:LabEvent[];teacherMarks:LabTeacherMark[];error:string|null;teacherLevel:number;childLevel:number;
 audioPaused:boolean;resumeOutput():void;
 guided:boolean;start(mode?:LabMode):Promise<void>;stop():Promise<void>;navigateGuide(stepIndex:number):Promise<boolean>;acknowledgeGuide(revision:number):void;
 acknowledgeMark(actionId:string):void;selectText(targetId:string):Promise<boolean>;sendPoint(objectId:string):boolean;sendText(text:string):boolean;
 observe(event:LabEventInput):void;
 prepareVisual(input:LabVisualPrepare):boolean;finishVisual(input:LabVisualReady):boolean;clearVisual(contextKey:string,id?:string):boolean;
};
type Attempt={
 abort:AbortController;client?:ClassroomVoiceClient;socket?:WebSocket;audio?:AudioContext;snapshot?:ClassroomSnapshot;
 removeAudioListener?:()=>void;
 pollTimer?:ReturnType<typeof setTimeout>;finishTimer?:ReturnType<typeof setTimeout>;closing:boolean;guided:boolean;lastTypedAt?:number;
};

class LabGptVoiceAudio extends PcmVoiceAudio{
 constructor(options:PcmVoiceAudioOptions,private readonly output:AudioContext){super(options,{context:()=>output});}

 override playChunk(...args:Parameters<PcmVoiceAudio['playChunk']>){
  if(this.output.state==='running')super.playChunk(...args);
 }
}

function cancel(attempt:Attempt){
 attempt.abort.abort();
 if(attempt.pollTimer)clearTimeout(attempt.pollTimer);
 if(attempt.finishTimer)clearTimeout(attempt.finishTimer);
 attempt.removeAudioListener?.();
 attempt.client?.dispose();
 if(attempt.audio&&attempt.audio.state!=='closed')void attempt.audio.close().catch(()=>{});
}

export function useInteractionLab():InteractionLabController{
 const [state,setState]=useState<LabState>('idle'),[snapshot,setSnapshot]=useState<ClassroomSnapshot|null>(null);
 const [events,setEvents]=useState<LabEvent[]>([]),[error,setError]=useState<string|null>(null);
 const [guided,setGuided]=useState(false);
 const [teacherMarks,setTeacherMarks]=useState<LabTeacherMark[]>([]);
 const [teacherLevel,setTeacherLevel]=useState(0),[childLevel,setChildLevel]=useState(0);
 const [audioPaused,setAudioPaused]=useState(false);
 const active=useRef<Attempt|null>(null),index=useRef(0);
 const append=useCallback((batch:LabEvent[])=>{
  setEvents(previous=>{
   const unique=new Map(previous.map(event=>[event.id,event]));
   for(const event of batch)unique.set(event.id,event);
   return [...unique.values()].sort((a,b)=>a.at-b.at).slice(-LAB_EVENT_LIMIT);
  });
 },[]);
 const observe=useCallback((event:LabEventInput)=>append([{...event,at:Date.now(),id:`browser-${++index.current}`}]),[append]);
 useEffect(()=>()=>{const attempt=active.current;active.current=null;if(attempt)cancel(attempt);},[]);

 const start=useCallback(async(mode?:LabMode)=>{
  if(active.current&&!active.current.closing)return;
  if(active.current){const old=active.current;active.current=null;cancel(old);}
  const attempt:Attempt={abort:new AbortController(),closing:false,guided:mode!==undefined};active.current=attempt;
  let reportedError=false;
  const current=()=>active.current===attempt&&!attempt.abort.signal.aborted;
  const finish=()=>{
   if(!current()||attempt.closing)return;
   attempt.closing=true;
   setAudioPaused(false);
   // Fetch the final close/error receipt after the microphone and socket stop.
   attempt.finishTimer=setTimeout(()=>{if(active.current===attempt){active.current=null;cancel(attempt);}},1350);
  };
  setGuided(attempt.guided);setState('connecting');setError(null);setSnapshot(null);setEvents([]);setTeacherMarks([]);setTeacherLevel(0);setChildLevel(0);setAudioPaused(false);
  observe({layer:'browser',kind:'connection',label:'开始建立本地实验连接'});
  const report=(message:string)=>{
   if(!current())return;
   reportedError=true;setError(message);
   observe({layer:'browser',kind:'error',label:message});
  };
  try{
   if(typeof AudioContext==='undefined'||!navigator.mediaDevices?.getUserMedia)throw new Error('browser_audio_unavailable');
   // Preserve the real click's audio authorization across the session bootstrap request.
   const audio=new AudioContext({latencyHint:'interactive'});attempt.audio=audio;
   let wasRunning=false;
   let gptAudio:LabGptVoiceAudio|undefined;
   const updateAudioState=()=>{
    if(!current()||attempt.closing)return;
    const running=audio.state==='running',paused=!running&&audio.state!=='closed';
    setAudioPaused(paused);
    if(wasRunning&&paused){
     gptAudio?.cancelPlayback();
     observe({layer:'browser',kind:'error',label:'浏览器暂停了声音，可以点击恢复声音',data:{state:audio.state}});
    }
    wasRunning=running;
   };
   audio.addEventListener('statechange',updateAudioState);
   attempt.removeAudioListener=()=>audio.removeEventListener('statechange',updateAudioState);
   updateAudioState();
   void audio.resume().catch(()=>{});
   const provider=mode==='gpt-live'?'openai':'qwen';
   const sessionPath=mode==='gpt-live'?'/lab/session?mode=guided&provider=openai':mode==='guided'?'/lab/session?mode=guided':'/lab/session';
   const response=await fetch(sessionPath,{method:'POST',cache:'no-store',signal:attempt.abort.signal});
   if(!response.ok)throw new Error('lab_bootstrap_failed');
   const session=await response.json() as LabSession;
   if(!current()||attempt.closing)return;
   if(!session.id||session.snapshot?.id!==session.id||session.snapshot.preferences.provider!==provider)throw new Error('lab_bootstrap_failed');
   attempt.snapshot=session.snapshot;setSnapshot(session.snapshot);
   let cursor=0,pollFailed=false,firstAudioFrame=false;
   const poll=async()=>{
    if(!current())return;
    try{
     const result=await fetch(`/lab/events/${encodeURIComponent(session.id)}?after=${cursor}`,{cache:'no-store',signal:attempt.abort.signal});
     if(!result.ok)throw Error('trace_unavailable');
     const batch=await result.json() as LabEventBatch;
     if(!current())return;
     if(!Array.isArray(batch.events)||!Number.isSafeInteger(batch.cursor)||batch.cursor<cursor)throw Error('trace_unavailable');
     cursor=batch.cursor;
     if(batch.events.length){
      append(batch.events);
      const marks=batch.events.map(labTeacherMark).filter((mark):mark is LabTeacherMark=>mark!==null);
      const removed=new Set(batch.events.filter(event=>event.layer==='server'&&event.data?.event==='teacher.mark.cancelled').map(event=>event.data?.actionId));
      if(marks.length||removed.size)setTeacherMarks(previous=>{
       const unique=new Map(previous.map(mark=>[mark.actionId,mark]));
       for(const mark of marks)if(!unique.has(mark.actionId))unique.set(mark.actionId,mark);
       for(const id of removed)if(typeof id==='string')unique.delete(id);
       return [...unique.values()].slice(-12);
      });
     }
     pollFailed=false;
    }catch{
     if(current()&&!pollFailed){pollFailed=true;observe({layer:'browser',kind:'error',label:'未取到后台事件，语音状态以连接提示为准'});}
    }finally{
     if(current())attempt.pollTimer=setTimeout(()=>void poll(),330);
    }
   };
   void poll();
   const client=new ClassroomVoiceClient({classroomId:session.id,provider,
    onState(next){
     if(!current())return;
     setState(next);
     if(next==='connected')observe({layer:'browser',kind:'connection',label:'麦克风就绪，可以开始互动'});
     if(next==='closed'||next==='error')finish();
    },
    onSnapshot(next){if(current()&&next.revision>=(attempt.snapshot?.revision??0)){attempt.snapshot=next;setSnapshot(next);}},
    onLevel(role,level){if(current())(role==='teacher'?setTeacherLevel:setChildLevel)(level);},
    onError(message){if(message)report(message);else if(current())setError(null);},
   },{
    audio:options=>provider==='openai'?(gptAudio=new LabGptVoiceAudio(options,audio)):new PcmVoiceAudio(options,{context:()=>audio}),
    pointDiagnostics(event){
     if(!current())return;
     if(event.stage==='acknowledged')observe({layer:'browser',kind:'point',label:'浏览器收到点选确认',data:{pointId:event.pointId}});
     else if(['send_failed','unavailable','timeout'].includes(event.stage))observe({layer:'browser',kind:'error',label:'这次点选未成功确认',data:{pointId:event.pointId,reason:event.reason??event.stage}});
    },
    socket(url){
     const ws=new WebSocket(url),send=ws.send.bind(ws);
     attempt.socket=ws;
     ws.send=(message)=>{
      send(message);
      if(!current()||typeof message!=='string'||message.length>50000)return;
      try{
       const wire=JSON.parse(message),record=labBrowserWireEvent(wire);
       if(record)observe(record);
       if(!firstAudioFrame&&wire.type==='audio'){
        firstAudioFrame=true;
        observe({layer:'browser',kind:'audio',label:'麦克风发出首帧 PCM（可能为静音）',data:{event:'audio',sampleRate:provider==='openai'?24000:16000,bytes:labBase64Bytes(wire.audio)??0}});
       }
      }catch{/* Diagnostics cannot change delivery. */}
     };
     return ws;
    },
   });
   attempt.client=client;
   await client.start();
  }catch(reason){
   if(!current()||attempt.closing)return;
   if(!reportedError)report(reason instanceof Error&&reason.message==='browser_audio_unavailable'?'当前浏览器无法打开本地麦克风。':'实验语音服务未就绪，请检查麦克风权限或稍后重试。');
   if(attempt.audio&&attempt.audio.state!=='closed')void attempt.audio.close().catch(()=>{});
   setState('error');finish();
  }
 },[append,observe]);

 const resumeOutput=useCallback(()=>{
  const attempt=active.current,audio=attempt?.audio;
  if(!attempt||!audio||attempt.closing||audio.state==='closed'||audio.state==='running')return;
  void audio.resume().then(()=>{
   if(active.current===attempt&&!attempt.closing&&audio.state==='running')observe({layer:'browser',kind:'audio',label:'浏览器已恢复声音播放',data:{event:'audio.resumed'}});
  },()=>{
   if(active.current===attempt&&!attempt.closing)observe({layer:'browser',kind:'error',label:'浏览器暂时无法恢复声音'});
  });
 },[observe]);

 const stop=useCallback(async()=>{
  const attempt=active.current;if(!attempt||attempt.closing)return;
  setState('closing');setAudioPaused(false);
  if(!attempt.client){
   active.current=null;cancel(attempt);setState('closed');
   observe({layer:'browser',kind:'connection',label:'已取消连接'});
   return;
  }
  await attempt.client.stop();
 },[observe]);
 const guideRequest=useCallback(async(attempt:Attempt,query:string)=>{
  if(!attempt.snapshot)return false;
  try{
   const response=await fetch(`/lab/guide/${encodeURIComponent(attempt.snapshot.id)}?${query}`,{method:'POST',cache:'no-store',signal:attempt.abort.signal});
   return response.ok&&active.current===attempt&&!attempt.closing;
  }catch{return false;}
 },[]);
 const navigateGuide=useCallback(async(stepIndex:number)=>{
  const attempt=active.current,snapshot=attempt?.snapshot;
  if(!attempt?.guided||attempt.closing||!snapshot||snapshot.status!=='active'||!Number.isSafeInteger(stepIndex)||!snapshot.course.steps[stepIndex]||snapshot.stepIndex===stepIndex)return false;
  return guideRequest(attempt,`step=${stepIndex}&revision=${snapshot.revision}`);
 },[guideRequest]);
 const acknowledgeGuide=useCallback((revision:number)=>{
  const attempt=active.current;
  if(attempt?.guided&&!attempt.closing&&attempt.snapshot?.status==='active'&&attempt.snapshot.revision===revision)void guideRequest(attempt,`display=${revision}`);
 },[guideRequest]);
 const acknowledgeMark=useCallback((actionId:string)=>{
  const attempt=active.current;
  if(attempt?.snapshot?.preferences.provider==='openai')void guideRequest(attempt,`mark=${encodeURIComponent(actionId)}`);
 },[guideRequest]);
 const selectText=useCallback(async(targetId:string)=>{
  const attempt=active.current,snapshot=attempt?.snapshot;
  if(!attempt||snapshot?.preferences.provider!=='openai')return false;
  return guideRequest(attempt,`select=${encodeURIComponent(targetId)}&revision=${snapshot.revision}`);
 },[guideRequest]);
 const sendPoint=useCallback((objectId:string)=>{
  const attempt=active.current,snap=attempt?.snapshot;
  return !!(snap&&attempt?.client?.sendPoint({contextKey:[snap.id,snap.connectionEpoch,snap.stepIndex].join(':'),objectId}));
 },[]);
 const sendText=useCallback((text:string)=>{
  const attempt=active.current,now=performance.now();
  if(!attempt?.client||attempt.closing||now-(attempt.lastTypedAt??-Infinity)<650||!attempt.client.sendText(text))return false;
  attempt.lastTypedAt=now;return true;
 },[]);
 const sendVisual=useCallback((input:LabVisualMessage)=>{
  const attempt=active.current,socket=attempt?.socket;
  if(!attempt||attempt.closing||!attempt.snapshot||input.contextKey!==labVisualContext(attempt.snapshot)||!socket||socket.readyState!==WebSocket.OPEN)return false;
  if(input.type==='lab.visual.ready'&&socket.bufferedAmount>8192)return false;
  const wire=parseLabVisualMessage(input);if(!wire)return false;
  try{socket.send(JSON.stringify(wire));return true;}catch{return false;}
 },[]);
 const prepareVisual=useCallback((input:LabVisualPrepare)=>sendVisual({...input,type:'lab.visual.stage'}),[sendVisual]);
 const finishVisual=useCallback((input:LabVisualReady)=>sendVisual({...input,type:'lab.visual.ready'}),[sendVisual]);
 const clearVisual=useCallback((contextKey:string,id?:string)=>sendVisual({type:'lab.visual.clear',contextKey,...(id?{id}:{})}),[sendVisual]);
 return {state,snapshot,events,teacherMarks,error,teacherLevel,childLevel,audioPaused,resumeOutput,guided,start,stop,navigateGuide,acknowledgeGuide,acknowledgeMark,selectText,sendPoint,sendText,prepareVisual,finishVisual,clearVisual,observe};
}
