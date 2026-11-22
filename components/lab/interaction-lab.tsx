'use client';

import {Fragment,useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type MouseEvent,type PointerEvent} from 'react';
import {Activity,ArrowDownRight,AudioLines,BookOpen,Mic,MousePointer2,Pencil,Send,Square,Undo2} from 'lucide-react';
import {captureClassroomBoard,type BoardStroke} from '../../lib/classroom-board';
import {LAB_IMAGE,labBase64Bytes,type LabEvent} from '../../lib/interaction-lab';
import {captureLabRegion} from '../../lib/interaction-lab-capture';
import type {LabTeacherMark} from '../../lib/interaction-lab-mark';
import {LAB_ILLUSTRATION,LAB_READ_ILLUSTRATION,labTextbook,labTextTarget} from '../../lib/interaction-lab-textbook';
import {labVisualContext,type LabVisualPrepare} from '../../lib/interaction-lab-visual';
import type {PageObject,Point} from '../../lib/types';
import {useInteractionLab,type InteractionLabController,type LabMode} from './use-interaction-lab';

type Stroke=BoardStroke&{id:number};
const layers={browser:'浏览器',server:'后台',provider:'通义',display:'页面'} as const;
const layerNames=Object.keys(layers) as (keyof typeof layers)[];
const states={idle:'未连接',connecting:'正在连接',connected:'已连接',closing:'正在断开',closed:'已断开',error:'连接异常'};
const eventNames={connection:'连接',speech:'对话',point:'点选',image:'图像',tool:'动作',audio:'声音',error:'异常'};
const examples=['Please circle the wings.','Please highlight this word.','Please underline this word.','Please underline the title.'] as const;
const markLabels={circle:'教材上已画出老师的圈',underline:'教材上已画出老师的下划线',highlight:'教材上已显示老师的高亮'} as const;
const noObjects:PageObject[]=[];
const noMarks:string[]=[];
const noTeacherMarks:LabTeacherMark[]=[];
// Paper coordinates from the body in robot-reading-predict-illustration.svg. The larger touch target also overlaps the tail.
const robotBodyRing={cx:450,cy:287,rx:48,ry:88};

function coordinates(clientX:number,clientY:number,rect:DOMRect):Point|null{
 if(rect.width<=0||rect.height<=0)return null;
 const normalize=(value:number)=>Math.round(Math.min(1,Math.max(0,value))*1000)/1000;
 return{x:normalize((clientX-rect.left)/rect.width),y:normalize((clientY-rect.top)/rect.height)};
}
function pointString(points:Point[],width:number,height:number){return points.map(p=>`${p.x*width},${p.y*height}`).join(' ');}

function TeacherMark({mark,width,height}:{mark:LabTeacherMark;width:number;height:number}){
 const {actionId,shape,targetId,box:{x,y,w,h}}=mark;
 const attrs={'data-action-id':actionId,'data-target-id':targetId,className:'tl-teacher-mark',vectorEffect:'non-scaling-stroke'};
 if(shape==='circle')return <ellipse {...attrs} cx={(x+w/2)*width} cy={(y+h/2)*height} rx={w*width*.58} ry={h*height*.70}/>;
 if(shape==='highlight')return <rect {...attrs} className="tl-teacher-highlight" x={x*width} y={y*height} width={w*width} height={h*height} rx={4}/>;
 const baseline=Math.min(height-3,(y+h)*height+4);
 return <line {...attrs} x1={x*width} x2={(x+w)*width} y1={baseline} y2={baseline}/>;
}

function Textbook({pageId,marks,guideTargets,selected,pointable,onPoint}:{pageId:string;marks:Map<string,Set<LabTeacherMark['shape']>>;guideTargets:readonly string[];selected:string|null;pointable:boolean;onPoint:(id:string,event:MouseEvent<HTMLButtonElement>)=>void}){
 const styling=(id:string)=>{
  const shapes=marks.get(id);
  return {'data-text-id':id,'data-circle':shapes?.has('circle')||undefined,'data-underline':shapes?.has('underline')||undefined,'data-highlight':shapes?.has('highlight')||undefined,'data-guide-highlight':guideTargets.includes(id)||undefined};
 };
 return <section className="tl-textbook" aria-label="机器人带读教材" lang="en">
  <div className="tl-reading-backdrop" aria-hidden="true"/>
  {labTextbook(pageId).map(block=>{
   const Text=block.kind==='title'?'h3':'p';
   return <Fragment key={block.id}>
    <Text className={`tl-text-block tl-text-${block.kind}`} {...styling(block.id)}>
     {block.parts.map(({id,text},index)=>id?
      <button type="button" className="tl-word" key={id} {...styling(id)} aria-pressed={selected===id} disabled={!pointable} onClick={event=>onPoint(id,event)}>{text}</button>:
      <Fragment key={index}>{text}</Fragment>)}
    </Text>
    {block.kind==='title'&&
     // eslint-disable-next-line @next/next/no-img-element
     <img className="tl-illustration" src={pageId==='robot-read'?LAB_READ_ILLUSTRATION:LAB_ILLUSTRATION} alt="会飞又会游的机器人教材插图" draggable={false}/>}
   </Fragment>;
  })}
 </section>;
}

