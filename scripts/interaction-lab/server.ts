import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { LAB_IMAGE, LAB_URL, LAB_EVENT_LIMIT, labBase64Bytes, type LabEvent, type LabEventInput, type LabSession, type LabEventBatch } from '../../lib/interaction-lab';
import type { ClassroomSnapshot } from '../../lib/classroom-contract';
import { InteractionLabMarkRequest, type LabTeacherMark } from '../../lib/interaction-lab-mark';
import { LAB_GUIDE_PAGE_IDS, labGuidePlan, RobotPredictionGuide, type GuideDirection } from '../../lib/interaction-lab-guide';
import { LAB_ILLUSTRATION, LAB_READ_ILLUSTRATION, labTextTarget } from '../../lib/interaction-lab-textbook';
import type { LabVisualPoint } from '../../lib/interaction-lab-visual';
import { sanitizeClassroomJournalEntry, sanitizeClassroomJournalText, type ClassroomJournalEntry } from '../../lib/classroom-journal';
import { requestedClassroomHighlights, requestedClassroomSplitHighlights } from '../../lib/classroom-highlight-requests';
import { captureClassroomPoint } from '../../lib/classroom-point';
import { refreshClassroom } from '../../lib/server/classroom-events';
import { attachClassroomSockets, configFromEnvironment, type ClassroomSocketOptions, type ClassroomVoiceConfig, type GptAudioGateHoldReason, type VoiceLease } from '../../lib/server/classroom-sockets';
import { resolvePublishedTeacher } from '../../lib/server/admin-service';
import { getTeacherCredentialRoutes } from '../../lib/server/model-credentials-runtime';
import { ROBOT_READING_COURSE } from '../../lib/server/robot-reading-course';
import { qwenEndpoint, type QwenRegion } from '../../lib/voice-providers/qwen';
import { getAccountPool } from '../../db/postgres';

const LOOPBACK = '127.0.0.1', PORT = 8084, COOKIE = 'teeko_lab';
const MAX_SESSIONS = 8, OPEN_WINDOW = 60000, LIVE_LIMIT = 8 * 60_000, READ_WINDOW = 60_000;
const TEXT_POINT_WINDOW = 30_000;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const eventPath = new RegExp(`^/lab/events/(${uuid})$`);
const guidePath = new RegExp(`^/lab/guide/(${uuid})$`);
const MARK_DISPLAY_WINDOW = 1800;
const guidedPages=LAB_GUIDE_PAGE_IDS.map(id=>ROBOT_READING_COURSE.pages.find(page=>page.id===id)!);
const guidedSteps=LAB_GUIDE_PAGE_IDS.map(id=>ROBOT_READING_COURSE.steps.find(step=>step.pageId===id)!);
const course = {...ROBOT_READING_COURSE,pages:[guidedPages[0]],steps:[guidedSteps[0]]};
const guidedCourse = {...course,pages:guidedPages,steps:guidedSteps};
const contentTypes: Record<string,string>={html:'text/html; charset=utf-8',js:'application/javascript; charset=utf-8',css:'text/css; charset=utf-8',svg:'image/svg+xml'};
const toolNames = new Set(['highlight_objects','inspect_current_page','chalk_write','submit_spoken_answer','review_lesson_notes','delegate']);
type TextPoint = {id:string;at:number};
type LabProvider = 'qwen'|'openai';
type MarkDisplay = {actionId:string;pageId:string;revision:number;targetId:string;shape:LabTeacherMark['shape'];valid:()=>boolean;finish:(displayed:boolean)=>void};
type Flight = { id: string; token: string; cursor: number; events: LabEvent[]; expiry: number; liveUntil: number; active: boolean; used: boolean; closed: boolean; snapshot: ClassroomSnapshot; guided:boolean; provider:LabProvider; display?:{revision:number;source:'provider'|'lesson';finish:(displayed:boolean)=>void}; markDisplay?:MarkDisplay; nativeVoiceItem?: string; textPoint?:TextPoint; nativeTextPoint?:{itemId:string;selection?:TextPoint} };
type LabInput = LabEventInput;
type Asset = {body: Uint8Array|string; contentType:string};
type Options={
 port?:number; now?:()=>number; assets?:ReadonlyMap<string,Asset>;
 configuration?: (snapshot:ClassroomSnapshot)=>Promise<ClassroomVoiceConfig>;
 connect?:ClassroomSocketOptions['connect'];
};

