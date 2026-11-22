import {z} from 'zod';
import {captureClassroomState,classroomTaskContextSchema,validateClassroomContext,type ClassroomContextRejectionReason} from './classroom-context';

const timestamp=z.number().int().nonnegative().safe();
const schema=z.object({
 type:z.literal('chalk.write'),id:z.string().uuid(),context:classroomTaskContextSchema,
 receivedAtMs:timestamp,expiresAtMs:timestamp,
 text:z.string().min(1).max(120).refine(value=>value.trim().length>0&&!/[\u0000-\u001f\u007f]/u.test(value)),
}).strict().refine(value=>value.expiresAtMs-value.receivedAtMs>=2000&&value.expiresAtMs-value.receivedAtMs<=20000).readonly();
export type ClassroomChalkWriting=z.infer<typeof schema>;
type Reason=Exclude<ClassroomContextRejectionReason,'invalid_context'>|'invalid_chalk'|'invalid_time'|'future_writing'|'expired';
export type ClassroomChalkValidation={accepted:true;writing:ClassroomChalkWriting}|{accepted:false;reason:Reason};

/** A local display proposal, never provenance, execution, playback or learning evidence. */
export function validateClassroomChalkWriting(current:unknown,input:unknown,nowMs:number):ClassroomChalkValidation{
 const captured=captureClassroomState(current);if(!captured.ok)return {accepted:false,reason:'invalid_state'};
 const parsed=schema.safeParse(input);if(!parsed.success)return {accepted:false,reason:'invalid_chalk'};
 const scope=validateClassroomContext(captured.snapshot,parsed.data.context);if(!scope.accepted)return {accepted:false,reason:scope.reason==='invalid_context'?'invalid_chalk':scope.reason};
 if(!Number.isSafeInteger(nowMs)||nowMs<0)return {accepted:false,reason:'invalid_time'};
 if(parsed.data.receivedAtMs>nowMs)return {accepted:false,reason:'future_writing'};
 if(nowMs>=parsed.data.expiresAtMs)return {accepted:false,reason:'expired'};
 return {accepted:true,writing:parsed.data};
}

/** One bounded owner; no persistence or network. Cancellation cannot revive an earlier writing. */
export class ClassroomChalkBoard{
 private writing:ClassroomChalkWriting|null=null;
 private readonly seen=new Set<string>();
 private lastNow=-Infinity;
 private closed=false;
 constructor(private readonly now:()=>number=Date.now){}
 private time():number|null{
  let value:number;try{value=this.now();}catch{return null;}
  if(!Number.isSafeInteger(value)||value<0||value<this.lastNow)return null;
  this.lastNow=value;return value;
 }
 private currentAt(current:unknown,now:number){
  if(this.writing&&!validateClassroomChalkWriting(current,this.writing,now).accepted)this.writing=null;
  return this.writing;
 }
 write(current:unknown,input:unknown):ClassroomChalkValidation|{accepted:false;reason:'closed'|'duplicate'|'seen_limit'}{
  if(this.closed)return {accepted:false,reason:'closed'};
  const now=this.time();if(now===null){this.clear();return {accepted:false,reason:'invalid_time'};}
  this.currentAt(current,now);
  const checked=validateClassroomChalkWriting(current,input,now);if(!checked.accepted)return checked;
  if(this.seen.has(checked.writing.id))return {accepted:false,reason:'duplicate'};
  if(this.seen.size>=250)return {accepted:false,reason:'seen_limit'};
  this.seen.add(checked.writing.id);this.writing=checked.writing;return checked;
 }
 read(current:unknown):ClassroomChalkWriting|null{
  if(this.closed)return null;
  const now=this.time();if(now===null){this.clear();return null;}
  return this.currentAt(current,now);
 }
 clear(){this.writing=null;}
 close(){this.closed=true;this.clear();this.seen.clear();}
}
