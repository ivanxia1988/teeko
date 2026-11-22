import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import {AdminError} from './admin-service';
import {classroomJournalListQuerySchema,classroomJournalEventsQuerySchema,classroomJournalClassroomSchema,classroomJournalEventSchema,sanitizeClassroomJournalEntry,sanitizeClassroomJournalText,type ClassroomJournalEntry,type ClassroomJournalScope,type ClassroomJournalClassroom,type ClassroomJournalEvent,type ClassroomJournalList,type ClassroomJournalEvents} from '../classroom-journal';

type Database=Pick<PoolClient,'query'>;
const scopeSchema=z.object({classroomId:z.string().uuid(),epoch:z.number().int().nonnegative(),revision:z.number().int().nonnegative(),stepIndex:z.number().int().nonnegative()}).strict();
export async function appendClassroomJournal(db:Database,scope:ClassroomJournalScope,input:ClassroomJournalEntry,now=new Date()):Promise<void>{
 const current=scopeSchema.parse(scope),entry=sanitizeClassroomJournalEntry(input);
 await db.query(`INSERT INTO teeko_classroom_journal(classroom_id,event_key,connection_epoch,revision,step_index,kind,actor,status,name,text,details,correlation_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(classroom_id,event_key) DO NOTHING`,[current.classroomId,entry.eventKey,current.epoch,current.revision,current.stepIndex,entry.kind,entry.actor,entry.status,entry.name,entry.text??null,JSON.stringify(entry.details??{}),entry.correlationId??null,now]);
}

type ClassroomRow={id:string;account_id:string;email:string;child_name:string;course_title:string;provider:string;status:string;started_at:Date;ended_at:Date|null;elapsed_ms:string|number;agent_name:string|null;agent_version:string|null;model:string|null;event_count:string|number};
type EventRow={id:string;created_at:Date;connection_epoch:number;revision:number;step_index:number;kind:ClassroomJournalEvent['kind'];actor:ClassroomJournalEvent['actor'];status:ClassroomJournalEvent['status'];name:string;text:string|null;correlation_id:string|null;details:Record<string,unknown>};
const text=(value:string,max:number)=>sanitizeClassroomJournalText(value,max);
const metadata=`SELECT c.id,c.account_id,a.email,COALESCE(c.profile->>'name','') AS child_name,COALESCE(course.manifest->>'title',c.course_id) AS course_title,c.preferences->>'provider' AS provider,c.status,c.started_at,c.ended_at,c.elapsed_ms,c.teacher_config->>'agentName' AS agent_name,c.teacher_config->>'version' AS agent_version,c.teacher_config #>> ARRAY['routes',c.preferences->>'provider','realtime','model'] AS model,CASE WHEN journal.total>0 THEN journal.total ELSE history.total END AS event_count FROM teeko_classrooms c JOIN teeko_accounts a ON a.id=c.account_id LEFT JOIN teeko_courses course ON course.id=c.course_id AND course.version=c.course_version LEFT JOIN LATERAL(SELECT count(*) total FROM teeko_classroom_journal j WHERE j.classroom_id=c.id) journal ON true LEFT JOIN LATERAL(SELECT count(*) total FROM teeko_classroom_transcripts t WHERE t.classroom_id=c.id) history ON true`;
const classroom=(row:ClassroomRow):ClassroomJournalClassroom=>classroomJournalClassroomSchema.parse({id:row.id,accountId:row.account_id,email:text(row.email,320),childName:text(row.child_name,100),courseTitle:text(row.course_title,200),provider:row.provider,status:row.status,startedAt:row.started_at.toISOString(),endedAt:row.ended_at?.toISOString()??null,elapsedSeconds:Math.max(0,Math.floor(Number(row.elapsed_ms)/1000)),agentName:row.agent_name?text(row.agent_name,100):null,agentVersion:row.agent_version!==null&&Number.isSafeInteger(Number(row.agent_version))&&Number(row.agent_version)>=0?Number(row.agent_version):null,model:row.model?text(row.model,100):null,eventCount:Number(row.event_count)});
const event=(row:EventRow):ClassroomJournalEvent=>{
 const safe=sanitizeClassroomJournalEntry({eventKey:'read',kind:row.kind,actor:row.actor,status:row.status,name:row.name,text:row.text??undefined,correlationId:row.correlation_id??undefined,details:row.details});
 return classroomJournalEventSchema.parse({id:String(row.id),createdAt:row.created_at.toISOString(),epoch:row.connection_epoch,revision:row.revision,stepIndex:row.step_index,kind:safe.kind,actor:safe.actor,status:safe.status,name:safe.name,text:safe.text??null,correlationId:safe.correlationId??null,details:safe.details??{}});
};