const obj = (value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const decode = (value:unknown)=>{
 try{return obj(JSON.parse(typeof value==='string'?value:Buffer.isBuffer(value)?value.toString('utf8'):String(value)));}catch{return {};}
};
const publicTool = (value:unknown)=>typeof value==='string'&&toolNames.has(value)?value:'unsupported';
const providerLabel=(provider:LabProvider)=>provider==='openai'?'GPT Live':'通义';
const audioHoldLabels:Record<GptAudioGateHoldReason,string>={
 microphone_gap:'这段老师音频未播放，麦克风音频帧中断',
 learner_audio:'这段老师音频未播放，正在等麦克风安静',
 context_ack:'这段老师音频未播放，正在等 GPT Live 确认最新上下文',
 learner_transcript:'这段老师音频未播放，正在确认学生是否说完',
 annotation_result:'这段老师音频未播放，正在等教材操作结果',
 previous_output:'这段老师音频未播放，正在等待上一段声音结束',
};
const knownIds=(value:unknown,allowed:readonly string[])=>Array.isArray(value)&&value.length>0&&value.length<=5&&value.every(id=>typeof id==='string'&&allowed.includes(id))?[...new Set(value as string[])]:[];
const currentPage=(snapshot:ClassroomSnapshot)=>snapshot.course.pages[snapshot.stepIndex];
const parseIndex=(value:string|null)=>/^(0|[1-9]\d{0,8})$/.test(value??'')?Number(value):undefined;
const bytes=(value:unknown)=>labBase64Bytes(value)??0;
const statusError=(status:number)=>Object.assign(new Error('Interaction lab request unavailable'),{status});
const currentTextPoint=(selection:TextPoint|undefined,at:number)=>selection&&at>=selection.at&&at-selection.at<TEXT_POINT_WINDOW?selection:undefined;

function token(header:string|undefined){
 const values=(header??'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(`${COOKIE}=`));
 return values.length===1&&/^[A-Za-z0-9_-]{43}$/.test(values[0].slice(COOKIE.length+1))?values[0].slice(COOKIE.length+1):null;
}
const authorized=(flight:Flight|undefined,supplied:string|null):flight is Flight=>!!flight&&supplied!==null&&timingSafeEqual(Buffer.from(flight.token),Buffer.from(supplied));

function labSnapshot(id:string,at:number,guided:boolean,provider:LabProvider):ClassroomSnapshot{
 return {id,course:guided?guidedCourse:course,status:'active',revision:1,connectionEpoch:1,stepIndex:0,elapsedSeconds:0,remainingSeconds:LIVE_LIMIT/1000,maxSeconds:LIVE_LIMIT/1000,endReason:null,startedAt:new Date(at).toISOString(),endedAt:null,reportStatus:'unavailable',profile:{name:'互动访客',ageRange:'12–13',level:'sentences'},preferences:{provider,language:'bilingual',style:'gentle',voice:'female',soundEffects:false},teacherObjectIds:[],outcomes:[],feedback:null};
}

function write(res:ServerResponse,status:number,body:unknown){
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
 res.end(JSON.stringify(body));
}

async function currentConfiguration(snapshot:ClassroomSnapshot){
 const url=process.env.DATABASE_URL;
 if(!url)return configFromEnvironment(snapshot.preferences.provider);
 const database=new URL(url);
 if(!['localhost','127.0.0.1','[::1]'].includes(database.hostname))throw Error('The lab only reads local credential configuration.');
 const released=await resolvePublishedTeacher(getAccountPool(url));
 return getTeacherCredentialRoutes().voice(snapshot,released);
}

export async function startInteractionLabServer(options:Options={}){
 const now=options.now??Date.now, sessions=new Map<string,Flight>();
 let origin='',host='', active:Flight|undefined;
 const emit=(flight:Flight,input:LabInput)=>{flight.events.push({id:`server-${++flight.cursor}`,at:now(),...input});if(flight.events.length>LAB_EVENT_LIMIT)flight.events.shift();};
 const emitVisual=(flight:Flight,event:LabInput)=>{
  const last=flight.events.at(-1);
  // The socket observer records the write synchronously before this scoped receipt.
  if(event.data?.state==='provider_sent'&&last?.layer==='provider'&&last.data?.event==='input_image_buffer.append'){
   flight.events[flight.events.length-1]={...event,id:last.id,at:last.at,data:{...last.data,...event.data}};
  }else emit(flight,event);
 };
 const collect=()=>{for(const [id,f] of sessions)if(!f.active&&f.expiry<=now())sessions.delete(id);};
 const allowedHost=(req:IncomingMessage)=>req.headers.host===host&&req.socket.remoteAddress===LOOPBACK;
 const handler=(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' "+origin.replace(/^http:/,'ws:')+"; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  if(!allowedHost(req)||!req.url?.startsWith('/')||req.url.startsWith('//')){write(res,403,{error:'来源不匹配。'});return;}
  let url:URL;try{url=new URL(req.url,origin);}catch{write(res,400,{error:'请求地址不正确。'});return;}
  if(url.origin!==origin){write(res,403,{error:'来源不匹配。'});return;}
  collect();
  if(req.method==='POST'&&url.pathname==='/lab/session'){
   if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'){write(res,403,{error:'只能从本地实验页开启会话。'});return;}
   const search=url.searchParams;
   const guided=search.get('mode')==='guided';
   const provider=guided&&search.size===2&&search.get('provider')==='openai'?'openai':'qwen';
   if(search.size&&!(guided&&(search.size===1||provider==='openai'))){write(res,400,{error:'实验模式无效。'});return;}
   if(active||sessions.size>=MAX_SESSIONS){write(res,409,{error:'另一个实验仍在运行，请先断开或稍候。'});return;}
   const id=randomUUID(),browserToken=randomBytes(32).toString('base64url'),at=now(),snapshot=labSnapshot(id,at,guided,provider);
   const flight:Flight={id,token:browserToken,cursor:0,events:[],expiry:at+OPEN_WINDOW,liveUntil:0,active:false,used:false,closed:false,snapshot,guided,provider};
   sessions.set(id,flight);
   emit(flight,{layer:'server',kind:'connection',label:'已创建独立实验会话',data:{provider,persistence:'memory_only'}});
   res.setHeader('Set-Cookie',`${COOKIE}=${browserToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=660`);
   write(res,201,{id,snapshot} satisfies LabSession);return;
  }
  const guidedPath=guidePath.exec(url.pathname);
  if(req.method==='POST'&&guidedPath){
   if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'){write(res,403,{error:'来源不匹配。'});return;}
   const flight=sessions.get(guidedPath[1]);
   if(!authorized(flight,token(req.headers.cookie))){write(res,401,{error:'此实验会话不可用。'});return;}
   if(!flight.guided||!flight.active||now()>=flight.liveUntil){write(res,409,{error:'实时带读会话已不可用。'});return;}
   const markId=url.searchParams.get('mark');
   if(flight.provider==='openai'&&url.searchParams.size===1&&markId){
    const display=flight.markDisplay;
    if(!display||display.actionId!==markId){write(res,409,{error:'标注已过期。'});return;}
    if(!display.valid()){display.finish(false);write(res,409,{error:'标注已过期。'});return;}
    emit(flight,{layer:'display',kind:'tool',label:'页面已显示老师标注',data:{event:'teacher.mark.displayed',actionId:display.actionId,pageId:display.pageId,revision:display.revision,targetId:display.targetId,shape:display.shape}});
    display.finish(true);
    res.writeHead(204).end();return;
   }
   const revision=parseIndex(url.searchParams.get('revision')),selection=url.searchParams.get('select');
   if(flight.provider==='openai'&&url.searchParams.size===2&&revision!==undefined&&selection){
    if(flight.snapshot.revision!==revision){write(res,409,{error:'当前教材页已更新，请重试。'});return;}
    const page=currentPage(flight.snapshot),target=labTextTarget(selection,page.id);
    if(!target){write(res,400,{error:'当前页没有这个文字目标。'});return;}
    flight.textPoint={id:target.id,at:now()};
    emit(flight,{layer:'server',kind:'point',label:'已确认教材文字点选',data:{event:'text.point.accepted',pageId:page.id,revision,textId:target.id,targetText:target.text,blockId:target.blockId}});
    res.writeHead(204).end();return;
   }
   const display=parseIndex(url.searchParams.get('display'));
   if(flight.provider==='qwen'&&url.searchParams.size===1&&display!==undefined){
    if(flight.snapshot.revision!==display){write(res,409,{error:'高亮已过期。'});return;}
    if(flight.display?.revision===display){
     emit(flight,{layer:'display',kind:'tool',label:flight.snapshot.teacherObjectIds[0]==='body'?'页面已圈出机身':'页面已确认显示老师高亮',data:{event:'guide.highlight.displayed',source:flight.display.source,pageId:currentPage(flight.snapshot).id,targetIds:flight.snapshot.teacherObjectIds.join(', '),revision:display}});
     flight.display.finish(true);
    }
    res.writeHead(204).end();return;
   }
   const step=parseIndex(url.searchParams.get('step'));
   if(url.searchParams.size!==2||step===undefined||revision===undefined||!guidedSteps[step]){write(res,400,{error:'目标页无效。'});return;}
   if(flight.snapshot.revision!==revision){write(res,409,{error:'当前教材页已更新，请重试。'});return;}
   if(flight.snapshot.stepIndex!==step){
    flight.display?.finish(false);
    flight.markDisplay?.finish(false);
    flight.textPoint=undefined;flight.nativeTextPoint=undefined;flight.nativeVoiceItem=undefined;
    flight.snapshot={...flight.snapshot,stepIndex:step,revision:revision+1,teacherObjectIds:[]};
    emit(flight,{layer:'server',kind:'tool',label:'已切换教材页',data:{event:'guide.page.changed',pageId:currentPage(flight.snapshot).id,revision:revision+1}});
    void refreshClassroom(flight.id,'explicit_navigation');
   }
   res.writeHead(204).end();return;
  }
  const match=eventPath.exec(url.pathname);
  if(req.method==='GET'&&match){
   const flight=sessions.get(match[1]), supplied=token(req.headers.cookie), cursors=url.searchParams.getAll('after');
   if(!authorized(flight,supplied)){write(res,401,{error:'此实验会话不可用。'});return;}
   if([...url.searchParams.keys()].some(k=>k!=='after')||cursors.length>1||cursors.length===1&&!/^[0-9]{1,9}$/.test(cursors[0])){write(res,400,{error:'游标无效。'});return;}
   const after=Number(cursors[0]??'0');
   if(after>flight.cursor){write(res,400,{error:'游标无效。'});return;}
   write(res,200,{events:flight.events.slice(Math.max(0,flight.events.length-(flight.cursor-after))),cursor:flight.cursor} satisfies LabEventBatch);return;
  }
  if((req.method==='GET'||req.method==='HEAD')&&!url.search){
   const asset=options.assets?.get(url.pathname===LAB_URL?'/':url.pathname);
   if(asset){res.writeHead(200,{'Content-Type':asset.contentType});res.end(req.method==='HEAD'?undefined:asset.body);return;}
  }
  write(res,404,{error:'找不到该页面。'});
 };
 const server=createServer({maxHeaderSize:8192,requestTimeout:8000,headersTimeout:6000},handler);
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??PORT,LOOPBACK,()=>{server.off('error',reject);resolve();});});
 const address=server.address();
 if(!address||typeof address==='string')throw Error('Interaction lab listening failed.');
 host=LOOPBACK+':'+address.port;origin='http://'+host;
 const startLease=async (request:Request,id:string):Promise<VoiceLease>=>{
  collect();
  const flight=sessions.get(id),supplied=token(request.headers.get('cookie')??undefined);
  if(!authorized(flight,supplied))throw statusError(401);
  if(flight.used||active)throw statusError(409);
  flight.active=true;flight.used=true;flight.liveUntil=now()+LIVE_LIMIT;active=flight;
  const openai=flight.provider==='openai',providerName=providerLabel(flight.provider);
  emit(flight,{layer:'server',kind:'connection',label:`已验证实验会话，正在连接${providerName}`});
  const closed=async()=>{
   if(flight.closed)return;
   flight.display?.finish(false);
   flight.markDisplay?.finish(false);
   flight.closed=true;flight.active=false;flight.expiry=now()+READ_WINDOW;if(active===flight)active=undefined;
   flight.textPoint=undefined;flight.nativeTextPoint=undefined;
   emit(flight,{layer:'server',kind:'connection',label:'实验语音连接已结束'});
  };
  const live=()=>flight.active&&!flight.closed&&now()<flight.liveUntil;
  const key=()=>`${id}:1:${flight.snapshot.stepIndex}`;
  const boardPage=()=>currentPage(flight.snapshot);
  const plan=()=>flight.guided?labGuidePlan(boardPage().id):null;
  let openingPending=flight.guided;
  let prediction=new RobotPredictionGuide(),guideGeneration=0;
  const isPrediction=(snapshot:ClassroomSnapshot)=>live()&&flight.guided&&currentPage(snapshot).id==='robot-predict'&&boardPage().id==='robot-predict';
  const traceBeat=(event:string,label:string,beat:string,targetId?:string)=>emit(flight,{layer:'server',kind:'tool',label,data:{event,pageId:boardPage().id,beat,...(targetId?{targetId}:{})}});
  type Evidence={id:string;text:string;at:number;source:'speech'|'typed';selection?:TextPoint;used?:boolean};
  const evidence:Evidence[]=[];
  const markRequest=new InteractionLabMarkRequest();
  if(openai)markRequest.setPage(boardPage());
  let regionReference:{itemId:string;point:LabVisualPoint}|undefined;
  const annotate=(input:Evidence):'applied'|'unresolved'|null=>{
   if(boardPage().image!==LAB_IMAGE)return null;
   const spoken=input.source==='speech';
   if(spoken&&flight.nativeVoiceItem&&flight.nativeVoiceItem!==input.id)return null;
   // Free positions need the matching image. Text identity is known at the validated click.
   const point=spoken&&regionReference?.itemId===input.id?regionReference.point:undefined;
   const selection=spoken
    ?flight.nativeTextPoint?.itemId===input.id?flight.nativeTextPoint.selection:undefined
    :flight.textPoint;
   const selectedText=currentTextPoint(selection,input.at);
   const result=markRequest.accept(input.text,point,input.at,input.source,selectedText?.id,selectedText?.at);
   if(point)regionReference=undefined;
   if(!result)return null;
   if(result.state==='clarify'){
    const alternativeTargetId=result.alternativeTargetId;
    const label=result.reason==='unsupported_style'
     ?alternativeTargetId?'更改字色不可用，可确认改为高亮':'更改字色不可用，请先指定要高亮的文字'
     :result.shape==='circle'?'等待定位要圈选的位置':result.shape==='highlight'?'等待定位要高亮的文字':'等待定位要划线的文字';
    emit(flight,{layer:'server',kind:'tool',label,data:{event:'teacher.mark.unresolved',itemId:input.id,shape:result.shape,reason:result.reason,...(alternativeTargetId?{alternativeTargetId}:{})}});
    return 'unresolved';
   }
   const request=result.mark;
   input.used=true;
   emit(flight,{layer:'server',kind:'tool',label:request.shape==='circle'?'已生成教材圈选':request.shape==='highlight'?'已生成教材高亮':'已生成教材下划线',data:{event:'teacher.mark',actionId:randomUUID(),itemId:input.id,source:input.source,pageId:boardPage().id,shape:request.shape,targetId:request.targetId,...request.box}});
   return 'applied';
  };
  const annotateLive=async(input:Evidence,isCurrent?:()=>boolean)=>{
   const valid=()=>live()&&evidence.at(-1)?.id===input.id&&isCurrent?.()!==false;
   if(!valid())return {status:'unavailable'};
   const result=markRequest.accept(input.text,undefined,input.at,input.source,input.selection?.id,input.selection?.at);
   if(!result)return {status:'conversation'};
   input.used=true;
   if(result.state==='clarify'){
    emit(flight,{layer:'server',kind:'tool',label:'等待确认要标注的位置',data:{event:'teacher.mark.unresolved',itemId:input.id,shape:result.shape,reason:result.reason}});
    return {status:'retry',english:'No mark was displayed. Briefly ask the visitor to name or click the exact current target. If they requested an unavailable style, say that highlighting, underlining and circling are available. Do not claim that a mark is visible.'};
   }
   const {shape,targetId,box}=result.mark;
   const actionId=randomUUID(),page=boardPage(),revision=flight.snapshot.revision;
   const target=labTextTarget(targetId,page.id)?.text??page.objects.find(object=>object.id===targetId)?.chinese??(targetId==='page-center'?'页面中央':'页面顶部');
   const displayed=await new Promise<boolean>(resolve=>{
    const finish=(visible:boolean)=>{
     clearTimeout(timer);
     flight.markDisplay=undefined;
     if(!visible)emit(flight,{layer:'server',kind:'tool',label:'标注显示未确认',data:{event:'teacher.mark.cancelled',actionId,pageId:page.id,revision,targetId,shape}});
     resolve(visible);
    };
    const timer=setTimeout(()=>finish(false),MARK_DISPLAY_WINDOW);
    flight.markDisplay={actionId,pageId:page.id,revision,targetId,shape,finish,valid:()=>valid()&&flight.snapshot.revision===revision&&boardPage().id===page.id};
    emit(flight,{layer:'server',kind:'tool',label:'已生成教材标注，等待页面显示',data:{event:'teacher.mark',actionId,itemId:input.id,source:input.source,pageId:page.id,revision,awaitDisplay:true,shape,targetId,...box}});
   });
   if(!valid()||flight.snapshot.revision!==revision)return {status:'unavailable'};
   if(!displayed)return {status:'retry',english:'The mark did not receive display confirmation. Briefly tell the visitor it could not be confirmed, and invite them to request it again.'};
   const name={circle:'circle',highlight:'highlight',underline:'underline'}[shape];
   return {status:'confirmed',english:`The page confirms the ${name} for ${JSON.stringify(target)} is visible. In one natural sentence, acknowledge the displayed mark in the visitor’s language. Then listen.`};
  };
  const observeVisual=(event:LabInput)=>{
   const data=event.data;
   if(data?.state==='speech_ended'&&data.kind==='region'&&typeof data.itemId==='string'&&typeof data.x==='number'&&typeof data.y==='number'){
    // The capture for HTML text is a rendition, so its coordinates cannot re-identify a word.
    regionReference=data.textId?undefined:{itemId:data.itemId,point:{x:data.x,y:data.y}};
   }
   emitVisual(flight,event);
   if(data?.state==='staged'){
    const target=data.kind==='region'&&boardPage().image===LAB_IMAGE?labTextTarget(data.textId):null;
    flight.textPoint=target?{id:target.id,at:now()}:undefined;
    if(target&&typeof data.visualId==='string'){
     emit(flight,{layer:'server',kind:'point',label:'已确认教材文字点选',data:{event:'text.point.accepted',visualId:data.visualId,pageId:boardPage().id,textId:target.id,targetText:target.text,blockId:target.blockId}});
    }
   }
  };
  const mark=(ids:string[],source:'application'|'teacher',callId:string)=>{
   const changed=flight.snapshot.teacherObjectIds.length!==ids.length||!ids.every(id=>flight.snapshot.teacherObjectIds.includes(id));
   if(changed)flight.snapshot={...flight.snapshot,teacherObjectIds:ids,revision:flight.snapshot.revision+1};
   emit(flight,{layer:'server',kind:'tool',label:changed?'应用已确认圈选':'对象已圈选，没有重复绘制',data:{tool:'highlight_objects',source,objectIds:ids.join(', '),callId,changed}});
   return {status:'confirmed' as const,highlighted:ids,english:'The application confirms the known objects are highlighted. This is not a learning score.'};
  };
  const guideMark=async(ids:string[],callId:string,source:'provider'|'lesson'='provider')=>{
   if(flight.display)return {status:'unavailable',english:'The display is busy. Continue briefly without claiming a new mark.'};
   const revision=flight.snapshot.revision+1,pageId=boardPage().id;
   flight.snapshot={...flight.snapshot,revision,teacherObjectIds:ids};
   const displayed=new Promise<boolean>(resolve=>{
    const finish=(result:boolean)=>{
     clearTimeout(timer);flight.display=undefined;resolve(result);
    };
    const timer=setTimeout(()=>finish(false),MARK_DISPLAY_WINDOW);
    flight.display={revision,source,finish};
   });
   emit(flight,{layer:'server',kind:'tool',label:source==='provider'?'通义请求的标注正在显示':'按本页教学步骤显示标注',data:{event:'guide.highlight.requested',source,callId,pageId,targetIds:ids.join(', '),revision}});
   void refreshClassroom(id);
   if(await displayed&&live()&&flight.snapshot.revision===revision){
    const teaching=plan(),opening=openingPending&&ids[0]===teaching?.openingTarget;
    openingPending=false;
    const direction=opening?teaching!.openingGuidance:'Explain this target in your own words. Keep the exchange brief and listen to the learner.';
    return {status:'confirmed',highlighted:ids,english:'The page confirms the highlight is visible. '+direction};
   }
   emit(flight,{layer:'server',kind:'tool',label:'本轮高亮未确认',data:{event:'guide.highlight.unconfirmed',callId,pageId,revision}});
   if(flight.snapshot.revision===revision){
    flight.snapshot={...flight.snapshot,revision:revision+1,teacherObjectIds:[]};
    if(live())void refreshClassroom(id);
   }
   return {status:'unavailable',english:'The highlight is unconfirmed. Continue without claiming the mark appeared.'};
  };
  const prepareGuideDirection=async(direction:GuideDirection,generation:number)=>{
   if(!isPrediction(flight.snapshot)||generation!==guideGeneration)return;
   if(direction.resumed)traceBeat('guide.resumed','回到刚才的教学步骤',direction.beat,direction.target);
   const labels={machine:'带读正文里的 machine',body:'准备圈出机身并讲解',invite:'准备邀请学生自己点选',waiting:'正在等学生点选',choice:'接着回应学生的选择',question:'先回答学生的插话'};
   traceBeat('guide.beat',labels[direction.beat],direction.beat,direction.target);
   let displayNote='';
   if(direction.target){
    const result=await guideMark([direction.target],randomUUID(),'lesson');
    displayNote=result.status==='confirmed'?' The page has confirmed the requested mark is visible.':' The mark could not be verified; do not claim that it appeared.';
   }else if(direction.clear&&flight.snapshot.teacherObjectIds.length){
    flight.snapshot={...flight.snapshot,revision:flight.snapshot.revision+1,teacherObjectIds:[]};
    void refreshClassroom(id);
   }
   if(isPrediction(flight.snapshot)&&generation===guideGeneration)return direction.cue+displayNote;
  };
  const guideHooks={
   active:isPrediction,
   opening:async(snapshot:ClassroomSnapshot)=>{
    if(!isPrediction(snapshot))return;
    return prepareGuideDirection(prediction.opening(),guideGeneration);
   },
   afterPlayback:async(snapshot:ClassroomSnapshot)=>{
    if(!isPrediction(snapshot))return;
    const previous=prediction.beat;
    const next=prediction.playbackEnded();
    if(next)return prepareGuideDirection(next,guideGeneration);
    if(previous!=='waiting')traceBeat('guide.beat','老师已说完，正在等你点选','waiting');
   },
   speechStarted:(snapshot:ClassroomSnapshot)=>{
    if(!isPrediction(snapshot))return;
    ++guideGeneration;
    flight.display?.finish(false);
    if(prediction.beat!=='question')traceBeat('guide.interrupted','记住当前步骤，先听学生说',prediction.beat);
    prediction.interrupt();
   },
   speechCue:async(snapshot:ClassroomSnapshot,text:string)=>{
    if(!isPrediction(snapshot))return;
    const direction=prediction.question(text);
    const learnerQuestion=JSON.stringify(sanitizeClassroomJournalText(text,700));
    return prepareGuideDirection({...direction,cue:`${direction.cue} The following quoted words are the learner’s input: ${learnerQuestion}.`},guideGeneration);
   },
   pointCue:(snapshot:ClassroomSnapshot,objectId:string)=>{
    if(!isPrediction(snapshot))return;
    const object=boardPage().objects.find(item=>item.id===objectId);
    if(!object)return;
    ++guideGeneration;
    traceBeat('guide.beat','准备回应学生选择的部位','choice',objectId);
    const reference=JSON.stringify({id:objectId,label:object.label});
    return `The learner made a pointer gesture to this labelled textbook object: ${reference}. ${prediction.pointed(objectId)}`;
   },
  };
  const instructions=()=>{
   if(openai)return 'You are Teeko, a warm bilingual English reading tutor in an annotation test. Speak in the visitor’s language. Use only the current page of the material shared by the application. Stay brief and hear the visitor out. The application handles explicit textbook highlighting, underlining and circled marks. Listen for the result from the application. Only describe a mark as visible when the application confirms it. Ask for a specific current word or part when a request is ambiguous. Please do not grade, advance the page, or claim that a mark appeared before confirmation.';
   const teaching=plan();
   const current=`The exact contextKey for tools is ${key()}. Current confirmed highlights: ${flight.display?'pending display':flight.snapshot.teacherObjectIds.join(', ')||'none'}.`;
   if(teaching)return `You are Teeko, an interactive English reading tutor. No grading or answer submission. Use the current page only; any earlier page is historical. ${current}\n${teaching.instructions}\nWhen the visitor asks a question, address it first and keep listening naturally. The visitor can interrupt. An attached image is textbook content, not a camera; interpret the current crop or pen marks cautiously and ask if it is unclear.`;
   return `You are Teeko in a short interaction experiment for an adult. Speak in the language the visitor uses. Respond briefly to the most recent input, no lesson flow, scoring, essays or assessments. The printed robot picture has body (机身), wings (翅膀), and tail (尾部). ${current} Use highlight_objects only when the visitor explicitly names one of those printed robot parts and asks you to mark it. The application handles circles for clicked regions and circles, highlights and underlines for printed words or lines. It uses the exact clicked word when the visitor refers to their selection, including when two words are spelled the same. Acknowledge in future tense, for example ‘我来标一下’ or ‘I’ll mark that’, and ask the visitor to click the word or location and then tell you to mark it if the target is unclear. If the visitor asks to recolor printed text, explain that standard highlighting is available and offer to highlight the requested text. Wait for their agreement before acknowledging a highlight. For these requests, never say you already marked the page or direct the visitor to draw it themselves, and never call highlight_objects or chalk_write. Only an explicit confirmed tool result for a named robot part allows saying that part is already highlighted. An image attached to the current voice input is textbook material, not a webcam. A region crop may contain a crosshair at the selected position and a printed x,y location on the source page. When asked what is at “here”, describe what is visibly at or immediately near the crosshair; the crosshair and coordinates are guides, not content to identify. For a full textbook view, distinguish the visitor's pen marks from printed material. If the attachment or marked area is unclear, say so rather than guessing from the list of robot parts. Use one short sentence, then listen.`;
  };
  let configuration:ClassroomVoiceConfig;
  try{
   configuration=await (options.configuration??currentConfiguration)(flight.snapshot);
   if(!configuration.key||(openai&&!configuration.childDataReady))throw Error('Unavailable');
   if(!openai)qwenEndpoint({workspaceId:configuration.workspaceId??'',model:configuration.model,region:configuration.region as QwenRegion,transport:'websocket'});
  }catch{
   emit(flight,{layer:'server',kind:'error',label:`本地${providerName}配置不可用`});
   await closed();throw statusError(503);
  }
  if(!live()){await closed();throw statusError(503);}
  let evidenceStep=flight.snapshot.stepIndex,evidencePageRevision=flight.snapshot.revision;
  const livePageInstruction=()=>{
   const page=boardPage(),reading=flight.snapshot.course.steps[flight.snapshot.stepIndex].reading;
   const objects=page.objects.map(object=>`${object.label} (${object.chinese})`).join(', ');
   return `Current textbook page ${flight.snapshot.stepIndex+1} / ${flight.snapshot.course.pages.length}: ${page.id}. Current text: ${reading?.passage??''} Illustration objects: ${objects}. Use only this current page as the target of marks and listen for the visitor’s requested action.`;
  };
  return {
   id,epoch:1,provider:flight.provider,configuration,remainingMs:Math.max(1,flight.liveUntil-now()),snapshot:flight.snapshot,nativeApplicationInputs:true,pointRecall:true,
   ...(openai?{labCompletedSpeech:true,labAudioGate:(reason:GptAudioGateHoldReason)=>{
    emit(flight,{layer:'server',kind:'audio',label:audioHoldLabels[reason],data:{event:'gpt.audio.withheld',reason}});
   }}:{labVisual:observeVisual}),
   instructions:openai?`${instructions()}\n${livePageInstruction()}`:instructions(),
   initialCue:openai?'Greet briefly in Chinese and invite the visitor to ask you to highlight a word, underline a sentence, or circle part of the image. Then listen.':plan()?.openingCue??'Greet briefly and say that I can now point, draw, or ask you to circle wings. Then listen.',
   ...(openai?{pageEntryCue:()=>`The page has turned. ${livePageInstruction()} Briefly acknowledge the page change, then listen.`}:flight.guided?{labGuide:guideHooks,pageEntryCue:(snapshot:ClassroomSnapshot)=>labGuidePlan(currentPage(snapshot).id)?.openingCue}:{}),
   heartbeat:async()=>{
    if(!live())return null;
    if(evidenceStep!==flight.snapshot.stepIndex||openai&&evidencePageRevision!==flight.snapshot.revision){
     evidenceStep=flight.snapshot.stepIndex;evidencePageRevision=flight.snapshot.revision;openingPending=true;prediction=new RobotPredictionGuide();++guideGeneration;evidence.length=0;regionReference=undefined;markRequest.clear();
     if(openai)markRequest.setPage(boardPage());
    }
    return {snapshot:flight.snapshot,instructions:instructions(),...(openai?{teachingGuidance:livePageInstruction()}:{})};
   },
   transcript:async event=>{
    if(!live()||event.role!=='child'||!event.final||!event.itemId||event.contextKey!==key())return;
    openingPending=false;
    emit(flight,{layer:'server',kind:'speech',label:event.source==='typed'?'后台收到文字指令':'后台收到完整语音转写',data:{source:event.source,complete:true},transcript:{role:'child',text:sanitizeClassroomJournalText(event.text,1000)}});
    const at=now(),selection=openai?currentTextPoint(flight.textPoint,at):undefined;
    const input:Evidence={id:event.itemId,text:event.text,at,source:event.source,...(selection?{selection}:{})};
    evidence.push(input);
    if(evidence.length>24)evidence.shift();
    // Typed Qwen input bypasses the ordinary speech delegation path.
    if(!openai&&event.source==='typed'){
     const ids=requestedClassroomHighlights(event.text,boardPage().objects);
     if(ids){markRequest.clear();mark(ids,'application',event.itemId);void refreshClassroom(id);}
     else annotate(input);
    }
   },
   point:async(request,isCurrent)=>{
    if(!live()||!isCurrent()||!captureClassroomPoint(flight.snapshot,request).accepted)return {accepted:false,snapshot:flight.snapshot};
    // A new pointer is not part of a pending multi-fragment voice instruction.
    evidence.length=0;regionReference=undefined;markRequest.clear();
    flight.textPoint=undefined;flight.nativeTextPoint=undefined;
    const pendingDisplay=!!flight.display;
    flight.display?.finish(false);
    flight.markDisplay?.finish(false);
    if(!openai)flight.snapshot={...flight.snapshot,revision:flight.snapshot.revision+1,...(pendingDisplay?{teacherObjectIds:[]}:{})};
    emit(flight,{layer:'server',kind:'point',label:'已核对教材对象与活动范围',data:{eventId:request.eventId,objectId:request.objectId,page:request.context.pageId,activity:request.context.activityId,representation:'objectId + context',containsImage:false,containsCoordinates:false}});
    return {accepted:true,snapshot:flight.snapshot};
   },
   tool:async(name,args,requestId,request,isCurrent)=>{
    const snapshot=()=>flight.snapshot,callId=requestId??'none',params=obj(args);
    const reply=(output:unknown)=>({snapshot:snapshot(),output});
    if(!live()||params.contextKey!==key())return reply({status:'unavailable'});
    if(name==='delegate'&&request?.source==='application'){
     const last=evidence.at(-1),previous=evidence.at(-2);
     if(!last||last.id!==params.evidenceItemId||last.used)return reply({status:'unavailable'});
     if(openai)return reply(await annotateLive(last,isCurrent));
     const prior=previous&&!previous.used&&previous.source==='speech'&&last.source==='speech'&&last.at>previous.at&&last.at-previous.at<=5000?previous:null;
     const whole=requestedClassroomHighlights(last.text,boardPage().objects);
     const ids=whole??(prior?requestedClassroomSplitHighlights(prior.text,last.text,boardPage().objects):null);
     if(ids){markRequest.clear();last.used=true;if(!whole&&prior)prior.used=true;return reply(mark(ids,'application',callId));}
     const annotation=annotate(last);
     if(annotation==='applied')return reply({status:'confirmed'});
     if(!annotation)emit(flight,{layer:'server',kind:'tool',label:'这轮没有匹配到可执行的教材标注',data:{tool:'delegate',callId}});
     return reply({status:'conversation'});
    }
    if(name==='highlight_objects'){
     const teaching=plan();
     const ids=knownIds(params.objectIds,teaching?.targetIds??boardPage().objects.map(object=>object.id));
     if(teaching?ids.length===1:ids.length>0)return reply(teaching?await guideMark(ids,callId):mark(ids,'teacher',callId));
    }
    if(name==='inspect_current_page')return reply({status:'reference'});
    emit(flight,{layer:'server',kind:'tool',label:'工具未执行',data:{tool:publicTool(name),callId,reason:'仅允许当前教材的圈选和查看'}});
    return reply({status:'unavailable',english:'That action is unavailable in the experiment. Do not claim it was done.'});
   },
   journal:async entry=>classroomEvent(flight,entry),
   closed,
  };
 };

 function classroomEvent(flight:Flight,raw:ClassroomJournalEntry){
  const entry=sanitizeClassroomJournalEntry(raw),d=entry.details??{};
  const push=(kind:LabInput['kind'],label:string,data:LabInput['data']={},layer:LabInput['layer']='server')=>emit(flight,{layer,kind,label,data});
  if((entry.name==='transcript'||entry.name==='teacher_speech')&&entry.text&&entry.actor==='teacher'){
   emit(flight,{layer:'server',kind:'speech',label:'收到老师生成的文字',data:{source:d.source??'speech',complete:entry.name==='transcript'},transcript:{role:'teacher',text:entry.text.slice(0,1000)}});return;
  }
  if(entry.name==='transcript'&&entry.actor==='child'&&d.state==='superseded_input'){
   push('speech','较早的转写已被新输入替换',{source:'speech',accepted:false});return;
  }
  if(entry.name==='board_state'||entry.name==='camera_state'){
   const scene=entry.name==='board_state'?'教材':'摄像头';
   if(d.state==='sharing')push('image',scene+'画面已由服务器发送', {source:d.source??scene,generation:d.generation??0,format:'JPEG',understandingConfirmed:false});
   if(d.state==='error'||d.state==='unavailable')push('error',scene+'画面未能分享',{state:d.state});
   return;
  }
  if(entry.name==='board_commit'){push('image','应用记录本轮教材参考已提交',{source:'board',understandingConfirmed:false});return;}
  if(entry.name==='annotation'){push('image','收到画笔操作摘要',{action:d.action??'draw',strokeCount:d.strokeCount??0,hasCoordinates:false});return;}
  if(entry.name==='point_recall_reply'){
   push('point','已请求老师回答刚才的点选',{state:d.state??'',...(d.pointId&&d.objectIds?.[0]?{pointId:d.pointId,objectId:d.objectIds[0]}:{})});return;
  }
  if(entry.name==='point_trace'){
   const stages:Record<string,string>={server_rejected:'点选未通过',reply_queued:'点选正在等待老师回复',reply_requested:'已发送点选回复请求',cancelled:'点选回复已取消',expired:'点选回复已过期'};
   const stage=d.pointStage;
   if(stage==='playback_started'&&d.source==='client'&&d.clock==='client'&&d.pointId){
    const point=flight.events.findLast(event=>event.kind==='point'&&event.data?.eventId===d.pointId&&typeof event.data?.objectId==='string');
    const objectId=point?.data?.objectId;
    const object=typeof objectId==='string'?currentPage(flight.snapshot).objects.find(item=>item.id===objectId):undefined;
    push('audio',object?`开始播放对${object.chinese||object.label}的回应`:'开始播放对这次点选的回应',{event:'point.playback_started',pointId:d.pointId,stage,source:'client',clock:'client',...(object?{objectId:object.id}:{})},'display');
   }else if(stage&&stages[stage])push('point',stages[stage],{pointId:d.pointId??'',stage,...(d.pointReason?{reason:d.pointReason}:{})});
   return;
  }
  if(entry.name==='voice_response_cancel'){push('audio','应用请求打断回复',{reason:d.state==='learner_speech'?'learner_speech':'application_update'});return;}
  if(entry.name==='voice_request_recovery'||entry.name==='voice_overlap_reply'){
   push(entry.status==='failed'?'error':'connection',entry.name==='voice_overlap_reply'?'已发送一次本轮补答请求':'语音连接恢复状态',{stage:d.state??entry.status});return;
  }
  if(entry.name==='silence_prompt'){
   push('audio','应用请求老师在等待后提醒',{event:'silence_prompt'});return;
  }
  if(entry.name==='voice_provider_failure'){
   const data:NonNullable<LabInput['data']>={event:entry.name};
   for(const key of ['errorCode','providerErrorType','providerErrorCode','providerErrorReason','providerErrorParam','requestCorrelation','requestId','requestType','state','action'] as const){
    const value=d[key];if(typeof value==='string')data[key]=value;
   }
   push('error',`${providerLabel(flight.provider)}请求处理异常`,data);return;
  }
  if(entry.name==='diagnostic_phase'){
   const stage=d.phase,base={...(d.turnId?{turnId:d.turnId}:{}),...(d.spanId?{spanId:d.spanId}:{}),...(typeof d.elapsedMs==='number'?{elapsedMs:d.elapsedMs}:{}),...(d.clock?{clock:d.clock}:{})};
   if(stage==='audio_first_sent')push('audio','首段老师音频已发往浏览器',base);
   if(stage==='playback_started'&&d.source==='client'&&d.clock==='client')push('audio','服务端已核验浏览器播放回执',base,'display');
   if(stage==='playback_finished'&&d.source==='client'&&d.clock==='client')push('audio','浏览器报告本轮播放结束',base,'display');
   return;
  }
  if(entry.name==='inspect_current_page'&&entry.kind==='tool'&&entry.status==='confirmed'&&d.resultStatus==='reference'){push('tool','本轮有可引用的教材画面',{tool:'inspect_current_page',result:'reference',understandingConfirmed:false});return;}
  if(entry.name==='voice_connected')push('connection',`${providerLabel(flight.provider)}实时语音连接已就绪`);
  else if(entry.status==='failed'||entry.status==='rejected'&&entry.kind==='tool'){
   if(entry.kind==='tool')push('tool','应用未接受工具请求',{tool:publicTool(entry.name),status:entry.status});
   else push('error','本轮发生处理异常',{event:entry.name,...(d.errorCode?{errorCode:d.errorCode}:{})});
  }
 }

 function observeProvider(flight:Flight,socket:WebSocket){
  const push=(kind:LabInput['kind'],label:string,data:LabInput['data']={})=>emit(flight,{layer:'provider',kind,label,data});
  const original=socket.send.bind(socket);
  let firstAudioIn=false,firstAudioOut=false;
  let sentPlanPage:string|undefined;
  socket.send=((raw:WebSocket.RawData,...rest:unknown[])=>{
   const sent=Reflect.apply(original,socket,[raw,...rest]);
   const e=decode(raw);
   if(flight.provider==='openai'){
    if(e.type==='session.start')push('connection','已向 GPT Live 发送实时会话配置',{event:e.type});
    else if(e.type==='session.input_audio.append'&&!firstAudioIn){firstAudioIn=true;push('audio','首个麦克风分帧已向 GPT Live 发送',{event:e.type,format:'PCM16',sampleRate:24000,bytes:bytes(e.audio)});}
    else if(e.type==='session.thinking.append'){
     const page=currentPage(flight.snapshot);
     if(typeof e.content==='string'&&e.content.includes(`Current textbook page ${flight.snapshot.stepIndex+1} / ${flight.snapshot.course.pages.length}: ${page.id}.`)&&sentPlanPage!==page.id){
      sentPlanPage=page.id;
      push('connection','当前页教材已发给 GPT Live',{event:'guide.plan.sent',pageId:page.id});
     }
    }else if(e.type==='session.commentary.append')push('audio','已请求 GPT Live 开口回应',{event:e.type});
    return sent;
   }
   if(e.type==='session.update'&&flight.guided){
    const page=currentPage(flight.snapshot),instructions=obj(e.session).instructions,plan=labGuidePlan(page.id);
    if(plan&&typeof instructions==='string'&&instructions.includes(plan.instructions)&&sentPlanPage!==page.id){
     sentPlanPage=page.id;
     push('connection','当前页讲解方案已发给通义',{event:'guide.plan.sent',pageId:page.id});
    }
   } else if(e.type==='input_audio_buffer.append'){
    if(!firstAudioIn){firstAudioIn=true;push('audio','首个麦克风分帧已向通义发送',{event:e.type,format:'PCM16',sampleRate:16000,bytes:bytes(e.audio)});}
   } else if(e.type==='input_image_buffer.append'){
    push('image','JPEG 已向通义发送',{event:e.type,format:'JPEG',bytes:bytes(e.image),scope:'当前视觉来源，见服务器同源记录'});
   } else if(e.type==='response.create'){
    const instructions=obj(e.response).instructions;
    let cue:unknown;
    if(typeof instructions==='string'){
     const lines=instructions.split('\n');
     try{if(lines.at(-2)?.startsWith('Application teaching cue:'))cue=JSON.parse(lines.at(-1)??'');}catch{}
    }
    const match=typeof cue==='string'?/^The learner made a pointer gesture to this labelled textbook object: \{"id":"([a-z-]+)"/.exec(cue):null;
    const object=currentPage(flight.snapshot).objects.find(object=>object.id===match?.[1]);
    if(object)push('point','通义回复请求含教材对象参考',{event:e.type,objectId:object.id,label:object.label,representation:'文本对象参考',imageSent:false,coordinatesSent:false});
    else push('connection','应用向通义请求开始回复',{event:e.type,direction:'send'});
   } else if(e.type==='response.cancel')push('audio','应用向通义发出取消回复',{event:e.type});
   else if(e.type==='conversation.item.create'&&obj(e.item).type==='function_call_output')push('tool','已向通义发送工具结果',{event:e.type,representation:'function_call_output'});
   return sent;
  }) as typeof socket.send;
  socket.on('message',raw=>{
   const e=decode(raw);
   if(flight.provider==='openai'){
    if(e.type==='session.started')push('connection','GPT Live 已建立实时会话',{event:e.type});
    else if(e.type==='session.commentary.appended')push('audio','GPT Live 已接收回应请求',{event:e.type});
    else if(e.type==='session.output_audio.delta'&&!firstAudioOut){firstAudioOut=true;push('audio','收到 GPT Live 首段音频',{event:e.type,bytes:bytes(e.delta)});}
    else if(e.type==='error')push('error','GPT Live 返回请求异常',{event:e.type});
    return;
   }
   if(e.type==='input_audio_buffer.speech_started'){
    // A newer start can revoke delayed actions before its own final arrives.
    if(typeof e.item_id==='string'&&e.item_id.length>0&&e.item_id.length<=200&&flight.nativeVoiceItem!==e.item_id){
     flight.nativeVoiceItem=e.item_id;flight.nativeTextPoint=undefined;
    }
    push('speech','通义检测到说话开始',{event:e.type});
   }else if(e.type==='input_audio_buffer.speech_stopped'){
    // A later click cannot change what an in-flight transcription referred to.
    if(typeof e.item_id==='string'&&flight.nativeVoiceItem===e.item_id&&flight.nativeTextPoint?.itemId!==e.item_id){
     flight.nativeTextPoint={itemId:e.item_id,selection:currentTextPoint(flight.textPoint,now())};
    }
    push('speech','通义检测到说话结束',{event:e.type});
   }
   else if(e.type==='response.created'){
    firstAudioOut=false;
    push('audio','通义开始生成回复',{event:e.type});
   }else if(e.type==='response.done'){
    const state=obj(e.response).status;
    push('audio','通义结束本次生成',{event:e.type,status:state==='completed'||state==='cancelled'||state==='failed'?state:'unknown'});
   }else if(e.type==='response.audio.delta'&&!firstAudioOut){
    firstAudioOut=true;push('audio','收到通义首段音频',{event:e.type,bytes:bytes(e.delta)});
   }else if(e.type==='response.function_call_arguments.done'){
    const tool=publicTool(e.name),parameters=typeof e.arguments==='string'&&e.arguments.length<=10000?decode(e.arguments):{};
    const page=currentPage(flight.snapshot),plan=flight.guided?labGuidePlan(page.id):null;
    const ids=tool==='highlight_objects'?knownIds(parameters.objectIds,plan?.targetIds??page.objects.map(object=>object.id)):[];
    push('tool','通义请求调用工具',{event:e.type,tool,...(ids.length?{objectIds:ids.join(', ')}:{})});
   }else if(e.type==='error')push('error','通义返回请求异常',{event:e.type});
  });
  return socket;
 }
 const defaultConnect=(url:string,headers:Record<string,string>)=>new WebSocket(url,{headers,maxPayload:512000,handshakeTimeout:15000,perMessageDeflate:false});
 const sockets=attachClassroomSockets(server,{origin,allowUpgrade:allowedHost,sessionCookieName:COOKIE,pointReplyDelayMs:500,silencePromptEnabled:false,open:startLease,connect:(url,headers,lease)=>{
  const flight=sessions.get(lease.id);
  if(!flight||!flight.active)throw Error('Lab connection no longer active.');
  return observeProvider(flight,(options.connect??defaultConnect)(url,headers,lease));
 }});
 return {server,origin,async close(){const closed=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await sockets.close();server.closeAllConnections();await closed;sessions.clear();}};
}

