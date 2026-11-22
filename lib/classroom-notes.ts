import {z} from 'zod';

const identifier=z.string().min(1).max(200).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value));
const timestamp=z.string().datetime();
const epoch=z.number().int().positive().safe();
const cursorSchema=z.object({at:timestamp,epoch,itemId:identifier}).strict().readonly();
export type ClassroomNotesCursor=z.infer<typeof cursorSchema>;
export function encodeClassroomNotesCursor(input:ClassroomNotesCursor):string{
 const value=cursorSchema.parse(input),bytes=new TextEncoder().encode(JSON.stringify(value));
 return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export function decodeClassroomNotesCursor(input:string):ClassroomNotesCursor|null{
 try{
  if(!/^[A-Za-z0-9_-]{1,1024}$/.test(input))return null;
  const base64=input.replaceAll('-','+').replaceAll('_','/'),bytes=Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length/4)*4,'=')),character=>character.charCodeAt(0));
  const parsed=cursorSchema.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  return parsed.success&&encodeClassroomNotesCursor(parsed.data)===input?parsed.data:null;
 }catch{return null;}
}
const querySchema=z.object({cursor:z.string().max(1024).optional(),pageSize:z.coerce.number().int().min(1).max(10).default(5)}).strict();
export type ClassroomNotesQuery={pageSize:number;cursor:ClassroomNotesCursor|null};
export function parseClassroomNotesQuery(input:unknown):{ok:true;query:ClassroomNotesQuery}|{ok:false;reason:'invalid_query'}{
 const parsed=querySchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_query'};
 const cursor=parsed.data.cursor===undefined?null:decodeClassroomNotesCursor(parsed.data.cursor);
 if(parsed.data.cursor!==undefined&&!cursor)return {ok:false,reason:'invalid_query'};
 return {ok:true,query:{pageSize:parsed.data.pageSize,cursor}};
}
export const classroomNoteSchema=z.object({
 id:z.string().min(1).max(240),step:z.object({id:identifier,label:z.string().min(1).max(180)}).strict().readonly(),
 original:z.object({text:z.string().min(1).max(300),excerpt:z.boolean(),source:z.enum(['speech','typed']),recordedAt:timestamp}).strict().readonly(),
 reference:z.object({text:z.string().min(1).max(180),kind:z.literal('generated_teaching_reference'),createdAt:timestamp}).strict().readonly(),
 origin:z.object({connectionEpoch:epoch,itemId:identifier}).strict().readonly(),
}).strict().readonly();
export type ClassroomNote=z.infer<typeof classroomNoteSchema>;
export const classroomNotesPageSchema=z.object({ok:z.literal(true),classroomId:z.string().uuid(),courseVersion:z.string().min(1).max(128),entries:z.array(classroomNoteSchema).max(10).readonly(),nextCursor:z.string().max(1024).refine(value=>decodeClassroomNotesCursor(value)!==null).nullable(),coverage:z.enum(['retained_sources','captured_sources','limited_sources']),preparation:z.enum(['pending','ready','unavailable']).optional()}).strict().readonly();
export type ClassroomNotesPage=z.infer<typeof classroomNotesPageSchema>;
