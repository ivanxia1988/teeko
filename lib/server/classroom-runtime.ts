import {buildClassroomVoicePrompt} from './classroom-voice-prompt';
import { getAccountPool } from '../../db/postgres';
import { accountCookie } from './account-http';
import { accountOrigin, getAccountService } from './account-runtime';
import { readRuntimeEnv } from './runtime-env';
import { ClassroomError, ClassroomService } from './classroom-service';
import { publishTrialCourses } from './course-catalog';
import { createClassroomHandler } from './classroom-http';
import type { ClassroomSnapshot } from '../classroom-contract';
import type { VoiceLease } from './classroom-sockets';
import { refreshClassroom } from './classroom-events';
import {createOpenAIClassroomVision} from './classroom-vision-openai';
import {initializeTeacherAgents,resolvePublishedTeacher} from './admin-service';
import {buildTeacherInstructions,buildTeacherGuidance,type TeacherTeachingState} from '../teacher-instructions';
import {DEFAULT_TEACHER_POLICY,type FrozenTeacherConfig} from '../teacher-agent';
import {createTeacherAssessment,type TeacherAssessment} from './teacher-assessment';
import {classroomControl} from './classroom-teaching';
import {getTeacherCredentialRoutes} from './model-credentials-runtime';
import {ClassroomChalkReader} from './classroom-chalk-reader';
import {randomUUID} from 'node:crypto';

let service:ClassroomService|undefined;
let publishing:Promise<void>|undefined;
export async function getClassroomService(){
  const pool=getAccountPool(readRuntimeEnv('DATABASE_URL'));
  if(!publishing)publishing=publishTrialCourses(pool).then(()=>initializeTeacherAgents(pool)).catch(error=>{publishing=undefined;throw error;});
  await publishing;
  const assess:TeacherAssessment=async(input,signal)=>{
    const provider=input.snapshot.preferences.provider,model=input.config.routes[provider]?.reasoning?.model;
    if(!model||provider==='openai'&&readRuntimeEnv('OPENAI_CHILD_DATA_READY')!=='true')throw new Error('教学判断暂时不可用。');
    const credential=await getTeacherCredentialRoutes().forModel(provider,'reasoning',input.config.routes[provider]!.reasoning);
    return createTeacherAssessment({provider,model,...credential})(input,signal);
  };
  service??=new ClassroomService(pool,{assess});return service;
}
export async function classroomProviders(config:FrozenTeacherConfig|null){
  const configured=await getTeacherCredentialRoutes().availability(config);
  return [
    {id:'qwen' as const,name:'通义',configured:configured.qwen},
    {id:'openai' as const,name:'GPT Live',configured:configured.openai},
    {id:'grok' as const,name:'Grok Voice 3.0',configured:configured.grok},
  ];
}
export async function handleClassroomRequest(request:Request){
  try{
    const origin=accountOrigin(),accounts=getAccountService(),service=await getClassroomService();
    const path=new URL(request.url).pathname;
    const needsProviders=path==='/api/v1/classroom-options'||path==='/api/v1/classrooms'&&request.method==='POST';
    const providers=needsProviders?await classroomProviders(await resolvePublishedTeacher(getAccountPool(readRuntimeEnv('DATABASE_URL')))):[];
    return await createClassroomHandler({origin,service,authenticate:req=>accounts.session(accountCookie(req,'teeko_session')),providers:()=>providers,limit:id=>accounts.limit(`classroom-http:${id}`,90,60),limitDiagnostics:id=>accounts.limit(`classroom-diagnostics:${id}`,90,60),changed:refreshClassroom})(request);
  }catch{return Response.json({ok:false,error:{code:'UNAVAILABLE',message:'课堂服务暂时不可用，请稍后重试。'}},{status:503,headers:{'Cache-Control':'no-store'}});}
}
export function classroomInstructions(snapshot:ClassroomSnapshot,config:FrozenTeacherConfig|null=null,state?:TeacherTeachingState){return buildTeacherInstructions(snapshot,config,state);}

