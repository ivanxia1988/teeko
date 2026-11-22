import {z} from 'zod';
import type {ClassroomSnapshot} from '../classroom-contract';
import {classroomNoteSchema,encodeClassroomNotesCursor,type ClassroomNotesPage,type ClassroomNotesQuery} from '../classroom-notes';
import {sanitizeClassroomJournalText} from '../classroom-journal';
import type {PoolClient} from 'pg';
import {buildClassroomNote} from './classroom-notes';
export const CLASSROOM_NOTES_LIMIT=256;
export type ClassroomNoteOwner=Pick<ClassroomSnapshot,'id'|'course'|'connectionEpoch'|'startedAt'|'endedAt'>;
const storedSchema=z.object({card:classroomNoteSchema,at:z.string().datetime()}).strict().readonly();
export type StoredClassroomNote=z.infer<typeof storedSchema>;
const coverageSchema=z.enum(['captured_sources','retained_sources','limited_sources']);
const manifestSchema=z.object({version:z.literal(1),classroomId:z.string().uuid(),courseVersion:z.string().min(1).max(128),sourceRevision:z.number().int().nonnegative().safe(),coverage:coverageSchema,entries:z.array(storedSchema).max(CLASSROOM_NOTES_LIMIT).readonly()}).strict().readonly();
export type ClassroomNoteManifest=z.infer<typeof manifestSchema>;
function micros(value:string):bigint{
 const extra=(/\.(\d+)Z$/.exec(value)?.[1]??'').padEnd(6,'0').slice(3,6);
 return BigInt(Date.parse(value))*BigInt(1000)+BigInt(extra||'0');
}
export function compareClassroomNotes(a:StoredClassroomNote,b:StoredClassroomNote):number{
 const diff=micros(b.at)-micros(a.at);
 return diff>BigInt(0)?1:diff<BigInt(0)?-1:b.card.origin.connectionEpoch-a.card.origin.connectionEpoch||Buffer.compare(Buffer.from(b.card.origin.itemId),Buffer.from(a.card.origin.itemId));
}
export function parseStoredClassroomNote(owner:ClassroomNoteOwner,input:unknown):StoredClassroomNote|null{
 const parsed=storedSchema.safeParse(input);if(!parsed.success)return null;
 const {card,at}=parsed.data,step=owner.course.steps.find(step=>step.id===card.step.id);
 if(!step||card.step.label!==(step.chinese||step.english).slice(0,180)||!owner.course.pages.some(page=>page.id===step.pageId)||card.id!==`${card.origin.connectionEpoch}:${card.origin.itemId}`||card.origin.connectionEpoch>owner.connectionEpoch||Date.parse(card.original.recordedAt)<Date.parse(owner.startedAt)||micros(card.reference.createdAt)<micros(card.original.recordedAt)||micros(at)<micros(card.reference.createdAt)||owner.endedAt&&micros(at)>micros(owner.endedAt))return null;
 for(const text of [card.original.text,card.reference.text])if(sanitizeClassroomJournalText(text,text.length)!==text)return null;
 if(/[\u0000-\u001f\u007f]/u.test(card.reference.text)||!card.reference.text.trim())return null;
 return parsed.data;
}
export function parseClassroomNoteManifest(owner:ClassroomNoteOwner,revision:number,input:unknown):ClassroomNoteManifest|null{
 const parsed=manifestSchema.safeParse(input);if(!parsed.success)return null;
 const value=parsed.data;
 if(value.classroomId!==owner.id||value.courseVersion!==`${owner.course.id}:${owner.course.version}`||value.sourceRevision!==revision||!owner.endedAt)return null;
 const seen=new Set<string>();let previous:StoredClassroomNote|undefined;
 for(const entry of value.entries){if(!parseStoredClassroomNote(owner,entry)||seen.has(entry.card.id)||previous&&compareClassroomNotes(previous,entry)>0)return null;seen.add(entry.card.id);previous=entry;}
 return value;
}
export function pageClassroomNoteManifest(manifest:ClassroomNoteManifest,query:ClassroomNotesQuery):Omit<ClassroomNotesPage,'ok'>{
 const {cursor,pageSize}=query;
 const remaining=cursor?manifest.entries.filter(entry=>compareClassroomNotes(entry,{card:{...entry.card,origin:{connectionEpoch:cursor.epoch,itemId:cursor.itemId}},at:cursor.at})>0):manifest.entries;
 const shown=remaining.slice(0,pageSize),last=shown.at(-1);
 return{classroomId:manifest.classroomId,courseVersion:manifest.courseVersion,entries:shown.map(entry=>entry.card),nextCursor:remaining.length>pageSize&&last?encodeClassroomNotesCursor({at:last.at,epoch:last.card.origin.connectionEpoch,itemId:last.card.origin.itemId}):null,coverage:manifest.coverage};
}

