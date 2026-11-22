import {classroomHighlightTargetFragment,isExplicitHighlightTargetFragment,isIncompleteClassroomHighlight,requestedClassroomHighlights,requestedClassroomSplitHighlights} from '../classroom-highlight-requests';
import { createHash, randomUUID } from 'node:crypto';
import {appendClassroomJournal} from './classroom-journal';
import type {ClassroomJournalEntry,ClassroomJournalDetails} from '../classroom-journal';
import type { Pool, PoolClient } from 'pg';
import {validateClassroomToolRequest,type ClassroomToolOutput,type ClassroomToolRequest,type ClassroomToolAdvance} from '../domain/classroom-tool';
import {parseClassroomNotesQuery,encodeClassroomNotesCursor,type ClassroomNotesPage} from '../classroom-notes';
import {buildClassroomNote} from './classroom-notes';
import {buildClassroomChalkCandidate,type ClassroomChalkCandidate} from './classroom-chalk-candidate';
import {captureClassroomNote,buildClassroomNoteManifest,parseClassroomNoteManifest,pageClassroomNoteManifest,readClassroomNoteSources,type ClassroomNoteOwner} from './classroom-note-store';
import {requestedClassroomReview,buildClassroomReviewReference} from '../classroom-review';
import {validateClassroomContext} from '../domain/classroom-context';
import {captureClassroomToolState} from '../classroom-tool-state';
import {captureClassroomSelection} from '../classroom-event-input';
import {captureClassroomPoint,type ClassroomPointRequest} from '../classroom-point';
import {canHighlightRobotWings} from './classroom-live-highlight';
import {classroomPointDiagnosticsBodySchema,type ClassroomPointDiagnosticEvent} from '../classroom-point-diagnostics';
import { classroomControl, isReadingSupportRequest, normalizeClassroomSpeech, readingNavigation, spokenTaskAttempt } from './classroom-teaching';
import {isOpenClassroomConversation,isReadingRecital,isReadingStep} from '../classroom-reading';
import {resolvePublishedTeacher} from './admin-service';
import type {FrozenTeacherConfig} from '../teacher-agent';
import {DEFAULT_TEACHER_POLICY} from '../teacher-agent';
import {readTeachingState,recordTeachingEvidence,teacherAssessmentResultSchema,type TeacherAssessmentResult} from '../teacher-instructions';
import type {TeacherAssessment} from './teacher-assessment';
import type { ClassroomAction, ClassroomFeedback, ClassroomOutcome, ClassroomPreferences, ClassroomSnapshot, CourseCard, PublishedCourse, RecentClassroom } from '../classroom-contract';
import {TOPIC_CATALOG,isTopicCourse,parseTopicHistoryQuery,encodeTopicHistoryCursor,type TopicCard,type TopicHistoryResponse,type TopicHistoryRecord} from '../topic-learning';

export class ClassroomError extends Error {
  constructor(public code:string,message:string,public status=409){super(message);}
}
export const DEFAULT_CLASSROOM_PREFERENCES:ClassroomPreferences={provider:'qwen',language:'bilingual',style:'gentle',voice:'female',soundEffects:true};
type Row = {
  id:string;account_id:string;course_id:string;course_version:string;profile:ClassroomSnapshot['profile'];preferences:ClassroomPreferences;
  status:ClassroomSnapshot['status'];revision:number;connection_epoch:number;step_index:number;elapsed_ms:number|string;max_ms:number|string;
  limit_reason:'time_limit'|'daily_limit';active_since:Date|null;owner_token:string|null;lease_until:Date|null;
  outcomes:ClassroomOutcome[];helped_steps:string[];teacher_object_ids:string[];feedback:ClassroomFeedback|null;
  started_at:Date;ended_at:Date|null;end_reason:ClassroomSnapshot['endReason'];day_key:string;
  teacher_config:FrozenTeacherConfig|null;teaching_state:unknown;
};
type Transcript={role:'child'|'teacher';text:string;final:boolean;itemId?:string;contextKey?:string;source?:'speech'|'typed'};
type ChildEvidence={item_id:string;text:string;created_at:Date;source:'speech'|'typed'};
type HighlightIntent={type:'highlight';objectIds:string[];itemIds:string[]}|{type:'clarify'};
type Options={now?:()=>Date;maxSeconds?:number;dailySeconds?:number;assess?:TeacherAssessment;topicCards?:readonly TopicCard[];bundledVersions?:ReadonlyMap<string,string>};
type Assessed={itemId:string;contextKey:string;createdAt:Date;result:TeacherAssessmentResult};
type AssessmentFlight={itemId:string;contextKey:string;controller:AbortController;promise:Promise<Assessed|null>;expires:ReturnType<typeof setTimeout>};
type ToolOutput=ClassroomToolOutput;
type ToolAudit={actor:'teacher'|'application';callId?:string;request?:ClassroomToolRequest};
function boundExecutionRequest(snapshot:Parameters<typeof captureClassroomToolState>[0],name:string,args:unknown,audit:ToolAudit):ClassroomToolRequest|null{
 const captured=captureClassroomToolState(snapshot),scoped=captured.ok?validateClassroomToolRequest(captured.snapshot,audit.request):null;
 const application=name==='delegate'||name==='chalk_write'&&!!args&&typeof args==='object'&&'evidenceItemId' in args;
 const actorAllowed=audit.actor==='teacher'||audit.actor==='application'&&application;
 if(!actorAllowed||!captured.ok||!scoped?.accepted||scoped.request.callId!==audit.callId||scoped.request.source!==(application?'application':'teacher'))return null;
 const proposed=validateClassroomToolRequest(captured.snapshot,{...scoped.request,command:{name,arguments:args}});
 return proposed.accepted&&JSON.stringify(proposed.request.command)===JSON.stringify(scoped.request.command)?scoped.request:null;
}