export async function openClassroomVoice(request:Request,id:string):Promise<VoiceLease>{
  if(request.headers.get('origin')!==accountOrigin())throw new ClassroomError('ORIGIN','请求来源无效。',403);
  const token=accountCookie(request,'teeko_session'),accounts=getAccountService();
  const user=await accounts.session(token);
  if(!user||!user.profileComplete)throw new ClassroomError('UNAUTHORIZED','请先登录并填写档案。',401);
  const service=await getClassroomService();
  const initial=await service.get(user.id,id);
  const before=await service.teacherRuntime(user.id,id);
  let configuration;
  try{configuration=await getTeacherCredentialRoutes().voice(initial,before.config);}catch{throw new ClassroomError('VOICE_UNAVAILABLE','语音服务尚未配置。',503);}
  if(initial.preferences.provider==='openai'&&!configuration.childDataReady)throw new ClassroomError('VOICE_UNAVAILABLE','语音服务尚未配置。',503);
  await accounts.limit(`classroom-connect:${user.id}`,12,60);
  const lease=await service.claim(user.id,id);
  const active=async()=>Boolean((await accounts.session(token))?.id===user.id);
  const teacher=await service.teacherRuntime(user.id,id),route=teacher.config?.routes[lease.snapshot.preferences.provider];
  if(teacher.config&&!route){await service.release(user.id,id,lease.epoch,lease.ownerToken);throw new ClassroomError('VOICE_UNAVAILABLE','本节课未配置所选教师服务。',503);}
  let observe:VoiceLease['observe'];
  // Invalid optional vision configuration must not take down an otherwise usable voice session.
  if(lease.snapshot.preferences.provider==='openai'&&(!teacher.config||teacher.config.routes.openai?.vision))observe=async(frame,signal)=>{
    const credential=await getTeacherCredentialRoutes().forModel('openai','vision',teacher.config?.routes.openai?.vision);
    return createOpenAIClassroomVision({apiKey:credential.apiKey,model:(teacher.config?.routes.openai?.vision?.model||readRuntimeEnv('OPENAI_VISION_MODEL')||'gpt-4.1-mini').trim()})(frame,signal);
  };
  const chalkReader=new ClassroomChalkReader((snapshot,signal)=>service.readChalkCandidate(user.id,id,lease.epoch,lease.ownerToken,snapshot,signal));
  const snapshot = lease.snapshot;
  const prompt = buildClassroomVoicePrompt(snapshot,configuration.model,teacher.config,teacher.state);
  return {id,epoch:lease.epoch,provider:lease.snapshot.preferences.provider,nativeApplicationInputs:true,configuration,...(route?{model:route.realtime.model}:{}),
    voice:teacher.config?.voices[lease.snapshot.preferences.provider]?.[lease.snapshot.preferences.voice]??(lease.snapshot.preferences.provider==='grok'?(lease.snapshot.preferences.voice==='male'?'rex':'eve'):lease.snapshot.preferences.provider==='qwen'?(lease.snapshot.preferences.voice==='male'?'Aiden':'Jennifer'):(lease.snapshot.preferences.voice==='male'?'meridian':'gleam')),
    ...(observe?{observe}:{}),
    thinkingSeconds:(teacher.config?.policy??DEFAULT_TEACHER_POLICY).levels[teacher.state.level].thinkingSeconds,
    teachingGuidance:buildTeacherGuidance(snapshot,teacher.config,teacher.state),
    instructions:prompt.instructions,
    initialCue:prompt.initialCue,
    ...(prompt.highlightModel ? {gptRobotHighlight: {
      model:prompt.highlightModel,
      apply:async (scope:ClassroomSnapshot, callId:string, objectId:string, isCurrent:()=>boolean) => {
        const applied = await service.applyGptRobotHighlight(user.id,id,lease.epoch,lease.ownerToken,scope,callId,objectId,active,isCurrent);
        if (applied) await refreshClassroom(id);
        return applied;
      },
    }} : {}),
    remainingMs:lease.snapshot.remainingSeconds*1000,snapshot:lease.snapshot,
    started:async sessionId=>{await service.providerStarted(user.id,id,lease.epoch,lease.ownerToken,sessionId);},
    heartbeat:async()=>{if(!await active())return null;const snapshot=await service.heartbeat(user.id,id,lease.epoch,lease.ownerToken);if(!snapshot)return null;const current=await service.teacherRuntime(user.id,id);const chalk=lease.snapshot.preferences.provider==='qwen'?chalkReader.peek(snapshot):null;return{thinkingSeconds:(current.config?.policy??DEFAULT_TEACHER_POLICY).levels[current.state.level].thinkingSeconds,snapshot,instructions:classroomInstructions(snapshot,current.config,current.state),teachingGuidance:buildTeacherGuidance(snapshot,current.config,current.state),...(chalk?{chalk}:{})};},
    transcript:async event=>{
      if(!await active())return;
      // Persist complete evidence before releasing the socket's transcript chain;
      // semantic work must not prevent a newer utterance from invalidating it.
      await service.transcript(user.id,id,lease.epoch,lease.ownerToken,event);
      if(event.role==='child'&&event.final){
        const apply=()=>service.receiveTranscript(user.id,id,lease.epoch,lease.ownerToken,event,active).then(applied=>refreshClassroom(id,applied==='navigation'?'explicit_navigation':undefined));
        if(classroomControl(event.text))await apply();else if(lease.snapshot.preferences.provider==='openai'||event.source==='typed')void apply().catch(()=>service.journal(user.id,id,lease.epoch,lease.ownerToken,{eventKey:`apply-failed:${randomUUID()}`,kind:'interaction',actor:'application',status:'failed',name:'interaction_apply',correlationId:event.itemId,details:{errorCode:'UNAVAILABLE'}}).catch(()=>{}));
      }
    },
    tool:async(name,args,callId,request)=>{if(!await active())throw new ClassroomError('UNAUTHORIZED','登录已失效。',401);return service.tool(user.id,id,lease.epoch,lease.ownerToken,name,args,active,{actor:request?.source==='application'?'application':'teacher',callId,request});},
    point:async(request,isCurrent)=>{if(!await active())throw new ClassroomError('UNAUTHORIZED','登录已失效。',401);return service.point(user.id,id,lease.epoch,lease.ownerToken,request,async()=>await active()&&isCurrent());},
    journal:async entry=>{if(await active())await service.journal(user.id,id,lease.epoch,lease.ownerToken,entry);},
    closed:async()=>{chalkReader.close();await service.release(user.id,id,lease.epoch,lease.ownerToken);},
  };
}
