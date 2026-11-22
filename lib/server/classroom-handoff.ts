import {captureClassroomState,type ClassroomStateSnapshot} from '../domain/classroom-context';

export type ClassroomHandoffScope=ClassroomStateSnapshot&{readonly stepIndex:number};
export type ClassroomHandoffInput=Readonly<{itemId:string;sequence:number;activity:number}>;
export type ClassroomHandoffAdvance=Readonly<{
 id:string;
 before:ClassroomHandoffScope;
 after:ClassroomHandoffScope;
 input:ClassroomHandoffInput;
}>;
export type ClassroomHandoffObservation=Readonly<{scope:ClassroomHandoffScope;input:ClassroomHandoffInput|null}>;
export type ClassroomHandoffReply=Readonly<{id:string;hasOutput:boolean;done:boolean}>;
export type ClassroomHandoffResult=
 |{action:'none'|'wait'}
 |{action:'apply_silent'|'apply_with_cue';advance:ClassroomHandoffAdvance}
 |{action:'cancelled';reason:'new_input'|'scope_changed'|'ambiguous_reply'|'expired'|'clock_invalid'};

type CancellationReason=Extract<ClassroomHandoffResult,{action:'cancelled'}>['reason'];
type Pending={
 advance:ClassroomHandoffAdvance;
 startedAt:number;
 lastObservedAt:number;
 reply:{id:string;hasOutput:boolean;done:boolean;drained:boolean}|null;
 invalidReason:CancellationReason|null;
};