const journalKey=(kind:string,value:string)=>`${kind}:${createHash('sha256').update(value).digest('hex')}`;
const toolJournalDetails=(args:unknown):ClassroomJournalDetails=>{
  const data=args&&typeof args==='object'&&!Array.isArray(args)?args as Record<string,unknown>:{};
  return Object.fromEntries(['contextKey','objectIds','question','answer'].filter(key=>data[key]!==undefined).map(key=>[key,data[key]])) as ClassroomJournalDetails;
};
const fail=(code:string,message:string,status=409):never=>{throw new ClassroomError(code,message,status);};
const day=(now:Date)=>new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
const normalize=normalizeClassroomSpeech;
const requestedHighlights=(text:string,course:PublishedCourse,pageId:string)=>requestedClassroomHighlights(text,course.pages.find(page=>page.id===pageId)?.objects??[]);
const HIGHLIGHT_FRAGMENT_MS=5000;
const highlightClarification:ToolOutput={status:'conversation',english:'The learner asked for a textbook circle but the current object is unclear. Ask which visible textbook object they want you to circle. Do not grade the request or claim a circle appeared.'};
export class ClassroomService {
  private now:()=>Date; private maxMs:number; private dailyMs:number; private hasExplicitMax:boolean;
  private assess?:TeacherAssessment;private assessments=new Map<string,AssessmentFlight>();
  private topicCards:readonly TopicCard[];
  private bundledVersions?:ReadonlyMap<string,string>;
  constructor(private pool:Pool,options:Options={}){
    this.assess=options.assess;this.now=options.now??(()=>new Date()); this.maxMs=(options.maxSeconds??900)*1000; this.dailyMs=(options.dailySeconds??3600)*1000;this.hasExplicitMax=options.maxSeconds!==undefined;
    this.topicCards=options.topicCards??TOPIC_CATALOG;this.bundledVersions=options.bundledVersions;
    if(!Number.isFinite(this.maxMs)||!Number.isFinite(this.dailyMs)||this.maxMs<=0||this.dailyMs<this.maxMs) throw new Error('Invalid classroom limits.');
  }
  private async tx<T>(accountId:string,work:(db:PoolClient)=>Promise<T>):Promise<T>{
    const db=await this.pool.connect();
    try { await db.query('BEGIN'); const owner=await db.query('SELECT id FROM teeko_accounts WHERE id=$1 FOR UPDATE',[accountId]);
      if(!owner.rowCount) fail('UNAUTHORIZED','请重新登录。',401);
      const value=await work(db);await db.query('COMMIT');return value;
    } catch(error){await db.query('ROLLBACK');throw error;} finally{db.release();}
  }
  private async row(db:PoolClient,accountId:string,id:string):Promise<Row>{
    const result=await db.query('SELECT * FROM teeko_classrooms WHERE id=$1 AND account_id=$2 FOR UPDATE',[id,accountId]);
    if(!result.rowCount) fail('NOT_FOUND','没有找到这节课堂。',404);return result.rows[0];
  }
  private async course(db:PoolClient,row:Row):Promise<PublishedCourse>{
    const result=await db.query('SELECT manifest FROM teeko_courses WHERE id=$1 AND version=$2',[row.course_id,row.course_version]);
    if(!result.rowCount) fail('COURSE_UNAVAILABLE','这份课件暂时不可用。',503);return result.rows[0].manifest;
  }
  private async note(db:PoolClient,row:Row,entry:ClassroomJournalEntry,stepIndex=row.step_index){
    await appendClassroomJournal(db,{classroomId:row.id,epoch:row.connection_epoch,revision:row.revision,stepIndex},entry,this.now());
  }
  /** Only the authenticated owner can append runtime metadata; it never controls the lesson. */
  async journal(accountId:string,id:string,epoch:number,token:string,entry:ClassroomJournalEntry):Promise<boolean>{return this.tx(accountId,async db=>{
    const row=await this.row(db,accountId,id);await this.settle(db,row);await this.save(db,row);
    if(row.status!=='active'||row.connection_epoch!==epoch||row.owner_token!==token)return false;
    let stepIndex=row.step_index;const contextKey=entry.details?.contextKey;
    if(contextKey!==undefined){
      const prefix=`${id}:${epoch}:`,value=contextKey.startsWith(prefix)?contextKey.slice(prefix.length):'';
      if(!/^\d{1,6}$/.test(value))return false;stepIndex=Number(value);
      const course=await this.course(db,row);if(stepIndex>=course.steps.length)return false;
      if(entry.actor==='child'&&entry.kind==='interaction'&&stepIndex!==row.step_index)return false;
    }
    await this.note(db,row,entry,stepIndex);return true;
  });}
  /** Client observations are diagnostics, never authorization, answers or teacher playback evidence. */
  async pointDiagnostics(accountId:string,id:string,input:ClassroomPointDiagnosticEvent[]):Promise<void>{
    const {events}=classroomPointDiagnosticsBodySchema.parse({events:input});
    return this.tx(accountId,async db=>{
      const row=await this.row(db,accountId,id),snapshot=await this.snapshot(db,row),captured=captureClassroomToolState(snapshot);if(!captured.ok)return;
      const current=captured.snapshot.context;
      for(const event of events){
        const scope=event.context;
        if(scope.logicalSessionId!==current.logicalSessionId||scope.courseVersion!==current.courseVersion||scope.connectionEpoch!==current.connectionEpoch||scope.pageId!==current.pageId||scope.activityId!==current.activityId||scope.stateRevision>current.stateRevision)continue;
        const failed=['send_failed','unavailable','timeout'].includes(event.stage);
        await this.note(db,row,{eventKey:`point-client:${event.id}`,name:'point_trace',kind:'interaction',actor:'child',status:failed?'failed':'recorded',correlationId:event.pointId,details:{pointId:event.pointId,pointStage:event.stage,...(event.reason?{pointReason:event.reason}:{}),source:'client',contextKey:`${id}:${row.connection_epoch}:${row.step_index}`,...(event.objectId?{objectIds:[event.objectId]}:{})}});
      }
    });
  }
  private async settle(db:PoolClient,row:Row){
    const now=this.now();
    if(row.status==='active'&&row.active_since&&row.lease_until){
      let cursor=row.active_since.getTime();
      const until=Math.min(now.getTime(),row.lease_until.getTime(),cursor+Number(row.max_ms)-Number(row.elapsed_ms));
      while(cursor<until){
        const bucket=day(new Date(cursor));
        const midnight=Date.parse(`${bucket}T00:00:00+08:00`)+86400000;
        const used=Number((await db.query('SELECT milliseconds FROM teeko_classroom_usage WHERE account_id=$1 AND day_key=$2',[row.account_id,bucket])).rows[0]?.milliseconds??0);
        const delta=Math.max(0,Math.min(until,midnight)-cursor),allowed=Math.max(0,Math.min(delta,this.dailyMs-used));
        if(allowed)await db.query('INSERT INTO teeko_classroom_usage(account_id,day_key,milliseconds) VALUES($1,$2,$3) ON CONFLICT(account_id,day_key) DO UPDATE SET milliseconds=teeko_classroom_usage.milliseconds+EXCLUDED.milliseconds',[row.account_id,bucket,allowed]);
        row.elapsed_ms=Number(row.elapsed_ms)+allowed;cursor+=allowed;
        if(allowed<delta){this.finish(row,'daily_limit');break;}
      }
      row.active_since=now;
      if(row.end_reason){row.active_since=null;}
      else if(Number(row.elapsed_ms)>=Number(row.max_ms)){this.finish(row,row.limit_reason);}
      else if(now>=row.lease_until){row.status='paused';row.owner_token=null;row.active_since=null;row.lease_until=null;row.revision++;}
      if(row.end_reason||row.status==='paused')await this.note(db,row,{eventKey:`settled:${row.connection_epoch}:${row.revision}`,kind:'connection',actor:'application',status:'recorded',name:row.end_reason?'classroom_ended':'lease_expired',details:{state:row.end_reason?'ended':'paused',...(row.end_reason?{endReason:row.end_reason}:{})}});
    }
  }
  private finish(row:Row,reason:NonNullable<Row['end_reason']>){row.status='ended';row.end_reason=reason;row.ended_at=this.now();row.owner_token=null;row.lease_until=null;row.active_since=null;row.revision++;}
  private async save(db:PoolClient,row:Row){
    await db.query(`UPDATE teeko_classrooms SET status=$2,revision=$3,connection_epoch=$4,step_index=$5,elapsed_ms=$6,active_since=$7,owner_token=$8,lease_until=$9,outcomes=$10,helped_steps=$11,teacher_object_ids=$12,feedback=$13,ended_at=$14,end_reason=$15,max_ms=$16,limit_reason=$17,teaching_state=$18 WHERE id=$1`,
      [row.id,row.status,row.revision,row.connection_epoch,row.step_index,row.elapsed_ms,row.active_since,row.owner_token,row.lease_until,JSON.stringify(row.outcomes),JSON.stringify(row.helped_steps),JSON.stringify(row.teacher_object_ids),JSON.stringify(row.feedback),row.ended_at,row.end_reason,row.max_ms,row.limit_reason,JSON.stringify(row.teaching_state??{})]);
    if(row.status==='ended'){
      await db.query('INSERT INTO teeko_classroom_note_state(classroom_id,captured_from_start) VALUES($1,false) ON CONFLICT DO NOTHING',[row.id]);
      await db.query("INSERT INTO teeko_classroom_note_jobs(id,classroom_id,source_revision,status,run_after,created_at,updated_at) VALUES($1,$2,$3,'pending',$4,$4,$4) ON CONFLICT(classroom_id) DO NOTHING",[randomUUID(),row.id,row.revision,this.now()]);
    }
  }
  private async snapshot(db:PoolClient,row:Row,course?:PublishedCourse):Promise<ClassroomSnapshot>{return {id:row.id,course:course??await this.course(db,row),profile:row.profile,preferences:row.preferences,status:row.status,revision:row.revision,connectionEpoch:row.connection_epoch,stepIndex:row.step_index,elapsedSeconds:Math.floor(Number(row.elapsed_ms)/1000),remainingSeconds:Math.max(0,Math.ceil((Number(row.max_ms)-Number(row.elapsed_ms))/1000)),maxSeconds:Number(row.max_ms)/1000,outcomes:row.outcomes,teacherObjectIds:row.teacher_object_ids,feedback:row.feedback,endReason:row.end_reason,startedAt:row.started_at.toISOString(),endedAt:row.ended_at?.toISOString()??null,reportStatus:'unavailable'};}
  private async markPlannedTopicObject(db:PoolClient,row:Row,course:PublishedCourse){
    if(!course.topic||row.status!=='active'||row.preferences.provider!=='openai')return;
    const step=course.steps[row.step_index],target=step?.targetId;
    if(!target||row.teacher_object_ids.includes(target)||!course.pages.find(page=>page.id===step.pageId)?.objects.some(object=>object.id===target))return;
    row.teacher_object_ids=[target];
    await this.note(db,row,{eventKey:`planned-topic-mark:${row.connection_epoch}:${row.step_index}`,kind:'tool',actor:'application',status:'confirmed',name:'highlight_objects',details:{source:'application',contextKey:`${row.id}:${row.connection_epoch}:${row.step_index}`,objectIds:[target],highlighted:[target],resultStatus:'confirmed',action:'planned_mark'}});
  }
  async preferences(accountId:string):Promise<ClassroomPreferences>{const result=await this.pool.query('SELECT preferences FROM teeko_preferences WHERE account_id=$1',[accountId]);return result.rows[0]?.preferences??{...DEFAULT_CLASSROOM_PREFERENCES};}
  async savePreferences(accountId:string,preferences:ClassroomPreferences){await this.pool.query('INSERT INTO teeko_preferences(account_id,preferences,updated_at) VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET preferences=EXCLUDED.preferences,updated_at=EXCLUDED.updated_at',[accountId,JSON.stringify(preferences),this.now()]);return preferences;}
  async topics():Promise<TopicCard[]>{
    const published=await this.pool.query('SELECT DISTINCT id FROM teeko_courses WHERE id=ANY($1::text[])',[this.topicCards.map(topic=>topic.id)]);
    const available=new Set(published.rows.map(row=>row.id));
    return this.topicCards.filter(topic=>available.has(topic.id)).map(topic=>structuredClone(topic));
  }
  async topicHistory(accountId:string,input:unknown={}):Promise<Omit<TopicHistoryResponse,'ok'>>{
    const parsed=parseTopicHistoryQuery(input);if(!parsed.ok)throw new ClassroomError('INVALID_INPUT','请求内容无效，请重新操作。',400);
    const {pageSize,cursor}=parsed.query;
    return this.tx(accountId,async db=>{
      const active=await db.query("SELECT * FROM teeko_classrooms WHERE account_id=$1 AND status<>'ended' FOR UPDATE",[accountId]);
      for(const row of active.rows){await this.settle(db,row);await this.save(db,row);}
      const current=active.rows.find(row=>row.status!=='ended');
      const result=await db.query(`SELECT r.id,r.course_id,r.started_at,r.ended_at,r.end_reason,r.elapsed_ms,c.manifest->>'title' AS course_title,
        j.status AS note_status,(SELECT count(*)::integer FROM teeko_classroom_note_records n WHERE n.classroom_id=r.id) AS note_count
        FROM teeko_classrooms r JOIN teeko_courses c ON c.id=r.course_id AND c.version=r.course_version
        LEFT JOIN teeko_classroom_note_jobs j ON j.classroom_id=r.id
        WHERE r.account_id=$1 AND (r.course_id=ANY($2::text[]) OR c.manifest ? 'topic') AND r.status='ended' AND r.ended_at IS NOT NULL
          AND ($3::timestamptz IS NULL OR (r.ended_at,r.id)<($3::timestamptz,$4::uuid))
        ORDER BY r.ended_at DESC,r.id DESC LIMIT $5`,[accountId,TOPIC_CATALOG.map(topic=>topic.id),cursor?.endedAt??null,cursor?.id??null,pageSize+1]);
      const records:TopicHistoryRecord[]=result.rows.slice(0,pageSize).map(row=>({
        id:row.id,courseId:row.course_id,courseTitle:row.course_title,startedAt:row.started_at.toISOString(),endedAt:row.ended_at.toISOString(),
        endReason:row.end_reason,elapsedSeconds:Math.floor(Number(row.elapsed_ms)/1000),noteCount:row.note_count,
        adviceStatus:row.note_status==='pending'||row.note_status==='running'?'pending':row.note_status==='succeeded'?'ready':'unavailable',
      }));
      const last=records.at(-1),nextCursor=result.rows.length>pageSize&&last?encodeTopicHistoryCursor({endedAt:last.endedAt,id:last.id}):null;
      return{records,nextCursor,activeClassroom:current?{id:current.id,courseId:current.course_id,status:current.status,provider:current.preferences.provider}:null};
    });
  }
  async courses(accountId:string){return this.tx(accountId,async db=>{
    const active=await db.query("SELECT * FROM teeko_classrooms WHERE account_id=$1 AND status<>'ended' FOR UPDATE",[accountId]);
    for(const row of active.rows){await this.settle(db,row);await this.save(db,row);}
    const result=await db.query("SELECT DISTINCT ON(id) manifest FROM teeko_courses WHERE NOT(id=ANY($1::text[]) OR manifest ? 'topic') ORDER BY id,published_at DESC",[TOPIC_CATALOG.map(topic=>topic.id)]);
    const history=await db.query('SELECT course_id,step_index,end_reason FROM teeko_classrooms WHERE account_id=$1 ORDER BY recorded_at DESC',[accountId]);
    const courses:CourseCard[]=result.rows.map(({manifest:course}:{manifest:PublishedCourse})=>{
      const last=history.rows.find(x=>x.course_id===course.id);const {pages:_pages,steps:_steps,...card}=course;void _pages;void _steps;
      return {...card,progress:{stepIndex:last?.step_index??0,completed:last?.end_reason==='content_completed'}};
    });
    const current=active.rows.find(row=>row.status!=='ended');
    const ended=await db.query("SELECT r.id,r.end_reason,r.ended_at,r.elapsed_ms,c.manifest->>'title' AS course_title FROM teeko_classrooms r JOIN teeko_courses c ON c.id=r.course_id AND c.version=r.course_version WHERE r.account_id=$1 AND NOT(r.course_id=ANY($2::text[]) OR c.manifest ? 'topic') AND r.status='ended' AND r.ended_at IS NOT NULL ORDER BY r.ended_at DESC,r.recorded_at DESC LIMIT 6",[accountId,TOPIC_CATALOG.map(topic=>topic.id)]);
    const recentClassrooms:RecentClassroom[]=ended.rows.map(row=>({id:row.id,courseTitle:row.course_title,endedAt:row.ended_at.toISOString(),endReason:row.end_reason,elapsedSeconds:Math.floor(Number(row.elapsed_ms)/1000)}));
    return {courses,activeClassroom:current?{id:current.id,courseId:current.course_id,status:current.status,provider:current.preferences.provider}:null,recentClassrooms};
  });}
  async create(accountId:string,courseId:string,preferences?:ClassroomPreferences){return this.tx(accountId,async db=>{
    const unfinished=await db.query("SELECT * FROM teeko_classrooms WHERE account_id=$1 AND status<>'ended' FOR UPDATE",[accountId]);
    for(const row of unfinished.rows){await this.settle(db,row);await this.save(db,row);if(row.status!=='ended') fail('CLASSROOM_EXISTS','你还有一节未结束的课堂，请先继续或结束它。');}
    const profile=(await db.query('SELECT name,age_range,level FROM teeko_profiles WHERE account_id=$1',[accountId])).rows[0];
    if(!profile)fail('PROFILE_REQUIRED','请先填写孩子档案。');
    const bundledVersion=this.bundledVersions?.get(courseId);
    const selected=(await db.query<{version:string;manifest:PublishedCourse}>('SELECT version,manifest FROM teeko_courses WHERE id=$1 AND ($2::text IS NULL OR version=$2) ORDER BY published_at DESC LIMIT 1',[courseId,bundledVersion??null])).rows[0];
    if(!selected||selected.manifest.topic&&this.bundledVersions&&!bundledVersion)fail('COURSE_UNAVAILABLE','这门课程暂时不可用。',404);
    const used=Number((await db.query('SELECT milliseconds FROM teeko_classroom_usage WHERE account_id=$1 AND day_key=$2',[accountId,day(this.now())])).rows[0]?.milliseconds??0);
    const remaining=this.dailyMs-used;if(remaining<1000)fail('DAILY_LIMIT','今天的试上课时长已用完，明天再来。');
    const saved=(await db.query('SELECT preferences FROM teeko_preferences WHERE account_id=$1',[accountId])).rows[0]?.preferences;
    const seconds=selected.manifest?.sessionLimitSeconds;
    const courseMax=typeof seconds==='number'&&Number.isSafeInteger(seconds)&&seconds>0&&Number.isSafeInteger(seconds*1000)?seconds*1000:this.maxMs;
    const sessionMax=this.hasExplicitMax?Math.min(this.maxMs,courseMax):courseMax;
    const id=randomUUID(),max=Math.min(sessionMax,remaining),prefs:ClassroomPreferences=preferences??saved??{...DEFAULT_CLASSROOM_PREFERENCES};
    const teacher=await resolvePublishedTeacher(db);
    if(teacher&&!teacher.routes[prefs.provider])fail('VOICE_UNAVAILABLE','当前教师未启用所选服务，请选择可用的服务。',503);
    await db.query(`INSERT INTO teeko_classrooms(id,account_id,course_id,course_version,profile,preferences,status,max_ms,limit_reason,started_at,day_key,teacher_config) VALUES($1,$2,$3,$4,$5,$6,'preflight',$7,$8,$9,$10,$11)`,[id,accountId,courseId,selected.version,JSON.stringify({name:profile.name,ageRange:profile.age_range,level:profile.level}),JSON.stringify(prefs),max,max<sessionMax?'daily_limit':'time_limit',this.now(),day(this.now()),teacher?JSON.stringify(teacher):null]);
    await db.query('INSERT INTO teeko_classroom_note_state(classroom_id,captured_from_start) VALUES($1,true)',[id]);
    const previous=(await db.query('SELECT step_index,helped_steps,end_reason FROM teeko_classrooms WHERE account_id=$1 AND course_id=$2 AND course_version=$3 AND id<>$4 ORDER BY recorded_at DESC LIMIT 1',[accountId,courseId,selected.version,id])).rows[0];
    if(!isTopicCourse(selected.manifest)&&previous&&previous.end_reason!=='content_completed')await db.query('UPDATE teeko_classrooms SET step_index=$2,helped_steps=$3 WHERE id=$1',[id,previous.step_index,JSON.stringify(previous.helped_steps)]);
    const created=await this.row(db,accountId,id);await this.note(db,created,{eventKey:'classroom-created',kind:'connection',actor:'application',status:'recorded',name:'classroom_created',details:{state:'preflight'}});return this.snapshot(db,created);
  });}
  async notes(accountId:string,id:string,input:unknown={}):Promise<Omit<ClassroomNotesPage,'ok'>>{
    const parsed=parseClassroomNotesQuery(input);if(!parsed.ok)throw new ClassroomError('INVALID_INPUT','请求内容无效，请重新操作。',400);
    const {pageSize,cursor}=parsed.query;
    return this.tx(accountId,async db=>{
      const row=await this.row(db,accountId,id);if(row.status!=='ended')fail('NOT_READY','课堂结束后可以查看表达记录。');
      const course=await this.course(db,row);
      const owner:ClassroomNoteOwner={id:row.id,course,connectionEpoch:row.connection_epoch,startedAt:row.started_at.toISOString(),endedAt:row.ended_at?.toISOString()??null};
      const job=(await db.query('SELECT status,result FROM teeko_classroom_note_jobs WHERE classroom_id=$1',[id])).rows[0];
      const finished=job?.status==='succeeded'?parseClassroomNoteManifest(owner,row.revision,job.result):null;
      if(finished)return{...pageClassroomNoteManifest(finished,parsed.query),preparation:'ready'};
      const preparation=job&&['pending','running'].includes(job.status)?'pending' as const:'unavailable' as const;
      if((await db.query('SELECT 1 FROM teeko_classroom_note_records WHERE classroom_id=$1 LIMIT 1',[id])).rowCount){
        const manifest=await buildClassroomNoteManifest(db,owner,row.revision);return{...pageClassroomNoteManifest(manifest,parsed.query),preparation};
      }
      type Source={epoch:number;itemId:string;stepIndex:number;transcriptText:string;transcriptSource:string;transcriptAt:Date;contextKey:string;decisionAt:Date;cursorAt:string;decision:unknown};
      const result=await db.query<Source>(`SELECT d.connection_epoch AS epoch,d.item_id AS "itemId",d.context_key AS "contextKey",d.decision,d.created_at AS "decisionAt",to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt",t.step_index AS "stepIndex",t.text AS "transcriptText",t.source AS "transcriptSource",t.created_at AS "transcriptAt"
        FROM teeko_teaching_decisions d JOIN teeko_classroom_transcripts t ON t.classroom_id=d.classroom_id AND t.connection_epoch=d.connection_epoch AND t.item_id=d.item_id AND t.role='child'
        WHERE d.classroom_id=$1 AND d.decision->>'confidence'='high' AND d.decision->>'nextAction'='model' AND length(d.decision->>'suggestedResponse') BETWEEN 1 AND 180
          AND d.context_key=d.classroom_id::text||':'||d.connection_epoch::text||':'||t.step_index::text
          AND ($2::timestamptz IS NULL OR (d.created_at,d.connection_epoch,d.item_id COLLATE "C")<($2::timestamptz,$3::integer,$4::text COLLATE "C"))
        ORDER BY d.created_at DESC,d.connection_epoch DESC,d.item_id COLLATE "C" DESC LIMIT $5`,[id,cursor?.at??null,cursor?.epoch??null,cursor?.itemId??null,pageSize+1]);
      const scanned=result.rows.slice(0,pageSize),entries=scanned.flatMap(value=>{
        if(!(value.transcriptAt instanceof Date)||!(value.decisionAt instanceof Date)||!Number.isFinite(value.transcriptAt.getTime())||!Number.isFinite(value.decisionAt.getTime())||value.transcriptAt<row.started_at||row.ended_at&&value.decisionAt>row.ended_at)return [];
        const note=buildClassroomNote({id:row.id,course,connectionEpoch:row.connection_epoch},{epoch:value.epoch,itemId:value.itemId,stepIndex:value.stepIndex,transcriptText:value.transcriptText,transcriptSource:value.transcriptSource,transcriptAt:value.transcriptAt.toISOString(),contextKey:value.contextKey,decisionAt:value.decisionAt.toISOString(),decision:value.decision});return note?[note]:[];
      });
      const last=scanned.at(-1),nextCursor=result.rows.length>pageSize&&last?encodeClassroomNotesCursor({at:last.cursorAt,epoch:last.epoch,itemId:last.itemId}):null;
      return {classroomId:row.id,courseVersion:`${course.id}:${course.version}`,entries,nextCursor,coverage:'retained_sources',preparation};
    });
  }
  async get(accountId:string,id:string){return this.tx(accountId,async db=>{const row=await this.row(db,accountId,id);await this.settle(db,row);await this.save(db,row);return this.snapshot(db,row);});}
  async teacherRuntime(accountId:string,id:string){return this.tx(accountId,async db=>{const row=await this.row(db,accountId,id);return{config:row.teacher_config??null,state:readTeachingState(row.teaching_state,row.profile.level)};});}
  async readChalkCandidate(accountId:string,id:string,epoch:number,token:string,expected:ClassroomSnapshot,signal:AbortSignal):Promise<ClassroomChalkCandidate|null>{
    const provided=captureClassroomToolState(expected);if(signal.aborted||expected.id!==id||expected.connectionEpoch!==epoch||!provided.ok||provided.snapshot.status!=='active')return null;
    let db:PoolClient|undefined,released=false,transaction=false;
    const release=(destroy=false)=>{if(db&&!released){released=true;try{db.release(destroy);}catch{}}},abort=()=>release(true),databaseError=()=>release(true);
    try{
      db=await this.pool.connect();if(signal.aborted)return null;
      signal.addEventListener('abort',abort,{once:true});db.on('error',databaseError);
      await db.query('BEGIN READ ONLY');transaction=true;
      await db.query("SET LOCAL statement_timeout = '200ms'");await db.query("SET LOCAL lock_timeout = '100ms'");
      const row=(await db.query(`SELECT c.*,k.manifest AS chalk_course,d.decision AS chalk_decision,t.created_at AS chalk_transcript_at,d.created_at AS chalk_decision_at
        FROM teeko_classrooms c JOIN teeko_accounts a ON a.id=c.account_id JOIN teeko_courses k ON k.id=c.course_id AND k.version=c.course_version
        JOIN teeko_teaching_decisions d ON d.classroom_id=c.id AND d.connection_epoch=c.connection_epoch AND d.item_id=c.teaching_state->'latestInput'->>'itemId' AND d.context_key=c.id::text||':'||c.connection_epoch::text||':'||c.step_index::text
        JOIN teeko_classroom_transcripts t ON t.classroom_id=d.classroom_id AND t.connection_epoch=d.connection_epoch AND t.item_id=d.item_id AND t.role='child' AND t.step_index=c.step_index AND t.consumed=false
        WHERE c.id=$1 AND c.account_id=$2 AND c.connection_epoch=$3 AND c.owner_token::text=$4 AND c.status='active'`,[id,accountId,epoch,token])).rows[0] as (Row&{chalk_course:PublishedCourse;chalk_decision:unknown;chalk_transcript_at:Date;chalk_decision_at:Date})|undefined;
      await db.query('COMMIT');transaction=false;
      if(signal.aborted||!row)return null;
      const now=this.now(),course=row.chalk_course,captured=captureClassroomToolState({id:row.id,course,status:row.status,revision:row.revision,connectionEpoch:row.connection_epoch,stepIndex:row.step_index});
      if(!row.lease_until||row.lease_until<=now||!row.teacher_config?.routes[row.preferences.provider]?.reasoning||!captured.ok||!validateClassroomContext(captured.snapshot,provided.snapshot.context).accepted)return null;
      const step=course.steps[row.step_index],teaching=readTeachingState(row.teaching_state,row.profile.level),latest=teaching.latestInput,key=`${id}:${epoch}:${row.step_index}`;
      if(step?.kind!=='speak'||!latest||latest.epoch!==epoch||latest.contextKey!==key||![row.chalk_transcript_at,row.chalk_decision_at].every(at=>at instanceof Date&&Number.isFinite(at.getTime())&&at.getTime()>now.getTime()-60000&&at<=now))return null;
      return buildClassroomChalkCandidate({context:captured.snapshot.context,evidenceItemId:latest.itemId,decision:row.chalk_decision,hints:teaching.hints[step.id]??0});
    }catch(error){if(signal.aborted)return null;throw error;}
    finally{if(db&&!released&&transaction){try{await db.query('ROLLBACK');}catch{release(true);}}signal.removeEventListener('abort',abort);db?.off('error',databaseError);release();}
  }
  private cancelAssessment(id:string){const previous=this.assessments.get(id);if(previous){clearTimeout(previous.expires);previous.controller.abort();this.assessments.delete(id);}}
  private async recentChildEvidence(db:PoolClient,row:Row):Promise<ChildEvidence|undefined>{
    return (await db.query<ChildEvidence>("SELECT item_id,text,created_at,source FROM teeko_classroom_transcripts WHERE classroom_id=$1 AND connection_epoch=$2 AND role='child' AND step_index=$3 AND consumed=false AND created_at>$4 ORDER BY (item_id=$5) DESC,created_at DESC LIMIT 1",[row.id,row.connection_epoch,row.step_index,new Date(this.now().getTime()-60000),readTeachingState(row.teaching_state,row.profile.level).latestInput?.itemId??''])).rows[0];
  }
  private async highlightIntent(db:PoolClient,row:Row,course:PublishedCourse,recent:ChildEvidence):Promise<HighlightIntent|null>{
    const latest=readTeachingState(row.teaching_state,row.profile.level).latestInput;
    if(latest?.epoch!==row.connection_epoch||latest.itemId!==recent.item_id||latest.contextKey!==`${row.id}:${row.connection_epoch}:${row.step_index}`)return null;
    const objects=course.pages.find(page=>page.id===course.steps[row.step_index]?.pageId)?.objects??[];
    const complete=requestedClassroomHighlights(recent.text,objects);
    if(complete)return{type:'highlight',objectIds:complete,itemIds:[recent.item_id]};
    if(isIncompleteClassroomHighlight(recent.text))return{type:'clarify'};
    const age=this.now().getTime()-recent.created_at.getTime(),explicit=isExplicitHighlightTargetFragment(recent.text);
    if(recent.source!=='speech'||age<0||age>HIGHLIGHT_FRAGMENT_MS||!explicit&&!classroomHighlightTargetFragment(recent.text,objects))return null;
    // Look at the immediately preceding input, even if consumed, typed or on another activity.
    const [prior,older]=(await db.query<ChildEvidence&{step_index:number;consumed:boolean;point_between:boolean}>(`SELECT t.item_id,t.text,t.created_at,t.source,t.step_index,t.consumed,EXISTS (
      SELECT 1 FROM teeko_classroom_journal j WHERE j.classroom_id=t.classroom_id AND j.connection_epoch=t.connection_epoch
      AND j.name='point' AND j.kind='interaction' AND j.created_at>=t.created_at AND j.created_at<=$4
    ) as point_between FROM teeko_classroom_transcripts t
      WHERE t.classroom_id=$1 AND t.connection_epoch=$2 AND t.role='child' AND t.item_id<>$3 ORDER BY t.created_at DESC LIMIT 2`,
      [row.id,row.connection_epoch,recent.item_id,recent.created_at])).rows;
    if(!prior||prior.consumed||prior.source!=='speech'||prior.step_index!==row.step_index||prior.point_between||!isIncompleteClassroomHighlight(prior.text))return null;
    const gap=recent.created_at.getTime()-prior.created_at.getTime();
    if(gap<=0||gap>HIGHLIGHT_FRAGMENT_MS||older?.created_at.getTime()===prior.created_at.getTime())return null;
    const ids=requestedClassroomSplitHighlights(prior.text,recent.text,objects);
    return ids?{type:'highlight',objectIds:ids,itemIds:[prior.item_id,recent.item_id]}:explicit?{type:'clarify'}:null;
  }
  private async assessAnswer(accountId:string,id:string,epoch:number,token:string,name:string,args:unknown,audit?:ToolAudit):Promise<Assessed|null>{
    if(!this.assess||!['submit_spoken_answer','delegate'].includes(name))return null;
    const data=args&&typeof args==='object'?args as Record<string,unknown>:{};
    const captured=await this.tx(accountId,async db=>{
      const row=await this.row(db,accountId,id);await this.settle(db,row);await this.save(db,row);
      if(row.status!=='active'||row.connection_epoch!==epoch||row.owner_token!==token||data.contextKey!==`${id}:${epoch}:${row.step_index}`||!row.teacher_config?.routes[row.preferences.provider]?.reasoning)return null;
      const course=await this.course(db,row),step=course.steps[row.step_index];if(step?.kind!=='speak')return null;
      if(audit?.request!==undefined&&!boundExecutionRequest({id:row.id,course,status:row.status,revision:row.revision,connectionEpoch:row.connection_epoch,stepIndex:row.step_index},name,args,audit))return null;
      const recent=await this.recentChildEvidence(db,row);
      if(!recent||(data.evidenceItemId&&data.evidenceItemId!==recent.item_id)||classroomControl(recent.text)||requestedClassroomReview(recent.text)||await this.highlightIntent(db,row,course,recent)||isReadingStep(step)&&(isReadingRecital(step,recent.text)||isReadingSupportRequest(recent.text)||readingNavigation(recent.text)!==null))return null;
      const contextKey=`${id}:${epoch}:${row.step_index}`;
      const saved=(await db.query('SELECT decision FROM teeko_teaching_decisions WHERE classroom_id=$1 AND connection_epoch=$2 AND item_id=$3',[id,epoch,recent.item_id])).rows[0];
      return{itemId:recent.item_id as string,contextKey,createdAt:recent.created_at as Date,text:recent.text as string,config:row.teacher_config,teachingState:readTeachingState(row.teaching_state,row.profile.level),snapshot:await this.snapshot(db,row),saved:saved?teacherAssessmentResultSchema.parse(saved.decision):null};
    });
    if(!captured)return null;
    if(captured.saved)return{itemId:captured.itemId,contextKey:captured.contextKey,createdAt:captured.createdAt,result:captured.saved};
    const previous=this.assessments.get(id);
    if(previous?.itemId===captured.itemId&&previous.contextKey===captured.contextKey)return previous.promise;
    this.cancelAssessment(id);if(this.assessments.size>=128)return null;
    const controller=new AbortController();
    const spanId=randomUUID(),traceAt=performance.now();
    const trace=(phase:'model_started'|'model_completed',status:'recorded'|'failed')=>this.journal(accountId,id,epoch,token,{eventKey:`assessment:${spanId}:${phase}`,kind:'interaction',actor:'application',status,name:'assessment_phase',correlationId:captured.itemId,details:{source:'application',contextKey:captured.contextKey,spanId,phase,clock:'server',elapsedMs:Math.min(86400000,Math.max(0,Math.round(performance.now()-traceAt))),...(status==='failed'?{errorCode:'assessment_unavailable'}:{})}}).catch(()=>false);
    const traceStarted=trace('model_started','recorded');
    const promise=(async()=>{
      let completed=false;
      let rejectAbort:()=>void=()=>{};
      const cancelled=new Promise<never>((_resolve,reject)=>{rejectAbort=()=>reject(new Error('Assessment cancelled.'));});
      controller.signal.addEventListener('abort',rejectAbort,{once:true});const timeout=setTimeout(()=>controller.abort(),8000);
      try{
        const result=teacherAssessmentResultSchema.parse(await Promise.race([this.assess!({snapshot:captured.snapshot,config:captured.config,text:captured.text,teachingState:captured.teachingState},controller.signal),cancelled]));
        if(controller.signal.aborted)return null;
        completed=true;
        return{itemId:captured.itemId,contextKey:captured.contextKey,createdAt:captured.createdAt,result};
      }catch{return null;}
      finally{clearTimeout(timeout);controller.signal.removeEventListener('abort',rejectAbort);const elapsed=Math.min(86400000,Math.max(0,Math.round(performance.now()-traceAt)));void traceStarted.then(()=>this.journal(accountId,id,epoch,token,{eventKey:`assessment:${spanId}:model_completed`,kind:'interaction',actor:'application',status:completed?'recorded':'failed',name:'assessment_phase',correlationId:captured.itemId,details:{source:'application',contextKey:captured.contextKey,spanId,phase:'model_completed',clock:'server',elapsedMs:elapsed,...(!completed?{errorCode:controller.signal.aborted?'assessment_cancelled':'assessment_unavailable'}:{})}})).catch(()=>{});}
    })();
    const expires=setTimeout(()=>{if(this.assessments.get(id)?.controller===controller)this.cancelAssessment(id);},60000);expires.unref?.();
    this.assessments.set(id,{itemId:captured.itemId,contextKey:captured.contextKey,controller,promise,expires});
    return promise;
  }
  async claim(accountId:string,id:string){return this.tx(accountId,async db=>{
    const row=await this.row(db,accountId,id);await this.settle(db,row);
    if(row.status==='ended')fail('ENDED','这节课堂已经结束。');
    if(row.owner_token&&row.lease_until&&row.lease_until>this.now())fail('CONNECTION_EXISTS','这节课堂已在另一个窗口连接。');
    const used=Number((await db.query('SELECT milliseconds FROM teeko_classroom_usage WHERE account_id=$1 AND day_key=$2',[accountId,day(this.now())])).rows[0]?.milliseconds??0);
    if(used>=this.dailyMs)fail('DAILY_LIMIT','今天的试上课时长已用完，明天再来。');
    const available=Number(row.elapsed_ms)+this.dailyMs-used;
    if(available<Number(row.max_ms)){row.max_ms=available;row.limit_reason='daily_limit';}
    row.status='active';row.connection_epoch++;row.revision++;row.owner_token=randomUUID();row.active_since=this.now();row.lease_until=new Date(this.now().getTime()+15_000);
    const course=await this.course(db,row);
    await this.note(db,row,{eventKey:`connection:${row.connection_epoch}`,kind:'connection',actor:'application',status:'recorded',name:'connection_started',details:{state:'active'}});
    await this.markPlannedTopicObject(db,row,course);
    await this.save(db,row);return {snapshot:await this.snapshot(db,row,course),epoch:row.connection_epoch,ownerToken:row.owner_token};
  });}
  async heartbeat(accountId:string,id:string,epoch:number,ownerToken:string){return this.tx(accountId,async db=>{
    const row=await this.row(db,accountId,id);await this.settle(db,row);
    if(row.status!=='active'||row.connection_epoch!==epoch||row.owner_token!==ownerToken){await this.save(db,row);return null;}
    row.lease_until=new Date(this.now().getTime()+15_000);await this.save(db,row);return this.snapshot(db,row);
  });}
  async release(accountId:string,id:string,epoch:number,ownerToken:string){return this.tx(accountId,async db=>{
    const row=await this.row(db,accountId,id);if(row.connection_epoch!==epoch||row.owner_token!==ownerToken)return;this.cancelAssessment(id);
    await this.settle(db,row);if(row.status==='active'){row.status='paused';row.revision++;row.active_since=null;row.owner_token=null;row.lease_until=null;}await this.save(db,row);await this.note(db,row,{eventKey:`release:${epoch}`,kind:'connection',actor:'application',status:'recorded',name:'connection_released',details:{state:row.status}});
  });}
  async providerStarted(accountId:string,id:string,epoch:number,ownerToken:string,sessionId:string){return this.tx(accountId,async db=>{
    const row=await this.row(db,accountId,id);await this.settle(db,row);
    if(row.status!=='active'||row.connection_epoch!==epoch||row.owner_token!==ownerToken)fail('STALE','连接已过期。');
    if(!sessionId||sessionId.length>300)fail('PROVIDER_SESSION','上游没有返回有效会话。',502);
    await db.query('UPDATE teeko_classrooms SET provider_session_id=$2 WHERE id=$1',[id,sessionId]);await this.save(db,row);await this.note(db,row,{eventKey:`provider-ready:${epoch}`,kind:'connection',actor:'provider',status:'confirmed',name:'provider_ready'});
  });}
  private feedback(row:Row,kind:ClassroomFeedback['kind'],message:string){row.feedback={id:randomUUID(),kind,message};}
  private advance(row:Row,course:PublishedCourse,status:ClassroomOutcome['status']){
    const step=course.steps[row.step_index];row.outcomes.push({stepId:step.id,status});row.step_index++;row.teacher_object_ids=[];
    if(row.step_index>=course.steps.length)this.finish(row,'content_completed');
  }
  async action(accountId:string,id:string,action:ClassroomAction){return this.tx(accountId,async db=>{
    const row=await this.row(db,accountId,id);await this.settle(db,row);
    const duplicate=await db.query('SELECT 1 FROM teeko_classroom_actions WHERE classroom_id=$1 AND event_id=$2',[id,action.eventId]);
    if(duplicate.rowCount){await this.save(db,row);return this.snapshot(db,row);}
    if(row.revision!==action.expectedRevision)fail('STALE','课堂状态已更新，请重试。');
    if(row.status==='ended'){if(action.type==='end')return this.snapshot(db,row);fail('ENDED','这节课堂已经结束。');}
    this.cancelAssessment(id);
    const course=await this.course(db,row),step=course.steps[row.step_index],actionStep=row.step_index,previousFeedback=row.feedback?.id;
    if(isTopicCourse(course)&&action.type==='select')fail('ACTION_UNAVAILABLE','这个主题通过语音交流，请直接告诉老师。');
    if(action.type==='end')this.finish(row,'manual');
    else if(action.type==='pause'){row.status='paused';row.active_since=null;row.owner_token=null;row.lease_until=null;}
    else if(action.type==='resume'){if(row.status!=='paused')fail('STATE','这节课堂没有暂停。');row.status='preflight';}
    else {
      if(row.status!=='active')fail('STATE','请先连接课堂。');
      if(action.type==='hint'){const state=readTeachingState(row.teaching_state,row.profile.level);state.hints[step.id]=Math.min(row.teacher_config?.policy.hintLimit??DEFAULT_TEACHER_POLICY.hintLimit,(state.hints[step.id]??0)+1);row.teaching_state=state;if(!row.helped_steps.includes(step.id))row.helped_steps.push(step.id);row.teacher_object_ids=step.targetId?[step.targetId]:[];this.feedback(row,'hint',step.hint);}
      else if(action.type==='skip'||action.type==='next'){if(action.type==='next'&&isReadingStep(step))row.feedback=null;else this.feedback(row,'skipped','换一个试试。');this.advance(row,course,action.type==='next'&&(step.kind==='listen'||isReadingStep(step))?'unassessed':'skipped');}
      else if(action.type==='select'){
        const selected=captureClassroomSelection({id:row.id,course,status:row.status,revision:row.revision,connectionEpoch:row.connection_epoch,stepIndex:row.step_index},this.now().getTime(),action);
        const ids=selected.accepted&&selected.event.type==='selection.committed'?selected.event.payload.objectIds:[];
        if(step.kind!=='select'||ids.length!==1||!course.pages.find(x=>x.id===step.pageId)?.objects.some(x=>x.id===ids[0]))this.feedback(row,'ambiguous','请只选一个图案。');
        else if(ids[0]!==step.targetId){if(!row.helped_steps.includes(step.id))row.helped_steps.push(step.id);this.feedback(row,'retry','再看看，'+step.hint);}
        else{this.feedback(row,'correct','找到了！');this.advance(row,course,row.helped_steps.includes(step.id)?'assisted':'independent');}
      }
    }
    row.revision++;
    if(row.step_index!==actionStep)await this.markPlannedTopicObject(db,row,course);
    await this.save(db,row);await db.query('INSERT INTO teeko_classroom_actions(classroom_id,event_id) VALUES($1,$2)',[id,action.eventId]);
    await this.note(db,row,{eventKey:`action:${action.eventId}`,kind:'interaction',actor:'child',status:'confirmed',name:action.type,correlationId:action.eventId,details:{action:action.type,...(action.objectIds?{objectIds:action.objectIds}:{}),...(row.feedback&&row.feedback.id!==previousFeedback?{feedbackKind:row.feedback.kind}:{}),...(row.end_reason?{endReason:row.end_reason}:{}),state:row.status}},actionStep);return this.snapshot(db,row);
  });}
  async point(accountId:string,id:string,epoch:number,token:string,request:ClassroomPointRequest,authorize?:()=>Promise<boolean>):Promise<{accepted:boolean;snapshot:ClassroomSnapshot}>{return this.tx(accountId,async db=>{
    const row=await this.row(db,accountId,id);await this.settle(db,row);
    const denied=async()=>{await this.settle(db,row);await this.save(db,row);return {accepted:false,snapshot:await this.snapshot(db,row)};};
    const snapshot=await this.snapshot(db,row);
    if(isTopicCourse(snapshot.course))return denied();
    const authorized=async()=>{try{return !authorize||await authorize();}catch{return false;}};
    if(!await authorized())return denied();
    const captured=captureClassroomPoint(snapshot,request);
    if(!captured.accepted||row.connection_epoch!==epoch||row.owner_token!==token)return denied();
    const duplicate=await db.query('SELECT 1 FROM teeko_classroom_actions WHERE classroom_id=$1 AND event_id=$2',[id,captured.request.eventId]);
    if(duplicate.rowCount)return denied();
    await this.settle(db,row);
    const quotaDay=day(this.now()),used=Number((await db.query('SELECT milliseconds FROM teeko_classroom_usage WHERE account_id=$1 AND day_key=$2',[accountId,quotaDay])).rows[0]?.milliseconds??0);
    const current=await this.snapshot(db,row);
    // The socket's current-input guard is part of this last authorization check.
    // New speech received during earlier database/authorization waits wins over the old point.
    if(!await authorized()||row.status!=='active'||row.connection_epoch!==epoch||row.owner_token!==token||!row.active_since||!row.lease_until||row.lease_until<=this.now()||Number(row.elapsed_ms)>=Number(row.max_ms)||used>=this.dailyMs||quotaDay!==day(this.now())||!captureClassroomPoint(current,captured.request).accepted)return denied();
    this.cancelAssessment(id);
    const teaching=readTeachingState(row.teaching_state,row.profile.level);delete teaching.latestInput;row.teaching_state=teaching;
    row.revision++;await this.save(db,row);
    await db.query('INSERT INTO teeko_classroom_actions(classroom_id,event_id) VALUES($1,$2)',[id,captured.request.eventId]);
    await this.note(db,row,{eventKey:`point:${captured.request.eventId}`,kind:'interaction',actor:'child',status:'recorded',name:'point',correlationId:captured.request.eventId,details:{action:'point',objectIds:[captured.object.id],source:'client',contextKey:`${id}:${epoch}:${row.step_index}`}});
    return {accepted:true,snapshot:await this.snapshot(db,row)};
  });}
  async transcript(accountId:string,id:string,epoch:number,token:string,event:Transcript){
    if(!event.final||!event.text.trim())return;
    return this.tx(accountId,async db=>{
      const row=await this.row(db,accountId,id);await this.settle(db,row);
      if(row.status!=='active'||row.connection_epoch!==epoch||row.owner_token!==token||event.contextKey!==`${id}:${epoch}:${row.step_index}`){await this.save(db,row);return;}
      const itemId=(event.itemId??randomUUID()).slice(0,200);
      const inserted=await db.query('INSERT INTO teeko_classroom_transcripts(classroom_id,connection_epoch,item_id,role,text,step_index,created_at,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING item_id',[id,epoch,itemId,event.role,event.text.slice(0,1000),row.step_index,this.now(),event.source??'speech']);
      if(inserted.rowCount&&event.role==='child'){const pending=this.assessments.get(id);if(pending&&pending.itemId!==itemId&&pending.contextKey===event.contextKey)this.cancelAssessment(id);const teaching=readTeachingState(row.teaching_state,row.profile.level);teaching.latestInput={epoch,itemId,contextKey:event.contextKey};row.teaching_state=teaching;}
      if(inserted.rowCount)await this.note(db,row,{eventKey:journalKey('utterance',`${epoch}:${itemId}:${event.role}`),kind:'utterance',actor:event.role,status:'recorded',name:'transcript',text:event.text,correlationId:itemId,details:{source:event.source??'speech',...(event.source==='typed'?{}:{boundary:row.preferences.provider==='openai'?'application_segment' as const:'provider_final' as const}),...(event.role==='teacher'?{playback:'generated' as const}:{})}});
      await db.query('DELETE FROM teeko_classroom_transcripts WHERE classroom_id=$1 AND (connection_epoch,item_id,role) NOT IN (SELECT connection_epoch,item_id,role FROM teeko_classroom_transcripts WHERE classroom_id=$1 ORDER BY created_at DESC LIMIT 64)',[id]);
      await this.save(db,row);
    });
  }
  /** Vendor tool adherence is optional; only completed, task-bound evidence can progress. */
  async receiveTranscript(accountId:string,id:string,epoch:number,token:string,event:Transcript,authorize?:()=>Promise<boolean>){
    const itemId=event.itemId??randomUUID();
    await this.transcript(accountId,id,epoch,token,{...event,itemId});
    if(event.role!=='child'||!event.final||!event.contextKey)return;
    const state=await this.get(accountId,id),step=state.course.steps[state.stepIndex];
    const control=(isReadingStep(step)?readingNavigation(event.text):null)??classroomControl(event.text);
    if(control){
      if((control==='skip'||control==='next')&&isOpenClassroomConversation(step))return;
      if(state.status==='active'&&state.connectionEpoch===epoch&&event.contextKey===`${id}:${epoch}:${state.stepIndex}`){
        const after=await this.action(accountId,id,{eventId:randomUUID(),expectedRevision:state.revision,type:control});
        if(after.status!==state.status||after.stepIndex!==state.stepIndex)return 'navigation' as const;
      }
      return;
    }
    if(requestedClassroomReview(event.text))return;
    const current=step&&state.status==='active'&&state.connectionEpoch===epoch&&event.contextKey===`${id}:${epoch}:${state.stepIndex}`;
    let highlights=current?requestedHighlights(event.text,state.course,step.pageId):null;
    if(current&&!highlights){
      if(isIncompleteClassroomHighlight(event.text))return;
      const objects=state.course.pages.find(page=>page.id===step.pageId)?.objects??[];
      if(event.source!=='typed'&&(isExplicitHighlightTargetFragment(event.text)||classroomHighlightTargetFragment(event.text,objects))){
        const intent=await this.tx(accountId,async db=>{
          const row=await this.row(db,accountId,id);
          if(row.status!=='active'||row.connection_epoch!==epoch||row.owner_token!==token||event.contextKey!==`${id}:${epoch}:${row.step_index}`)return null;
          const recent=await this.recentChildEvidence(db,row);
          return recent?.item_id===itemId?this.highlightIntent(db,row,state.course,recent):null;
        });
        if(intent?.type==='clarify')return;
        if(intent?.type==='highlight')highlights=intent.objectIds;
      }
    }
    if(highlights){await this.tool(accountId,id,epoch,token,'highlight_objects',{contextKey:event.contextKey,objectIds:highlights,evidenceItemId:itemId},authorize,{actor:'application',callId:itemId});return;}
    await this.tool(accountId,id,epoch,token,'submit_spoken_answer',{contextKey:event.contextKey,answer:event.text,evidenceItemId:itemId},authorize,{actor:'application',callId:itemId});
  }

