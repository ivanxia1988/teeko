import {validateClassroomToolRequest,type ClassroomToolRequest} from './classroom-tool';

type RequestRejection=Extract<ReturnType<typeof validateClassroomToolRequest>,{accepted:false}>['reason'];
type QueueRejection='closed'|'duplicate'|'queue_full'|'seen_limit'|'expired'|'invalid_deadline'|'invalid_time';
type Pending={request:ClassroomToolRequest;expiresAtMs:number};
export type ClassroomToolAdmission={accepted:true}|{accepted:false;reason:RequestRejection|QueueRejection};
export type ClassroomToolDispatch=
 | {kind:'empty'}
 | {kind:'ready';request:ClassroomToolRequest}
 | {kind:'discarded';request:ClassroomToolRequest;reason:RequestRejection|'expired'|'invalid_time'};

/** Bounded connection-local FIFO. Admission is not authority to execute or proof of an effect. */
export class ClassroomToolScheduler{
 private pending:Pending[]=[];
 private readonly requestIds=new Set<string>();
 private readonly callIds=new Set<string>();
 private closed=false;
 private lastNow=-Infinity;
 constructor(private readonly options:{maxPending:number;maxSeen:number;now:()=>number}){
  if(!Number.isSafeInteger(options.maxPending)||options.maxPending<1||!Number.isSafeInteger(options.maxSeen)||options.maxSeen<options.maxPending)throw new RangeError('Invalid classroom scheduler capacity.');
 }
 get size(){return this.pending.length;}
 private time():number|null{
  const now=this.options.now();
  if(!Number.isSafeInteger(now)||now<0||now<this.lastNow)return null;
  this.lastNow=now;return now;
 }
 enqueue(current:unknown,input:unknown,expiresAtMs:number):ClassroomToolAdmission{
  if(this.closed)return {accepted:false,reason:'closed'};
  const checked=validateClassroomToolRequest(current,input);if(!checked.accepted)return checked;
  const {request}=checked;
  if(this.requestIds.has(request.id)||this.callIds.has(request.callId))return {accepted:false,reason:'duplicate'};
  const now=this.time();if(now===null)return {accepted:false,reason:'invalid_time'};
  if(!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=request.receivedAtMs||request.receivedAtMs>now)return {accepted:false,reason:'invalid_deadline'};
  if(now>=expiresAtMs)return {accepted:false,reason:'expired'};
  if(this.requestIds.size>=this.options.maxSeen)return {accepted:false,reason:'seen_limit'};
  if(this.pending.length>=this.options.maxPending)return {accepted:false,reason:'queue_full'};
  this.requestIds.add(request.id);this.callIds.add(request.callId);this.pending.push({request,expiresAtMs});
  return {accepted:true};
 }
 take(current:unknown):ClassroomToolDispatch{
  const next=this.pending.shift();if(!next)return {kind:'empty'};
  const now=this.time();
  if(now===null)return {kind:'discarded',request:next.request,reason:'invalid_time'};
  if(now>=next.expiresAtMs)return {kind:'discarded',request:next.request,reason:'expired'};
  const checked=validateClassroomToolRequest(current,next.request);
  return checked.accepted?{kind:'ready',request:checked.request}:{kind:'discarded',request:next.request,reason:checked.reason};
 }
 /** Remove queued payloads; consumed/cancelled IDs remain tombstones until this connection closes. */
 cancelPending():readonly ClassroomToolRequest[]{
  const cancelled=this.pending.map(item=>item.request);this.pending=[];return cancelled;
 }
 close():readonly ClassroomToolRequest[]{
  this.closed=true;const cancelled=this.cancelPending();this.requestIds.clear();this.callIds.clear();return cancelled;
 }
}