/** The caller already owns the account/classroom transaction; keep capture with the saved decision. */
export async function captureClassroomNote(db:PoolClient,owner:ClassroomNoteOwner,revision:number,source:unknown):Promise<void>{
 const card=buildClassroomNote(owner,source);if(!card)return;
 const entry=parseStoredClassroomNote(owner,{card,at:card.reference.createdAt});if(!entry)return;
 await db.query('INSERT INTO teeko_classroom_note_state(classroom_id,captured_from_start) VALUES($1,false) ON CONFLICT DO NOTHING',[owner.id]);
 const exists=await db.query('SELECT 1 FROM teeko_classroom_note_records WHERE classroom_id=$1 AND connection_epoch=$2 AND item_id=$3',[owner.id,card.origin.connectionEpoch,card.origin.itemId]);if(exists.rowCount)return;
 const count=Number((await db.query('SELECT count(*) AS n FROM teeko_classroom_note_records WHERE classroom_id=$1',[owner.id])).rows[0].n);
 if(count>=CLASSROOM_NOTES_LIMIT){await db.query('UPDATE teeko_classroom_note_state SET capped=true WHERE classroom_id=$1',[owner.id]);return;}
 await db.query('INSERT INTO teeko_classroom_note_records(classroom_id,connection_epoch,item_id,source_revision,card,saved_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[owner.id,card.origin.connectionEpoch,card.origin.itemId,revision,JSON.stringify(card),entry.at]);
}

/** Shared bounded read; an active lesson supplies a source-time upper bound separately. */
export async function readClassroomNoteSources(db:PoolClient,owner:ClassroomNoteOwner,revision:number,until=owner.endedAt):Promise<Pick<ClassroomNoteManifest,'entries'|'coverage'>>{
 const state=(await db.query('SELECT captured_from_start,capped FROM teeko_classroom_note_state WHERE classroom_id=$1',[owner.id])).rows[0];
 const records=await db.query(`SELECT card,connection_epoch,item_id,source_revision,to_char(saved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM teeko_classroom_note_records WHERE classroom_id=$1 ORDER BY saved_at DESC,connection_epoch DESC,item_id COLLATE "C" DESC LIMIT $2`,[owner.id,CLASSROOM_NOTES_LIMIT+1]);
 const entries=new Map<string,StoredClassroomNote>();let limited=!!state?.capped||records.rows.length>CLASSROOM_NOTES_LIMIT;
 for(const value of records.rows){const entry=parseStoredClassroomNote(owner,{card:value.card,at:value.at});if(entry&&(!until||micros(entry.at)<=micros(until))&&value.source_revision<=revision&&value.connection_epoch===entry.card.origin.connectionEpoch&&value.item_id===entry.card.origin.itemId)entries.set(entry.card.id,entry);else limited=true;}
 if(!state?.captured_from_start){
  const legacy=await db.query(`SELECT d.connection_epoch AS epoch,d.item_id AS "itemId",d.context_key AS "contextKey",d.decision,d.created_at AS "decisionAt",to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,t.step_index AS "stepIndex",t.text AS "transcriptText",t.source AS "transcriptSource",t.created_at AS "transcriptAt"
   FROM teeko_teaching_decisions d JOIN teeko_classroom_transcripts t ON t.classroom_id=d.classroom_id AND t.connection_epoch=d.connection_epoch AND t.item_id=d.item_id AND t.role='child'
   WHERE d.classroom_id=$1 AND d.decision->>'confidence'='high' AND d.decision->>'nextAction'='model' ORDER BY d.created_at DESC,d.connection_epoch DESC,d.item_id COLLATE "C" DESC LIMIT 64`,[owner.id]);
  for(const value of legacy.rows){
   const card=buildClassroomNote(owner,{epoch:value.epoch,itemId:value.itemId,stepIndex:value.stepIndex,transcriptText:value.transcriptText,transcriptSource:value.transcriptSource,transcriptAt:value.transcriptAt.toISOString(),contextKey:value.contextKey,decisionAt:value.decisionAt.toISOString(),decision:value.decision});
   const entry=card?parseStoredClassroomNote(owner,{card,at:value.at}):null;if(entry&&(!until||micros(entry.at)<=micros(until))&&!entries.has(entry.card.id))entries.set(entry.card.id,entry);
  }
 }
 if(entries.size>CLASSROOM_NOTES_LIMIT)limited=true;
 return{coverage:limited?'limited_sources':state?.captured_from_start?'captured_sources':'retained_sources',entries:[...entries.values()].sort(compareClassroomNotes).slice(0,CLASSROOM_NOTES_LIMIT)};
}
/** Bounded deterministic consolidation. Legacy sources stay explicitly incomplete. */
export async function buildClassroomNoteManifest(db:PoolClient,owner:ClassroomNoteOwner,revision:number):Promise<ClassroomNoteManifest>{
 const sources=await readClassroomNoteSources(db,owner,revision);
 const manifest={version:1 as const,classroomId:owner.id,courseVersion:`${owner.course.id}:${owner.course.version}`,sourceRevision:revision,...sources};
 const parsed=parseClassroomNoteManifest(owner,revision,manifest);if(!parsed)throw new Error('Invalid note manifest.');return parsed;
}