function guideTimelineLabel(event:LabEvent,objects:readonly PageObject[],events:LabEvent[]){
 const data=event.data,code=data?.event;
 const objectName=(id:unknown)=>objects.find(object=>object.id===id)?.chinese;
 if(code==='guide.highlight.displayed'){
  const part=objectName(data?.targetIds),word=labTextTarget(data?.targetIds);
  if(part)return '页面已圈出'+part;
  if(word)return '页面已高亮 “'+word.text+'”';
 }
 if(code==='interaction.point'&&event.layer==='browser')return '你点了'+(objectName(data?.objectId)??'教材图案');
 if(code==='response.create'&&event.layer==='provider'&&data?.objectId)return (objectName(data.objectId)??'点选对象')+'已发给通义';
 if(code==='point.playback_started'&&typeof data?.pointId==='string'){
  const point=events.find(entry=>entry.layer==='browser'&&entry.data?.event==='interaction.point'&&entry.data.pointId===data.pointId);
  const name=objectName(point?.data?.objectId??data.objectId);
  return name?'开始播放老师对'+name+'的回应':'开始播放老师对本次点选的回应';
 }
 if(event.kind==='point'&&['server_rejected','cancelled','expired'].includes(String(data?.stage)))return event.label;
 if(event.transcript||event.kind==='error'||code==='diagnostic.playback'||code==='audio.resumed'||code==='gpt.audio.withheld'||data?.reason==='learner_speech')return event.label;
 if(typeof code==='string'&&code.startsWith('teacher.mark'))return event.label;
 if(typeof code==='string'&&code.startsWith('guide.')&&code!=='guide.highlight.requested')return event.label;
 return null;
}