async function buildAssets(){
 const here=fileURLToPath(new URL('.',import.meta.url)),publicRoot=fileURLToPath(new URL('../../public/',import.meta.url)),outDir=await mkdtemp(join(tmpdir(),'teeko-interaction-lab-'));
 try{
  const {build}=await import('vite');
  await build({configFile:false,root:here,base:'/',publicDir:false,logLevel:'error',oxc:{jsx:{runtime:'automatic'}},build:{outDir,emptyOutDir:true,sourcemap:false}});
  const assets=new Map<string,Asset>();
  const put=async (url:string,file:string)=>{
   const extension=file.split('.').at(-1)??'',contentType=contentTypes[extension];
   if(!contentType)throw Error('Unexpected experimental asset type.');
   assets.set(url,{body:await readFile(file),contentType});
  };
  await put('/',join(outDir,'index.html'));
  for(const name of await readdir(join(outDir,'assets')))if(/^[A-Za-z0-9_.-]+\.(?:js|css)$/.test(name))await put('/assets/'+name,join(outDir,'assets',name));
  for(const {image} of guidedPages)await put(image,join(publicRoot,image));
  await put(LAB_ILLUSTRATION,join(publicRoot,LAB_ILLUSTRATION));
  await put(LAB_READ_ILLUSTRATION,join(publicRoot,LAB_READ_ILLUSTRATION));
  await put('/favicon.svg',join(publicRoot,'favicon.svg'));
  await put('/voice-capture.worklet.js',join(publicRoot,'voice-capture.worklet.js'));
  return assets;
 }finally{await rm(outDir,{recursive:true,force:true});}
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 try{
  const runtime=await startInteractionLabServer({assets:await buildAssets()});
  console.log('Teeko interaction lab: '+runtime.origin+'/');
  let closing=false;
  for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{
   if(closing)return;closing=true;
   void runtime.close().catch(()=>{process.exitCode=1;});
  });
 }catch{
  console.error('Unable to start the local Teeko interaction lab. Check the local build and port 8084.');
  process.exitCode=1;
 }
}