  /** The Responses backend can demonstrate this published object without submitting a learner answer. */
  async applyGptRobotHighlight(
    accountId:string,id:string,epoch:number,token:string,scope:ClassroomSnapshot,callId:string,objectId:string,
    authorize?:()=>Promise<boolean>,isCurrent:()=>boolean=()=>true,
  ):Promise<boolean>{
    if(objectId!=='wings'||!/^[a-zA-Z0-9_-]{1,200}$/.test(callId))return false;
    const provided=captureClassroomToolState(scope);
    if(!provided.ok||scope.id!==id||scope.connectionEpoch!==epoch||scope.status!=='active')return false;
    // Session authorization can do I/O. Acquire the classroom lock only after it resolves.
    try{if(!isCurrent()||authorize&&!await authorize())return false;}catch{return false;}
    const invalidated=new Error('Robot highlight was superseded');
    const correlationId=createHash('sha256').update(`${epoch}:${callId}`).digest('hex');
    try{return await this.tx(accountId,async db=>{
      const row=await this.row(db,accountId,id);
      const active=()=>row.status==='active'&&row.connection_epoch===epoch&&row.owner_token===token&&
        !!row.active_since&&!!row.lease_until&&row.lease_until>this.now();
      if(!active()||row.preferences.provider!=='openai'||row.course_id!=='topic-robot')return false;
      const course=await this.course(db,row);
      if(!canHighlightRobotWings(course,row.step_index))return false;
      const state=captureClassroomToolState({id,course,status:row.status,revision:row.revision,connectionEpoch:epoch,stepIndex:row.step_index});
      if(!state.ok||!validateClassroomContext(state.snapshot,provided.snapshot.context).accepted||!isCurrent())return false;
      const confirmedKey=`gpt-robot-highlight-confirmed:${correlationId}`;
      const duplicate=await db.query('SELECT 1 FROM teeko_classroom_journal WHERE classroom_id=$1 AND event_key=$2',[id,confirmedKey]);
      if(!active()||!isCurrent())return false;
      if(duplicate.rowCount)return row.teacher_object_ids.includes(objectId);
      await this.settle(db,row);
      if(!active()||row.teacher_object_ids.includes(objectId)){
        await this.save(db,row);
        return active()&&isCurrent();
      }
      const details={source:'model' as const,contextKey:`${id}:${epoch}:${row.step_index}`,objectIds:[objectId]};
      const entry={kind:'tool' as const,actor:'teacher' as const,name:'highlight_objects',correlationId};
      await this.note(db,row,{...entry,eventKey:`gpt-robot-highlight-requested:${correlationId}`,status:'requested',details});
      if(!active()||!isCurrent())throw invalidated;
      row.teacher_object_ids=[...row.teacher_object_ids,objectId];
      row.revision++;
      await this.save(db,row);
      await this.note(db,row,{...entry,eventKey:confirmedKey,status:'confirmed',details:{...details,highlighted:[objectId],resultStatus:'confirmed'}});
      if(!active()||!isCurrent())throw invalidated;
      return true;
    });}catch(error){
      if(error===invalidated||error instanceof ClassroomError&&['UNAUTHORIZED','NOT_FOUND'].includes(error.code))return false;
      throw error;
    }
  }