function Trace({events,guided,objects,providerName}:{events:LabEvent[];guided:boolean;objects:readonly PageObject[];providerName:string}){
 const scroller=useRef<HTMLDivElement>(null),tracking=useRef(true);
 const [follow,setFollow]=useState(true);
 const [showAll,setShowAll]=useState(false);
 const entries=events.flatMap(event=>{
  const label=guided&&!showAll?guideTimelineLabel(event,objects,events):event.label;
  return label?[{event,label}]:[];
 });
 const tail=entries.at(-1)?.event.id;
 function toLatest(){
  if(scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight;
  tracking.current=true;setFollow(true);
 }
 useEffect(()=>{if(tracking.current&&scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight;},[tail]);
 const first=events[0]?.at??0;
 return <section className="tl-panel tl-trace" aria-labelledby="lab-trace-title">
  <header className="tl-panel-head">
   <div className="tl-section-title"><span className="tl-index">02</span><div><h2 id="lab-trace-title">实时处理轨迹</h2><p>按本页观察到的顺序显示，展开查看传输字段。</p></div></div>
   <button type="button" className="tl-small tl-jump" onClick={toLatest} disabled={follow||!events.length}><ArrowDownRight size={16}/>最新</button>
  </header>
  <ol className="tl-pipeline" aria-label="处理环节">{layerNames.map(layer=><li key={layer} data-layer={layer}><span className="tl-dot"/>{layer==='provider'?providerName:layers[layer]}</li>)}</ol>
  {guided&&<div className="tl-trace-views" role="group" aria-label="轨迹显示范围">
   <button type="button" className="tl-small" aria-pressed={!showAll} onClick={()=>setShowAll(false)}>带读时间轴</button>
   <button type="button" className="tl-small" aria-pressed={showAll} onClick={()=>setShowAll(true)}>全部事件</button>
  </div>}
  <div className="tl-trace-scroll" tabIndex={0} role="region" aria-label="处理事件明细" ref={scroller} onScroll={event=>{
   const el=event.currentTarget,isEnd=el.scrollHeight-el.clientHeight-el.scrollTop<=40;
   tracking.current=isEnd;setFollow(isEnd);
  }}>
   {!entries.length?<div className="tl-empty"><Activity size={28}/><strong>等待第一次交互</strong><p>连上老师后点一处，或说一句话。<br/>这里会显示动作有没有走到后台和老师。</p></div>:
   <ol className="tl-events">
    {entries.map(({event,label})=>{
     const offset=Math.max(0,event.at-first),hasDetails=!!event.data&&Object.keys(event.data).length>0;
     return <li key={event.id} data-layer={event.layer} data-kind={event.kind}>
      <span className="tl-dot"/>
      <div className="tl-event-card">
       <div className="tl-event-meta"><span>{event.layer==='provider'?providerName:layers[event.layer]} · {eventNames[event.kind]}</span><time>+{(offset/1000).toFixed(2)} s</time></div>
       <strong>{label}</strong>
       {event.transcript&&<p className="tl-event-quote">{event.transcript.text}</p>}
       {hasDetails&&<details><summary>查看实际字段</summary><dl>{Object.entries(event.data!).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>)}</dl></details>}
      </div>
     </li>;
    })}
   </ol>}
  </div>
  <footer className="tl-trace-foot"><span>{events.length} 条事件</span><span>不显示原始音频、提示词或密钥</span></footer>
 </section>;
}

export function InteractionLabView({controller,capture=captureClassroomBoard,captureRegion=captureLabRegion}:{controller:InteractionLabController;capture?:typeof captureClassroomBoard;captureRegion?:typeof captureLabRegion}){
 const {state,snapshot,events,teacherMarks,error,teacherLevel,childLevel,audioPaused,guided}=controller;
 const [tool,setTool]=useState<'pointer'|'pen'>('pointer');
 const [pointed,setPointed]=useState<string|null>(null);
 const [pointedText,setPointedText]=useState<string|null>(null);
 const [pointedRegion,setPointedRegion]=useState<Point|null>(null);
 const [strokes,setStrokes]=useState<Stroke[]>([]);
 const [draft,setDraft]=useState<Stroke|null>(null);
 const [lastConnectedMarks,setLastConnectedMarks]=useState<{scope:string;marks:LabTeacherMark[]}|null>(null);
 const [text,setText]=useState('');
 const [notice,setNotice]=useState('');
 const [navigationPending,setNavigationPending]=useState(false);
 const [picture,setPicture]=useState<{id:string;src:string;bytes:number;width:number;height:number;kind:LabVisualPrepare['kind']}|null>(null);
 const paper=useRef<HTMLDivElement>(null),image=useRef<HTMLImageElement>(null),input=useRef<HTMLInputElement>(null);
 const gesture=useRef<(Stroke&{pointerId:number})|null>(null),nextStroke=useRef(0);
 const currentStrokes=useRef<Stroke[]>([]),visual=useRef<LabVisualPrepare|null>(null);
 const current=useRef(controller);
 useLayoutEffect(()=>{current.current=controller;});
 const connected=state==='connected';
 const gptLive=snapshot?.preferences.provider==='openai';
 const providerName=gptLive?'GPT Live':snapshot?'通义':'语音服务';
 const step=snapshot?.course.steps[snapshot.stepIndex],page=snapshot?.course.pages.find(candidate=>candidate.id===step?.pageId);
 const pageId=page?.id,objects=page?.objects??noObjects;
 const [boardPage,setBoardPage]=useState(page?.id);
 if(guided&&page&&boardPage!==page.id){
  setBoardPage(page.id);
  setPointed(null);setPointedText(null);setPointedRegion(null);setStrokes([]);setDraft(null);setTool('pointer');setPicture(null);setNotice('');
 }
 useLayoutEffect(()=>{
  if(!guided)return;
  gesture.current=null;currentStrokes.current=[];visual.current=null;
 },[guided,page?.id]);
 const markScope=snapshot?.status==='active'&&page?`${snapshot.id}:${snapshot.connectionEpoch}:${page.id}`:'';
 if(connected&&markScope&&(lastConnectedMarks?.scope!==markScope||lastConnectedMarks.marks!==teacherMarks)){
  setLastConnectedMarks({scope:markScope,marks:teacherMarks});
 }
 const reviewing=state==='closing'||state==='closed'||state==='error';
 // The final diagnostics poll may include actions the browser never displayed while connected.
 const visibleMarks=connected?teacherMarks:reviewing&&lastConnectedMarks?.scope===markScope?lastConnectedMarks.marks:noTeacherMarks;
 const pageRevision=snapshot?.revision;
 const currentMarks=markScope?visibleMarks.filter(mark=>mark.pageId===pageId&&(mark.revision===undefined||mark.revision===pageRevision)):noTeacherMarks;
 const captureSource=page?.image??LAB_IMAGE,htmlPage=captureSource===LAB_IMAGE||gptLive&&pageId==='robot-read';
 const textMarks=new Map<string,Set<LabTeacherMark['shape']>>();
 if(htmlPage)for(const mark of currentMarks){
  if(!labTextTarget(mark.targetId,pageId??'robot-predict'))continue;
  const shapes=textMarks.get(mark.targetId)??new Set<LabTeacherMark['shape']>();
  shapes.add(mark.shape);textMarks.set(mark.targetId,shapes);
 }
 const width=page?.width??900,height=page?.height??720;
 const conversation=events.filter((entry):entry is LabEvent&{transcript:NonNullable<LabEvent['transcript']>}=>!!entry.transcript).slice(-8);
 const teacherObjects=snapshot?.teacherObjectIds??noMarks;
 const guideTargets=guided&&connected?teacherObjects:noMarks;
 const visualReceipt=picture&&events.findLast(event=>(event.layer==='server'||event.layer==='provider')&&event.data?.visualId===picture.id);
 const receivedState=visualReceipt?.data?.state;
 const visualStatus=receivedState==='speech_ended'?'教材图已关联到你刚才的语音。':receivedState==='provider_sent'?'教材图已随本轮语音发给通义。':receivedState==='provider_rejected'?'通义未接受图片，请重新点一下或画一笔。':receivedState==='speech_superseded'?'这张教材图未确认关联到语音。':visualReceipt?.label==='待用教材图已取消'?'这张教材图没有随语音发送。':null;
 const guideReceipt=useRef('');
 useLayoutEffect(()=>{
  if(!guided||!connected||!snapshot||!pageId||!markScope||!teacherObjects.length)return;
  const drawn=paper.current?.querySelectorAll<HTMLElement|SVGElement>('[data-guide-highlight="true"]');
  const visible=drawn&&teacherObjects.every(id=>Array.from(drawn).some(el=>(el.dataset.textId??el.dataset.objectId)===id));
  const receipt=markScope+':'+snapshot.revision;
  if(!visible||guideReceipt.current===receipt)return;
  guideReceipt.current=receipt;
  current.current.acknowledgeGuide(snapshot.revision);
 },[guided,connected,snapshot,markScope,teacherObjects,objects,htmlPage,pageId]);
 const previousMarks=useRef<{scope:string;key:string}|null>(null);
 const displayedMarks=useRef({scope:'',ids:new Set<string>()});
 useEffect(()=>{
  if(!connected||!markScope)return;
  if(displayedMarks.current.scope!==markScope)displayedMarks.current={scope:markScope,ids:new Set()};
  const textNodes=Array.from(paper.current?.querySelectorAll('[data-text-id]')??[]);
  for(const {actionId,shape,targetId} of currentMarks){
   if(displayedMarks.current.ids.has(actionId))continue;
   const rendered=textMarks.get(targetId)?.has(shape)
    ?textNodes.some(node=>node.getAttribute('data-text-id')===targetId&&node.getAttribute('data-'+shape)==='true')
    :paper.current?.querySelector('[data-action-id="'+actionId+'"]');
   if(!rendered)continue;
   displayedMarks.current.ids.add(actionId);
   if(gptLive)current.current.acknowledgeMark(actionId);
   else current.current.observe({layer:'display',kind:'tool',label:markLabels[shape],data:{event:'teacher.mark.displayed',actionId,shape,targetId}});
  }
 });
 useEffect(()=>{
  if(guided||!connected||!snapshot)return;
  const scope=`${snapshot.id}:${snapshot.connectionEpoch}:${step?.pageId??''}`;
  const key=teacherObjects.filter(id=>objects.some(object=>object.id===id)).join(',');
  if(previousMarks.current?.scope===scope&&previousMarks.current.key===key)return;
  previousMarks.current={scope,key};
  if(key)current.current.observe({layer:'display',kind:'tool',label:'教材上已绘制老师的圈选',data:{objectIds:key,action:'highlight_objects'}});
 },[guided,connected,snapshot,step?.pageId,objects,teacherObjects]);
 useEffect(()=>()=>{visual.current=null;},[]);

 async function toggle(mode?:LabMode){
  setNotice('');
  if(connected||state==='connecting'){
   visual.current=null;gesture.current=null;setDraft(null);
   await controller.stop();return;
  }
  visual.current=null;currentStrokes.current=[];setPicture(null);setPointed(null);setPointedText(null);setPointedRegion(null);setTool('pointer');setStrokes([]);setDraft(null);
  try{if(mode)await controller.start(mode);else await controller.start();}catch{setNotice('没有连上老师，请重试。');}
 }
 async function navigate(stepIndex:number){
  if(navigationPending)return;
  setNavigationPending(true);setNotice('');
  try{
   if(!await controller.navigateGuide(stepIndex))setNotice('没能翻页，请重试。');
  }finally{setNavigationPending(false);}
 }
 function point(object:PageObject,event:MouseEvent<HTMLButtonElement>){
  if(!connected||tool!=='pointer'||!paper.current)return;
  event.stopPropagation();
  if(visual.current?.kind==='region'){
   controller.clearVisual(visual.current.contextKey,visual.current.id);visual.current=null;setPicture(null);
  }
  setPointed(object.id);setPointedText(null);setPointedRegion(null);setNotice('');
  const coords=event.detail>0?coordinates(event.clientX,event.clientY,paper.current.getBoundingClientRect()):null;
  controller.observe({layer:'browser',kind:'point',label:`命中教材对象：${object.chinese}`,data:{objectId:object.id,label:object.label,geometrySent:false,screenshotSent:false,...(coords?{localX:coords.x,localY:coords.y}:{})}});
  if(!controller.sendPoint(object.id))setNotice('这次点选没有发出，请稍后再点。');
 }
 function pointRegion(event:MouseEvent<HTMLDivElement>){
  if(!connected||gptLive||tool!=='pointer'||event.button!==0)return;
  const coords=coordinates(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect());
  if(!coords)return;
  setPointed(null);setPointedText(null);setPointedRegion(coords);
  void preparePicture('region',[],coords);
 }
 function pointText(id:string,event:MouseEvent<HTMLButtonElement>){
  event.stopPropagation();
  if(!connected||tool!=='pointer'||!paper.current)return;
  if(gptLive){
   setPointed(null);setPointedText(id);setPointedRegion(null);setNotice('');
   void controller.selectText(id).then(accepted=>{
    if(!accepted&&current.current.snapshot?.id===snapshot?.id&&current.current.snapshot?.revision===pageRevision)setNotice('这次文字点选没有送达，请再点一次。');
   });
   return;
  }
  const word=event.currentTarget.getBoundingClientRect();
  const x=event.detail>0?event.clientX:word.left+word.width/2;
  const y=event.detail>0?event.clientY:word.top+word.height/2;
  const coords=coordinates(x,y,paper.current.getBoundingClientRect());
  if(!coords)return;
  setPointed(null);setPointedText(id);setPointedRegion(null);
  void preparePicture('region',[],coords,id);
 }
 function beginStroke(event:PointerEvent<SVGSVGElement>){
  if(!connected||tool!=='pen'||gesture.current||event.button!==0)return;
  const coords=coordinates(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect());
  if(!coords)return;
  gesture.current={id:++nextStroke.current,pointerId:event.pointerId,points:[coords]};setDraft(gesture.current);
  event.currentTarget.setPointerCapture?.(event.pointerId);
 }
 function moveStroke(event:PointerEvent<SVGSVGElement>){
  const mark=gesture.current;
  if(!mark||mark.pointerId!==event.pointerId||mark.points.length>=600)return;
  const coords=coordinates(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect());
  if(!coords)return;
  gesture.current={...mark,points:[...mark.points,coords]};setDraft(gesture.current);
 }
 function endStroke(event:PointerEvent<SVGSVGElement>,cancel=false){
  const mark=gesture.current;
  if(!mark||mark.pointerId!==event.pointerId)return;
  gesture.current=null;setDraft(null);
  if(cancel||!connected||tool!=='pen')return;
  const last=coordinates(event.clientX,event.clientY,event.currentTarget.getBoundingClientRect());
  const tail=mark.points[mark.points.length-1];
  const points=last&&mark.points.length<600&&(last.x!==tail.x||last.y!==tail.y)?[...mark.points,last]:mark.points;
  if(points.length<2)return;
  const next=[...currentStrokes.current.slice(-79),{id:mark.id,points}];
  currentStrokes.current=next;setStrokes(next);setPointedText(null);setPointedRegion(null);
  void preparePicture('board',next);
 }
 function undo(){
  if(!currentStrokes.current.length||!snapshot)return;
  const next=currentStrokes.current.slice(0,-1);currentStrokes.current=next;
  setStrokes(next);
  if(next.length){setPointedRegion(null);void preparePicture('board',next);return;}
  if(visual.current?.kind==='board'){
   const cleared=controller.clearVisual(labVisualContext(snapshot),visual.current.id);
   visual.current=null;setPicture(null);
   setNotice(cleared?'笔迹已清空，不会随下一句发送。':'笔迹已清空，未收到取消发送确认。');
  }
 }
 async function preparePicture(kind:LabVisualPrepare['kind'],marks:Stroke[],point?:Point,textId?:string){
  if(!snapshot||!connected||gptLive||!image.current)return;
  const contextKey=labVisualContext(snapshot);
  if(!contextKey)return;
  setPicture(null);
  const previous=visual.current,id=globalThis.crypto.randomUUID();
  const request:LabVisualPrepare={id,contextKey,kind,...(point?{point}:{}),...(textId?{textId}:{})};
  visual.current=request;
  if(!controller.prepareVisual(request)){
   if(previous)controller.clearVisual(previous.contextKey,previous.id);
   visual.current=null;if(textId)setPointedText(null);
   setNotice('没能准备这张图，请重新点一下或画一笔。');return;
  }
  setNotice(kind==='region'?'正在准备点击处的教材局部…':'正在准备带笔迹的教材图…');
  const canvas=document.createElement('canvas');
  const isCurrent=()=>{
   const active=current.current;
   return visual.current===request&&active.state==='connected'&&active.snapshot&&labVisualContext(active.snapshot)===contextKey;
  };
  try{
   const frame=point?await captureRegion(image.current,point,canvas):await capture(image.current,marks,canvas);
   if(!isCurrent())return;
   const bytes=labBase64Bytes(frame);
   if(bytes===undefined)throw Error('Invalid classroom JPEG');
   current.current.observe({layer:'browser',kind:'image',label:kind==='region'?'已生成点击处的局部教材 JPEG':'已生成最新带笔迹的教材 JPEG',data:{visualId:id,mime:'image/jpeg',bytes,width:canvas.width,height:canvas.height,strokes:marks.length,source:kind==='region'?'教材局部＋点击标记':'教材＋本地笔迹'}});
   if(!current.current.finishVisual({id,contextKey,image:frame}))throw Error('Image was not delivered');
   setPicture({id,src:`data:image/jpeg;base64,${frame}`,bytes,width:canvas.width,height:canvas.height,kind});
   setNotice(textId?'已点到这个词，可以请老师高亮或划线。':kind==='region'?'局部图已准备好，可以问「这里是什么意思？」。':'最新笔迹已准备好，可以直接问老师。');
  }catch{
   if(isCurrent()){current.current.clearVisual(contextKey,id);visual.current=null;setNotice('没能准备这张图，请重新点一下或画一笔。');}
  }
 }

 return <main className="tl-root">
  <header className="tl-header">
   <div className="tl-brand"><span className="tl-brand-icon"><AudioLines size={24}/></span><div><p>TEEKO <span>/</span> INTERACTION LAB</p><h1>课堂互动实验台</h1></div></div>
   <div className="tl-connection"><span className="tl-status" data-state={state} role="status"><span className="tl-dot"/>{providerName} · {states[state]}</span>
    <button type="button" className="tl-small tl-disconnect" onClick={()=>void toggle()} disabled={state==='closing'}>
     {connected||state==='connecting'||state==='closing'?<Square size={16}/>:<Mic size={17}/>}
     {connected?'断开连接':state==='connecting'?'取消连接':state==='closing'?'正在断开':'连接并开麦'}
    </button></div>
  </header>
  <p className="tl-intro">在左侧跟老师说话、点图、画线；在右侧核对每一步实际发生了什么。<span>本机实验 · 不计入课程进度</span></p>
  <div className="tl-workbench">
   <section className="tl-panel tl-interact" aria-labelledby="lab-interact-title">
    <header className="tl-panel-head">
     <div className="tl-section-title"><span className="tl-index">01</span><div><h2 id="lab-interact-title">和老师试一次</h2><p>{gptLive?'开口请老师高亮、划线或画圈。':'点教材的任意位置，或先画一笔再问老师。'}</p></div></div>
     <div className="tl-audio-readings" aria-label="浏览器测量的声音强度">
      {audioPaused&&(connected||state==='connecting')&&<button type="button" className="tl-small" onClick={controller.resumeOutput}>恢复声音</button>}
      <span data-audible={childLevel>.08}><Mic size={15}/>你</span><span data-audible={teacherLevel>.08}><AudioLines size={15}/>老师</span>
     </div>
    </header>
    {!connected&&state!=='connecting'&&state!=='closing'&&<div className="tl-guide">
     <button type="button" className="tl-primary" onClick={()=>void toggle('gpt-live')}><Mic size={16}/>开始 GPT Live 标注测试</button>
     <button type="button" className="tl-small" onClick={()=>void toggle('guided')} title="通义实时带读"><BookOpen size={16}/>开始实时带读</button>
    </div>}
    {guided&&connected&&snapshot&&<div className="tl-guide" role="group" aria-label="带读翻页">
     <button type="button" className="tl-small" disabled={navigationPending||snapshot.stepIndex===0} onClick={()=>void navigate(snapshot.stepIndex-1)}>上一页</button>
     <span aria-live="polite">第 {snapshot.stepIndex+1} / {snapshot.course.steps.length} 页</span>
     <button type="button" className="tl-small" disabled={navigationPending||snapshot.stepIndex+1>=snapshot.course.steps.length} onClick={()=>void navigate(snapshot.stepIndex+1)}>下一页</button>
    </div>}
    <div className="tl-canvas-zone">
     <div className="tl-paper" ref={paper} style={{'--frame-ratio':`${width} / ${height}`} as CSSProperties} onClick={pointRegion}>
      {/* The HTML page and capture rendition share the proportions of the original SVG. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={image} src={captureSource} alt={htmlPage?'':'会飞又会游的机器人教材插图'} hidden={htmlPage} draggable={false}/>
      {htmlPage&&<Textbook pageId={pageId??'robot-predict'} marks={textMarks} guideTargets={guideTargets} selected={pointedText} pointable={connected&&tool==='pointer'} onPoint={pointText}/>}
      <div className="tl-hotspots" aria-label="教材上的可点击对象">
       {objects.map(object=>{
        const {box}=object,area=box.w*box.h;
        return <button key={object.id} type="button" aria-label={`点选${object.chinese}`} aria-pressed={pointed===object.id} disabled={!connected||tool!=='pointer'}
         style={{left:`${box.x*100}%`,top:`${box.y*100}%`,width:`${box.w*100}%`,height:`${box.h*100}%`,zIndex:1+objects.filter(other=>other.box.w*other.box.h>area).length}}
         onClick={event=>point(object,event)}><span>{object.chinese}</span></button>;
       })}
      </div>
      <svg role="img" aria-label="老师圈选与本地笔迹" className="tl-overlay" data-pen={tool==='pen'&&connected} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
       onPointerDown={beginStroke} onPointerMove={moveStroke} onPointerUp={event=>endStroke(event)} onPointerCancel={event=>endStroke(event,true)}>
       {pointedRegion&&<g data-region-pointer transform={`translate(${pointedRegion.x*width} ${pointedRegion.y*height})`}>
        <path d="M-22 0h14m16 0h14M0-22v14m0 16v14" stroke="#fffdf6" strokeWidth="5" vectorEffect="non-scaling-stroke"/>
        <path d="M-22 0h14m16 0h14M0-22v14m0 16v14" stroke="#c24a21" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
       </g>}
       {objects.filter(o=>teacherObjects.includes(o.id)).map(({id,chinese,box})=>{
        const ring=guided&&htmlPage&&id==='body'?robotBodyRing:{cx:(box.x+box.w/2)*width,cy:(box.y+box.h/2)*height,rx:box.w*width*.56,ry:box.h*height*.56};
        return <ellipse key={id} role="img" aria-label={'老师圈出的'+chinese} data-object-id={id} data-guide-highlight={guideTargets.includes(id)||undefined} {...ring} fill="none" stroke="#15795f" strokeWidth="3" vectorEffect="non-scaling-stroke"/>;
       })}
       {currentMarks.filter(mark=>!textMarks.has(mark.targetId)).map(mark=><TeacherMark key={mark.actionId} mark={mark} width={width} height={height}/>)}
       {[...strokes,...(draft?[draft]:[])].map(stroke=><g key={stroke.id} fill="none" strokeLinecap="round" strokeLinejoin="round">
        <polyline points={pointString(stroke.points,width,height)} stroke="#fffdf6" strokeWidth="7"/><polyline points={pointString(stroke.points,width,height)} stroke="#bd5936" strokeWidth="4"/>
       </g>)}
      </svg>
     </div>
    </div>
    {!gptLive&&<div className="tl-tool-zone">
     <div className="tl-tools" role="group" aria-label="教材互动工具">
      <button type="button" className="tl-small" aria-pressed={tool==='pointer'} disabled={!connected} onClick={()=>setTool('pointer')}><MousePointer2 size={17}/>指针</button>
      <button type="button" className="tl-small" aria-pressed={tool==='pen'} disabled={!connected} onClick={()=>setTool('pen')}><Pencil size={17}/>画笔</button>
      <button type="button" className="tl-small" disabled={!connected||!strokes.length} onClick={undo}><Undo2 size={17}/>撤销</button>
     </div>
     <span className="tl-visual-hint" title="文字输入不附带教材画面">画完直接开口问，最新笔迹随语音发送</span>
    </div>}
    <p className="tl-source-note">{gptLive?'可以直接说出目标，或点一个词再说「给这个词划线」。':guided&&pageId==='robot-predict'?'老师邀请你找线索时，点图里的一个部位。听到不懂的词，可以直接开口问。':htmlPage?'点一个英文词，再说「高亮这个词」或「给这个词划线」。图片随语音发送，文字指令也可以使用刚点的词。':'点图或画一笔再开口，教材图会随下一句语音发送。'}
     {gptLive&&snapshot?.course.reading&&<> <a href={snapshot.course.reading.sourceUrl} target="_blank" rel="noreferrer">阅读 DOGOnews 原文</a></>}
    </p>
    {picture&&<details className="tl-picture"><summary>{picture.kind==='region'?'准备的教材局部':'准备的笔迹图'} · {picture.width} × {picture.height} · {(picture.bytes/1024).toFixed(1)} KB</summary>
     {/* eslint-disable-next-line @next/next/no-img-element */}
     <img src={picture.src} alt={picture.kind==='region'?'教材局部与点击位置预览':'最新教材和笔迹 JPEG 预览'}/>
    </details>}
    <div className="tl-chat">
     <h3>对话</h3>
     {conversation.length?<ol aria-label="最近对话">{conversation.map(entry=><li key={entry.id} data-role={entry.transcript.role}><span>{entry.transcript.role==='child'?'你':'老师'}</span><p>{entry.transcript.text}</p></li>)}</ol>:<p className="tl-chat-empty">{guided&&connected?'等待老师开场，你也可以直接追问。':'连接后说一句话，或输入文字试试。'}</p>}
     <form onSubmit={event=>{
      event.preventDefault();const message=text.trim();
      if(!message||!connected)return;
      if(controller.sendText(message)){setText('');setNotice('');}else setNotice('文字没有发出，请重试。');
     }}>
      <input aria-label="输入给老师的话" placeholder="也可以输入文字" ref={input} maxLength={500} value={text} onChange={event=>setText(event.currentTarget.value)} disabled={!connected}/>
      <button type="submit" className="tl-primary" disabled={!connected||!text.trim()}><Send size={16}/>发送</button>
     </form>
     <div className="tl-examples">{examples.map(example=><button type="button" key={example} disabled={!connected} onClick={()=>{setText(example);input.current?.focus();}}>{example}</button>)}</div>
    </div>
    {(error||visualStatus||notice)&&<p className="tl-notice" data-error={!!error} role={error?'alert':'status'}>{error??visualStatus??notice}</p>}
   </section>
   <Trace events={events} guided={guided} objects={snapshot?.course.pages.flatMap(item=>item.objects)??noObjects} providerName={providerName}/>
  </div>
 </main>;
}

export default function InteractionLab(){return <InteractionLabView controller={useInteractionLab()}/>;}
