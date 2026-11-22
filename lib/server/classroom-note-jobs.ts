import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {ClassroomNoteOwner,ClassroomNoteManifest} from './classroom-note-store';
import {buildClassroomNoteManifest,parseClassroomNoteManifest} from './classroom-note-store';
import type {PublishedCourse} from '../classroom-contract';
export type ClassroomNoteTask=Readonly<{id:string;classroomId:string;sourceRevision:number;ownerToken:string;attempts:number}>;
export class ClassroomNoteJobs{
 private now:()=>Date;
 constructor(private readonly pool:Pool,options:{now?:()=>Date}={}){this.now=options.now??(()=>new Date());}
 private async tx<T>(work:(db:PoolClient)=>Promise<T>):Promise<T>{const db=await this.pool.connect();try{await db.query('BEGIN');const result=await work(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
 async claim():Promise<ClassroomNoteTask|null>{return this.tx(async db=>{
  const now=this.now();
  await db.query("UPDATE teeko_classroom_note_jobs SET status='failed',owner_token=NULL,lease_until=NULL,error_code='LEASE_EXHAUSTED',updated_at=$1 WHERE status='running' AND lease_until<=$1 AND attempts>=3",[now]);
  const row=(await db.query(`SELECT id,classroom_id,source_revision,attempts FROM teeko_classroom_note_jobs WHERE (status='pending' AND run_after<=$1 OR status='running' AND lease_until<=$1) AND attempts<3 ORDER BY run_after,id FOR UPDATE SKIP LOCKED LIMIT 1`,[now])).rows[0];if(!row)return null;
  const ownerToken=randomUUID(),claimedAt=this.now();await db.query("UPDATE teeko_classroom_note_jobs SET status='running',attempts=attempts+1,owner_token=$2,lease_until=$3,updated_at=$4,error_code=NULL WHERE id=$1",[row.id,ownerToken,new Date(claimedAt.getTime()+30000),claimedAt]);
  return Object.freeze({id:row.id,classroomId:row.classroom_id,sourceRevision:row.source_revision,attempts:row.attempts+1,ownerToken});
 });}
 private async owner(db:PoolClient,task:ClassroomNoteTask):Promise<ClassroomNoteOwner|null>{
  const row=(await db.query(`SELECT r.id,r.connection_epoch,r.started_at,r.ended_at,c.manifest FROM teeko_classrooms r JOIN teeko_courses c ON c.id=r.course_id AND c.version=r.course_version WHERE r.id=$1 AND r.status='ended' AND r.revision=$2 FOR SHARE OF r`,[task.classroomId,task.sourceRevision])).rows[0];
  return row&&row.ended_at?{id:row.id,course:row.manifest as PublishedCourse,connectionEpoch:row.connection_epoch,startedAt:row.started_at.toISOString(),endedAt:row.ended_at.toISOString()}:null;
 }
 async build(task:ClassroomNoteTask):Promise<ClassroomNoteManifest|null>{return this.tx(async db=>{const owner=await this.owner(db,task);return owner?buildClassroomNoteManifest(db,owner,task.sourceRevision):null;});}
 private async lockOwned(db:PoolClient,task:ClassroomNoteTask):Promise<Date|null>{
  const row=(await db.query('SELECT classroom_id,source_revision,status,owner_token,lease_until FROM teeko_classroom_note_jobs WHERE id=$1 FOR UPDATE',[task.id])).rows[0];
  // Waiting for the lock can outlive a lease; do not reuse a pre-wait timestamp.
  const now=this.now();
  return row&&row.classroom_id===task.classroomId&&row.source_revision===task.sourceRevision&&row.status==='running'&&row.owner_token===task.ownerToken&&row.lease_until instanceof Date&&row.lease_until.getTime()>now.getTime()?now:null;
 }
 async complete(task:ClassroomNoteTask,input:unknown):Promise<boolean>{return this.tx(async db=>{
  const owner=await this.owner(db,task),manifest=owner?parseClassroomNoteManifest(owner,task.sourceRevision,input):null;if(!manifest)return false;
  const now=await this.lockOwned(db,task);if(!now)return false;
  const result=await db.query("UPDATE teeko_classroom_note_jobs SET status='succeeded',result=$3,owner_token=NULL,lease_until=NULL,updated_at=$4,error_code=NULL WHERE id=$1 AND owner_token=$2 AND status='running' AND lease_until>$4 AND source_revision=$5 AND classroom_id=$6",[task.id,task.ownerToken,JSON.stringify(manifest),now,task.sourceRevision,task.classroomId]);return !!result.rowCount;
 });}
 async fail(task:ClassroomNoteTask):Promise<'retry'|'failed'|'lost'>{return this.tx(async db=>{
  const now=await this.lockOwned(db,task);if(!now)return'lost';
  const result=await db.query("UPDATE teeko_classroom_note_jobs SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,run_after=$3::timestamptz+interval '1 second'*LEAST(10,power(2,attempts))::double precision,owner_token=NULL,lease_until=NULL,error_code='PROCESSING_FAILED',updated_at=$3 WHERE id=$1 AND owner_token=$2 AND status='running' AND lease_until>$3 AND source_revision=$4 AND classroom_id=$5 RETURNING status",[task.id,task.ownerToken,now,task.sourceRevision,task.classroomId]);return result.rows[0]?.status==='pending'?'retry':result.rowCount?'failed':'lost';
 });}
 private async cancelOwned(task:ClassroomNoteTask):Promise<boolean>{return this.tx(async db=>{
  const now=await this.lockOwned(db,task);if(!now)return false;
  const result=await db.query("UPDATE teeko_classroom_note_jobs SET status='cancelled',owner_token=NULL,lease_until=NULL,error_code='SOURCE_CHANGED',updated_at=$3 WHERE id=$1 AND owner_token=$2 AND status='running' AND lease_until>$3 AND source_revision=$4 AND classroom_id=$5",[task.id,task.ownerToken,now,task.sourceRevision,task.classroomId]);return !!result.rowCount;
 });}
 async cancel(classroomId:string):Promise<boolean>{
  const result=await this.pool.query("UPDATE teeko_classroom_note_jobs SET status='cancelled',result=NULL,owner_token=NULL,lease_until=NULL,updated_at=$2 WHERE classroom_id=$1 AND status IN ('pending','running')",[classroomId,this.now()]);return !!result.rowCount;
 }
 async runOne(signal?:AbortSignal):Promise<'empty'|'succeeded'|'retry'|'failed'|'cancelled'|'lost'>{
  if(signal?.aborted)return'empty';const task=await this.claim();if(!task)return'empty';
  try{
   if(signal?.aborted){await this.fail(task);return'cancelled';}
   const result=await this.build(task);
   if(!result)return await this.cancelOwned(task)?'cancelled':'lost';
   if(signal?.aborted){await this.fail(task);return'cancelled';}
   return await this.complete(task,result)?'succeeded':'lost';
  }catch{return this.fail(task);}
 }
}