function identifier(value:unknown):value is string{
 return typeof value==='string'&&value.length>0&&value.length<=300&&value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value);
}
function counter(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
function inputValid(input:ClassroomHandoffInput|null):input is ClassroomHandoffInput{
 return Boolean(input&&identifier(input.itemId)&&counter(input.sequence)&&counter(input.activity));
}
function sameInput(left:ClassroomHandoffInput,right:ClassroomHandoffInput|null):boolean{
 return inputValid(right)&&left.itemId===right.itemId&&left.sequence===right.sequence&&left.activity===right.activity;
}
function captureScope(scope:ClassroomHandoffScope):ClassroomHandoffScope|null{
 if(!scope||!counter(scope.stepIndex))return null;
 const captured=captureClassroomState({status:scope.status,context:scope.context});
 return captured.ok?Object.freeze({...captured.snapshot,stepIndex:scope.stepIndex}):null;
}
function sameScope(left:ClassroomHandoffScope,right:ClassroomHandoffScope):boolean{
 const captured=captureScope(right);if(!captured)return false;
 const a=left.context,b=captured.context;
 return left.status===captured.status&&left.stepIndex===captured.stepIndex&&
  a.logicalSessionId===b.logicalSessionId&&a.courseVersion===b.courseVersion&&a.connectionEpoch===b.connectionEpoch&&
  a.stateRevision===b.stateRevision&&a.pageId===b.pageId&&a.activityId===b.activityId;
}

/** Coordinates an already-authorized advance; this never authorizes or executes a tool. */
export class ClassroomHandoff{
 private readonly now:()=>number;
 private readonly maxWaitMs:number;
 private readonly replyGraceMs:number;
 private readonly seen=new Set<string>();
 private pending:Pending|null=null;

 constructor(options:{now?:()=>number;maxWaitMs?:number;replyGraceMs?:number}={}){
  this.now=options.now??Date.now;
  this.maxWaitMs=options.maxWaitMs??15_000;
  this.replyGraceMs=options.replyGraceMs??300;
  if(!Number.isFinite(this.maxWaitMs)||this.maxWaitMs<=0||!Number.isFinite(this.replyGraceMs)||this.replyGraceMs<0||this.replyGraceMs>this.maxWaitMs)throw new RangeError('Invalid classroom handoff deadlines.');
 }

 offer(advance:ClassroomHandoffAdvance,current:ClassroomHandoffObservation,reply?:ClassroomHandoffReply):boolean{
  if(this.pending||!advance||!identifier(advance.id)||this.seen.has(advance.id)||!inputValid(advance.input)||!sameInput(advance.input,current.input))return false;
  const before=captureScope(advance.before),after=captureScope(advance.after);
  if(!before||!after||before.status!=='active'||after.status!=='active'||!sameScope(before,current.scope))return false;
  const a=before.context,b=after.context;
  if(after.stepIndex!==before.stepIndex+1||b.stateRevision<=a.stateRevision||a.activityId===b.activityId||
   a.logicalSessionId!==b.logicalSessionId||a.courseVersion!==b.courseVersion||a.connectionEpoch!==b.connectionEpoch)return false;
  if(reply&&(!identifier(reply.id)||typeof reply.hasOutput!=='boolean'||typeof reply.done!=='boolean'))return false;
  const now=this.now();if(!Number.isFinite(now)||now<0)return false;
  const captured=Object.freeze({id:advance.id,before,after,input:Object.freeze({...advance.input})});
  this.pending={advance:captured,startedAt:now,lastObservedAt:now,reply:reply?{...reply,drained:false}:null,invalidReason:null};
  this.seen.add(advance.id);
  if(this.seen.size>256)this.seen.delete(this.seen.values().next().value!);
  return true;
 }

 replyStarted(id:string,input:ClassroomHandoffInput):boolean{
  const pending=this.currentPending();if(!pending||!identifier(id)||!sameInput(pending.advance.input,input))return false;
  if(pending.reply&&pending.reply.id!==id){pending.invalidReason='ambiguous_reply';return false;}
  pending.reply??={id,hasOutput:false,done:false,drained:false};
  return true;
 }

 replyOutput(id:string,input:ClassroomHandoffInput):boolean{
  const pending=this.currentPending();if(!pending||!sameInput(pending.advance.input,input)||pending.reply?.id!==id)return false;
  pending.reply.hasOutput=true;
  // New output after a browser receipt must be drained again.
  pending.reply.drained=false;
  return true;
 }

 replyDone(id:string,input:ClassroomHandoffInput):boolean{
  const pending=this.currentPending();if(!pending||!sameInput(pending.advance.input,input)||pending.reply?.id!==id)return false;
  pending.reply.done=true;return true;
 }

 playbackDrained(id:string,input:ClassroomHandoffInput):boolean{
  const pending=this.currentPending();if(!pending||!sameInput(pending.advance.input,input)||pending.reply?.id!==id||!pending.reply.done)return false;
  pending.reply.drained=true;return true;
 }

 take(current:ClassroomHandoffObservation,playback:{responsePending:boolean;outputQueued:boolean}):ClassroomHandoffResult{
  const pending=this.pending;if(!pending)return{action:'none'};
  this.checkTime(pending);
  if(!sameInput(pending.advance.input,current.input))pending.invalidReason='new_input';
  else if(!sameScope(pending.advance.before,current.scope))pending.invalidReason='scope_changed';
  if(pending.invalidReason){this.pending=null;return{action:'cancelled',reason:pending.invalidReason};}
  if(playback.responsePending||playback.outputQueued)return{action:'wait'};
  const reply=pending.reply;
  if(reply){
   if(!reply.done||reply.hasOutput&&!reply.drained)return{action:'wait'};
  }else if(pending.lastObservedAt-pending.startedAt<this.replyGraceMs)return{action:'wait'};
  this.pending=null;
  return{action:reply?.hasOutput?'apply_silent':'apply_with_cue',advance:pending.advance};
 }

 cancel():void{this.pending=null;}

 private currentPending():Pending|null{
  if(!this.pending)return null;
  this.checkTime(this.pending);
  return this.pending.invalidReason?null:this.pending;
 }

 private checkTime(pending:Pending):void{
  const now=this.now();
  if(!Number.isFinite(now)||now<pending.lastObservedAt){pending.invalidReason??='clock_invalid';return;}
  pending.lastObservedAt=now;
  if(now-pending.startedAt>=this.maxWaitMs)pending.invalidReason??='expired';
 }
}