export class ClassroomJournalService{
 constructor(private readonly pool:Pool){}
 private async requireAdmin(accountId:string){
  if(!z.string().uuid().safeParse(accountId).success)throw new AdminError('FORBIDDEN','此账号没有管理权限。',403);
  if(!(await this.pool.query('SELECT 1 FROM teeko_admin_accounts WHERE account_id=$1',[accountId])).rowCount)throw new AdminError('FORBIDDEN','此账号没有管理权限。',403);
 }
 async list(accountId:string,input:unknown={}):Promise<ClassroomJournalList>{
  await this.requireAdmin(accountId);const query=classroomJournalListQuerySchema.parse(input),values:unknown[]=[],where=["a.consent_version<>'internal-admin'"];
  if(query.query){values.push(query.query);where.push(`(strpos(lower(a.email),lower($${values.length}))>0 OR strpos(lower(COALESCE(c.profile->>'name','')),lower($${values.length}))>0)`);}
  if(query.from){values.push(new Date(`${query.from}T00:00:00+08:00`));where.push(`c.started_at>=$${values.length}`);}
  if(query.to){values.push(new Date(new Date(`${query.to}T00:00:00+08:00`).getTime()+86400000));where.push(`c.started_at<$${values.length}`);}
  const clause=`WHERE ${where.join(' AND ')}`;
  const count=await this.pool.query(`SELECT count(*)::int total FROM teeko_classrooms c JOIN teeko_accounts a ON a.id=c.account_id ${clause}`,values);
  const rows=await this.pool.query(`${metadata} ${clause} ORDER BY c.started_at DESC,c.id DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,query.pageSize,query.page*query.pageSize]);
  return{classrooms:(rows.rows as ClassroomRow[]).map(classroom),total:count.rows[0].total,page:query.page,pageSize:query.pageSize};
 }
 async events(accountId:string,id:string,input:unknown={}):Promise<ClassroomJournalEvents>{
  await this.requireAdmin(accountId);z.string().uuid().parse(id);const query=classroomJournalEventsQuerySchema.parse(input);
  const result=await this.pool.query(`${metadata} WHERE c.id=$1 AND a.consent_version<>'internal-admin'`,[id]);
  if(!result.rows[0])throw new AdminError('NOT_FOUND','没有找到这节课堂。',404);
  const current=classroom(result.rows[0]);
  const hasJournal=(await this.pool.query('SELECT 1 FROM teeko_classroom_journal WHERE classroom_id=$1 LIMIT 1',[id])).rowCount;
  let rows:EventRow[],coverage:ClassroomJournalEvents['coverage'];
  if(hasJournal){
   rows=(await this.pool.query('SELECT id::text,created_at,connection_epoch,revision,step_index,kind,actor,status,name,text,correlation_id,details FROM teeko_classroom_journal WHERE classroom_id=$1 AND id>$2::bigint ORDER BY teeko_classroom_journal.id LIMIT $3',[id,query.after??'0',query.limit+1])).rows;coverage='journal';
  }else{
   rows=(await this.pool.query(`WITH legacy AS(SELECT row_number() OVER(ORDER BY connection_epoch,created_at,item_id,role) AS id,created_at,connection_epoch,0::int AS revision,step_index,'utterance'::text AS kind,role::text AS actor,'recorded'::text AS status,'legacy_transcript'::text AS name,text,NULL::text AS correlation_id,jsonb_build_object('source',source) AS details FROM teeko_classroom_transcripts WHERE classroom_id=$1) SELECT id::text,created_at,connection_epoch,revision,step_index,kind,actor,status,name,text,correlation_id,details FROM legacy WHERE id>$2::bigint ORDER BY id::bigint LIMIT $3`,[id,query.after??'0',query.limit+1])).rows;coverage=current.eventCount?'legacy_transcripts':'none';
  }
  const more=rows.length>query.limit,events=rows.slice(0,query.limit).map(event);
  return{classroom:current,events,nextCursor:more?events.at(-1)!.id:null,coverage};
 }
}