  async tool(accountId:string,id:string,epoch:number,token:string,name:string,args:unknown,authorize?:()=>Promise<boolean>,audit:ToolAudit={actor:'application'}):Promise<{output:ToolOutput;snapshot:ClassroomSnapshot;execution?:ClassroomToolAdvance;chalk?:ClassroomChalkCandidate}>{
    const requestedName=['highlight_objects','inspect_current_page','submit_spoken_answer','delegate','skip','chalk_write','review_lesson_notes'].includes(name)?name:'unsupported_tool';
    const journalActor=requestedName==='chalk_write'&&audit.request?.source==='application'?'application':audit.actor;
    const correlationId=typeof audit.callId==='string'?(audit.callId.length<=200?audit.callId:createHash('sha256').update(audit.callId).digest('hex')):randomUUID();
    const details=toolJournalDetails(args),key=journalKey('tool',`${epoch}:${audit.actor}:${correlationId}`);
    const requestAuthorized=!authorize||await authorize();
    if(requestAuthorized)await this.journal(accountId,id,epoch,token,{eventKey:`${key}:request`,kind:'tool',actor:journalActor,status:'requested',name:requestedName,correlationId,details:{...details,contextKey:undefined,source:journalActor==='teacher'?'model':'application'}});
    try{
    const assessmentAuthorized=requestAuthorized&&(!authorize||await authorize());
    const semantic=assessmentAuthorized?await this.assessAnswer(accountId,id,epoch,token,name,args,audit):null;
    const authorized=assessmentAuthorized&&(!authorize||await authorize());
    return await this.tx(accountId,async db=>{
    const row=await this.row(db,accountId,id);await this.settle(db,row);
    const toolStep=row.step_index;
    let scopedRequest:ClassroomToolRequest|null=null;
    const complete=async(output:ToolOutput)=>{
      if(!(requestedName==='inspect_current_page'&&audit.actor==='teacher'))await this.note(db,row,{eventKey:`${key}:result`,kind:'tool',actor:journalActor,status:['confirmed','conversation','reference'].includes(output.status)?'confirmed':'rejected',name:requestedName,correlationId,details:{...details,source:journalActor==='teacher'?'model':'application',effectiveTool:name,resultStatus:output.status,...(output.highlighted?{highlighted:[...output.highlighted]}:{}),...(output.english&&name!=='review_lesson_notes'?{message:output.english.slice(0,1000)}:{})}},toolStep);
      const snapshot=await this.snapshot(db,row),after=captureClassroomToolState(snapshot),original=scopedRequest;
      const execution:ClassroomToolAdvance|undefined=original&&['submit_spoken_answer','delegate'].includes(original.command.name)&&output.status==='confirmed'&&row.step_index===toolStep+1&&after.ok&&row.outcomes.some(outcome=>outcome.stepId===original.context.activityId&&((original.command.name==='delegate'?['independent','assisted','skipped']:['independent','assisted']).includes(outcome.status)||isReadingStep(snapshot.course.steps[toolStep])&&outcome.status==='unassessed'))
        ?{type:'tool.advance',requestId:original.id,callId:original.callId,before:original.context,after:after.snapshot.context}:undefined;
      const teaching=readTeachingState(row.teaching_state,row.profile.level);
      const chalk=original?.command.name==='delegate'&&output.status==='retry'&&semantic&&semantic.itemId===original.command.arguments.evidenceItemId&&teaching.latestInput?.itemId===semantic.itemId&&teaching.latestInput.epoch===epoch&&teaching.latestInput.contextKey===semantic.contextKey&&after.ok&&row.step_index===toolStep
        ?buildClassroomChalkCandidate({context:after.snapshot.context,evidenceItemId:semantic.itemId,decision:semantic.result,hints:teaching.hints[after.snapshot.context.activityId]??0}):null;
      return{output,snapshot,...(execution?{execution}:{}),...(chalk?{chalk}:{})};
    };
    if(!authorized||row.status!=='active'||row.connection_epoch!==epoch||row.owner_token!==token){await this.save(db,row);return{output:{status:'unavailable'},snapshot:await this.snapshot(db,row)};}
    const course=await this.course(db,row),step=course.steps[row.step_index],data={...(args&&typeof args==='object'?args:{})} as Record<string,unknown>;
    if(data.contextKey!==`${id}:${epoch}:${row.step_index}`){await this.save(db,row);return complete({status:'retry',english:'That task is obsolete. Use only the newest application task.'});}
    if(audit.request!==undefined){
      scopedRequest=boundExecutionRequest({id:row.id,course,status:row.status,revision:row.revision,connectionEpoch:row.connection_epoch,stepIndex:row.step_index},name,args,audit);
      if(!scopedRequest){
        await this.save(db,row);return complete({status:'unavailable',english:'This classroom tool request is no longer valid for the current classroom. Do not claim it happened.'});
      }
    }
    if(name==='chalk_write'){
      await this.save(db,row);
      let valid=!!scopedRequest;
      if(scopedRequest?.source==='application'){
        const teaching=readTeachingState(row.teaching_state,row.profile.level),latest=teaching.latestInput;
        const saved=(await db.query(`SELECT d.decision FROM teeko_teaching_decisions d JOIN teeko_classroom_transcripts t ON t.classroom_id=d.classroom_id AND t.connection_epoch=d.connection_epoch AND t.item_id=d.item_id AND t.role='child'
          WHERE d.classroom_id=$1 AND d.connection_epoch=$2 AND d.item_id=$3 AND d.context_key=$4 AND t.step_index=$5 AND t.consumed=false AND t.created_at>$6 AND t.created_at<=$7`,[id,epoch,data.evidenceItemId,data.contextKey,row.step_index,new Date(this.now().getTime()-60000),this.now()])).rows[0];
        const candidate=buildClassroomChalkCandidate({context:scopedRequest.context,evidenceItemId:data.evidenceItemId,decision:saved?.decision,hints:teaching.hints[step.id]??0});
        valid=!!candidate&&latest?.epoch===epoch&&latest.itemId===candidate.evidenceItemId&&latest.contextKey===data.contextKey&&candidate.text===data.text&&candidate.seconds===data.seconds;
      }
      return complete(valid?{status:'reference',english:'The current display proposal is accepted. It is not yet confirmed visible; wait for the browser display receipt. This is teaching help, not an answer or learning evidence.'}:{status:'unavailable'});
    }
    const recent=await this.recentChildEvidence(db,row);
    const latestInput=readTeachingState(row.teaching_state,row.profile.level).latestInput;
    if(data.evidenceItemId&&(data.evidenceItemId!==recent?.item_id||data.evidenceItemId!==latestInput?.itemId||latestInput.epoch!==epoch||latestInput.contextKey!==data.contextKey)){await this.save(db,row);return complete({status:'unavailable'});}
    const highlight=recent&&(['delegate','submit_spoken_answer'].includes(name)||name==='highlight_objects'&&data.evidenceItemId)?await this.highlightIntent(db,row,course,recent):null;
    let output:ToolOutput={status:'unavailable',english:'That check is unavailable. Continue with the current picture; do not claim to have inspected unknown marks.'};
    if(name==='delegate'){
      const spoken=recent?.text??'';
      if(requestedClassroomReview(spoken)&&recent){name='review_lesson_notes';}
      else if(recent&&(classroomControl(spoken)==='skip'||isReadingStep(step)&&readingNavigation(spoken)!==null)){name='skip';}
      else if(highlight?.type==='highlight'&&(data.evidenceItemId||highlight.itemIds.length===1)){name='highlight_objects';data.objectIds=highlight.objectIds;}
      else if(highlight){output=highlightClarification;}
      else if(step.kind==='speak'&&recent){name='submit_spoken_answer';data.answer=spoken;}
      else output={status:'conversation',english:'This is conversation, not an assessed answer. Respond to what the learner said and follow their interest. Do not demand the current target or infer a request to skip.'};
    }
    if(name==='review_lesson_notes'){
      if(scopedRequest&&recent&&recent.created_at instanceof Date&&recent.created_at<=this.now()&&latestInput&&recent.item_id===latestInput.itemId&&latestInput.epoch===epoch&&latestInput.contextKey===data.contextKey&&requestedClassroomReview(recent.text)){
        const sources=await readClassroomNoteSources(db,{id:row.id,course,connectionEpoch:row.connection_epoch,startedAt:row.started_at.toISOString(),endedAt:null},row.revision,this.now().toISOString());
        output=buildClassroomReviewReference(sources.entries.map(entry=>entry.card),sources.coverage);
        await db.query("UPDATE teeko_classroom_transcripts SET consumed=true WHERE classroom_id=$1 AND connection_epoch=$2 AND item_id=$3 AND role='child'",[id,epoch,recent.item_id]);
      }else output={status:'unavailable',english:'No current explicit learner request for this lesson review is confirmed. Keep listening; do not invent saved sentences or begin a compulsory recap.'};
    }else if(name==='highlight_objects'){
      const ids=Array.isArray(data.objectIds)?data.objectIds.filter((x):x is string=>typeof x==='string'):[];
      const request=data.evidenceItemId&&highlight?.type==='highlight'?highlight.objectIds:null;
      const evidenceMatches=!data.evidenceItemId||!!request&&request.length===ids.length&&ids.every(id=>request.includes(id));
      if(evidenceMatches&&ids.length&&ids.length<=5&&ids.every(x=>course.pages.find(p=>p.id===step.pageId)?.objects.some(o=>o.id===x))){
        if(data.evidenceItemId&&highlight?.type==='highlight')await db.query("UPDATE teeko_classroom_transcripts SET consumed=true WHERE classroom_id=$1 AND connection_epoch=$2 AND item_id=ANY($3::text[]) AND role='child'",[id,epoch,highlight.itemIds]);
        const unchanged=ids.length===row.teacher_object_ids.length&&ids.every(id=>row.teacher_object_ids.includes(id));
        if(!unchanged){row.teacher_object_ids=ids;const state=readTeachingState(row.teaching_state,row.profile.level);state.hints[step.id]=Math.min(row.teacher_config?.policy.hintLimit??DEFAULT_TEACHER_POLICY.hintLimit,(state.hints[step.id]??0)+1);row.teaching_state=state;if(!row.helped_steps.includes(step.id))row.helped_steps.push(step.id);row.revision++;this.feedback(row,'hint','老师标出了图案。');}
        output={status:'confirmed',highlighted:ids,english:unchanged?'The application confirms these objects are already highlighted. Do not draw or count the same help twice.':'The application has drawn the requested highlight. You may refer to it. This is help, not an independently correct answer.'};
      }
    }else if(name==='skip'&&isOpenClassroomConversation(step)){output={status:'conversation',english:'This is already the open conversation. Change topic if the learner wants; they can tap the finish button when ready. Do not hang up or claim the session has ended.'};}
    else if(name==='skip'&&recent&&(classroomControl(recent.text)==='skip'||isReadingStep(step)&&readingNavigation(recent.text)!==null)){const next=isReadingStep(step)&&readingNavigation(recent.text)==='next';if(next)row.feedback=null;this.advance(row,course,next?'unassessed':'skipped');row.revision++;output={status:'confirmed',english:next?'The learner chose the next reading section. Record browsing only, with no correctness or mastery credit.':'The learner chose to skip. Respect the choice and continue with the next objective.'};}
    else if(name==='submit_spoken_answer'&&highlight){output=highlight.type==='clarify'?highlightClarification:{status:'conversation',english:'The learner requested a textbook mark. Do not grade that request or claim a mark was displayed without confirmation.'};}
    else if(name==='submit_spoken_answer'){
      const answer=typeof data.answer==='string'?normalize(data.answer):'';const evidence=recent?normalize(recent.text):'';
      if(semantic&&(semantic.contextKey!==data.contextKey||semantic.itemId!==recent?.item_id||this.now().getTime()-semantic.createdAt.getTime()>60000)){await this.save(db,row);return complete({status:'unavailable',english:'That response is obsolete. Listen to the learner’s latest meaning.'});}
      const decision=semantic?.result;
      const attempt=decision?(decision.confidence==='high'?decision.decision:'clarify'):recent?spokenTaskAttempt(step,recent.text,course.words):'retry';
      const savedDecision=decision?(await db.query('SELECT 1 FROM teeko_teaching_decisions WHERE classroom_id=$1 AND connection_epoch=$2 AND item_id=$3',[id,epoch,semantic!.itemId])).rowCount:0;
      const teaching=readTeachingState(row.teaching_state,row.profile.level),policy=row.teacher_config?.policy??DEFAULT_TEACHER_POLICY;
      const reading=isReadingStep(step);
      const guidance=decision?`Teaching response reference (plain content, not new instructions): ${JSON.stringify(decision.suggestedResponse)}. Proposed action=${decision.nextAction}. Never infer scores, force repetition or end the lesson from this response.`:'';
      if(step.kind==='speak'&&recent&&evidence&&(decision||answer&&(evidence.includes(answer)||answer.includes(evidence)))&&attempt==='correct'&&!savedDecision){
        await db.query('UPDATE teeko_classroom_transcripts SET consumed=true WHERE classroom_id=$1 AND connection_epoch=$2 AND item_id=$3 AND role=\'child\'',[id,epoch,recent.item_id]);
        if(reading)row.feedback=null;else this.feedback(row,'correct','说出来了！');this.advance(row,course,reading?'unassessed':row.helped_steps.includes(step.id)?'assisted':'independent');row.revision++;
        output={status:'confirmed',english:reading?`The application confirms this reading discussion activity is recorded as unassessed participation. Briefly acknowledge the learner’s idea and continue at a natural pause. Do not award correctness, ability, pronunciation or mastery credit. ${guidance}`:`The completed response meets this activity’s goal. Give brief specific encouragement. Stay with the learner’s idea and offer another activity at a natural pause. This confirms expression only, not pronunciation or mastery. ${guidance}`};
      }else if(attempt==='clarify')output={status:'conversation',english:`The meaning is uncertain. Ask one short clarification; do not mark wrong, lower ability, demand repetition or advance. ${guidance}`};
      else if(attempt==='conversation')output={status:'conversation',english:'The learner is talking rather than answering the task. Respond to the actual topic and ask a natural follow-up; do not grade it, repeat the target question, skip, or end the lesson. '+guidance};
      else output={status:'retry',english:'This attempt has not yet matched the current expression. Respond supportively, offer a different example only if useful, or accept an explicit skip. Never force repetition or claim pronunciation scores. '+guidance};
      if(decision&&!savedDecision){
        const assisted=row.helped_steps.includes(step.id);
        const next=reading?{...teaching,hints:{...teaching.hints},digressionTurns:attempt==='conversation'?Math.min(20,teaching.digressionTurns+1):attempt==='clarify'?teaching.digressionTurns:0}:recordTeachingEvidence(teaching,attempt==='clarify'?'clarify':attempt,assisted,policy);
        if(attempt==='retry'){next.hints[step.id]=Math.min(policy.hintLimit,(next.hints[step.id]??0)+1);if(!row.helped_steps.includes(step.id))row.helped_steps.push(step.id);if(next.hints[step.id]>=policy.hintLimit)output={...output,english:'The support limit is reached. Give one natural example, then offer a different activity or learner-chosen skip. Do not ask for another repetition. '+guidance};}
        next.last={contextKey:String(data.contextKey),result:decision};row.teaching_state=next;row.revision++;
        await db.query('INSERT INTO teeko_teaching_decisions(classroom_id,connection_epoch,item_id,context_key,decision,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[id,epoch,semantic!.itemId,String(data.contextKey),JSON.stringify(decision),this.now()]);
        await db.query('DELETE FROM teeko_teaching_decisions WHERE classroom_id=$1 AND (connection_epoch,item_id) NOT IN (SELECT connection_epoch,item_id FROM teeko_teaching_decisions WHERE classroom_id=$1 ORDER BY created_at DESC LIMIT 64)',[id]);
      }
    }
    if(row.step_index!==toolStep)await this.markPlannedTopicObject(db,row,course);
    await this.save(db,row);
    const latest=readTeachingState(row.teaching_state,row.profile.level).latestInput;
    if(semantic&&latest?.epoch===epoch&&latest.itemId===semantic.itemId&&latest.contextKey===semantic.contextKey){
      const saved=(await db.query(`SELECT t.text,t.source,t.step_index,t.created_at AS transcript_at,d.decision,d.created_at AS decision_at FROM teeko_teaching_decisions d JOIN teeko_classroom_transcripts t ON t.classroom_id=d.classroom_id AND t.connection_epoch=d.connection_epoch AND t.item_id=d.item_id AND t.role='child' WHERE d.classroom_id=$1 AND d.connection_epoch=$2 AND d.item_id=$3 AND d.context_key=$4`,[id,epoch,semantic.itemId,semantic.contextKey])).rows[0];
      if(saved)await captureClassroomNote(db,{id:row.id,course,connectionEpoch:row.connection_epoch,startedAt:row.started_at.toISOString(),endedAt:row.ended_at?.toISOString()??null},row.revision,{epoch,itemId:semantic.itemId,stepIndex:saved.step_index,transcriptText:saved.text,transcriptSource:saved.source,transcriptAt:saved.transcript_at.toISOString(),contextKey:semantic.contextKey,decisionAt:saved.decision_at.toISOString(),decision:saved.decision});
    }
    return complete(output);
  });
    }catch(error){
      await this.journal(accountId,id,epoch,token,{eventKey:`${key}:failure`,kind:'tool',actor:journalActor,status:'failed',name:requestedName,correlationId,details:{errorCode:error instanceof ClassroomError?error.code:'UNAVAILABLE'}}).catch(()=>{});
      throw error;
    }
  }
}
