import type {LabEventInput} from '../interaction-lab';
import {labBase64Bytes} from '../interaction-lab';
import {parseLabVisualMessage,type LabVisualPrepare} from '../interaction-lab-visual';
import {decodeClassroomVisionJpeg} from './classroom-vision-session';

type Prepared=LabVisualPrepare&{image?:string;itemId?:string;bytes?:number;width?:number;height?:number};
type Sent=Omit<Prepared,'image'>&{itemId:string};
type LabVisualReason='replaced'|'cleared'|'capture_timeout'|'speech_ended_before_send'|'speech_superseded'|'context_changed'|'muted'|'recovery'|'disconnected'|'provider_rejected';
type Options={
 context:()=>string;
 canSend:()=>boolean;
 send:(image:string)=>boolean;
 observe:(event:LabEventInput)=>void;
};

/** One explicit board attachment per native voice item. Outside the experiment this owner is absent. */
export class InteractionLabVisualTurn{
 private prepared:Prepared|null=null;
 private speech:{itemId:string;contextKey:string}|null=null;
 private sent:Sent|null=null;
 private captureTimer:ReturnType<typeof setTimeout>|undefined;
 private pacingTimer:ReturnType<typeof setTimeout>|undefined;
 private readonly stagedIds=new Set<string>();
 private lastSentAt=-Infinity;
 constructor(private readonly opts:Options){}

 private emit(kind:'image'|'error',label:string,frame:LabVisualPrepare,data:NonNullable<LabEventInput['data']>={},layer:'server'|'provider'='server'){
  try{this.opts.observe({layer,kind,label,data:{visualId:frame.id,kind:frame.kind,...(frame.point?{x:frame.point.x,y:frame.point.y}:{}),...(frame.textId?{textId:frame.textId}:{}),...data}});}
  catch{/* Trace delivery cannot alter the voice turn. */}
 }
 private clearTimers(){
  if(this.captureTimer)clearTimeout(this.captureTimer);
  if(this.pacingTimer)clearTimeout(this.pacingTimer);
  this.captureTimer=undefined;this.pacingTimer=undefined;
 }
 private discard(reason:LabVisualReason){
  this.clearTimers();
  const frame=this.prepared;this.prepared=null;
  if(frame)this.emit('image','待用教材图已取消',frame,{state:reason});
 }
 reset(reason:LabVisualReason){
  this.discard(reason);
  this.speech=null;this.sent=null;
 }
 reject(){
  const sent=this.sent;this.sent=null;
  if(sent)this.emit('error','通义拒绝了本轮教材图',sent,{itemId:sent.itemId,state:'provider_rejected'});
 }

 handle(raw:unknown){
  const message=parseLabVisualMessage(raw);
  if(!message||message.contextKey!==this.opts.context())return;
  if(message.type==='lab.visual.clear'){
   if(!message.id||message.id===this.prepared?.id)this.discard('cleared');
   return;
  }
  if(message.type==='lab.visual.stage'){
   if(this.stagedIds.has(message.id))return;
   // No session can retain unbounded ids or replay an already used id.
   if(this.stagedIds.size>=512)return;
   this.stagedIds.add(message.id);
   this.discard('replaced');
   const speech=this.speech;
   const itemId=speech&&speech.contextKey===message.contextKey&&this.sent?.itemId!==speech.itemId?speech.itemId:undefined;
   this.prepared={id:message.id,contextKey:message.contextKey,kind:message.kind,...(message.point?{point:message.point}:{}),...(message.textId?{textId:message.textId}:{}),...(itemId?{itemId}:{})};
   this.captureTimer=setTimeout(()=>this.discard('capture_timeout'),10000);this.captureTimer.unref();
   this.emit('image','已登记待用教材图',this.prepared,{state:'staged'});
   return;
  }
  const frame=this.prepared;
  if(!frame||frame.id!==message.id||frame.image)return;
  const size=decodeClassroomVisionJpeg(message.image),bytes=labBase64Bytes(message.image);
  if(!size||!bytes){
   this.emit('error','教材图文件无法使用，请重新准备',frame,{state:'invalid_jpeg'});
   this.discard('cleared');return;
  }
  if(this.captureTimer)clearTimeout(this.captureTimer);this.captureTimer=undefined;
  frame.image=message.image;frame.bytes=bytes;frame.width=size.width;frame.height=size.height;
  this.emit('image','教材图已准备，等待关联语音',frame,{state:'ready',format:'JPEG',bytes,...size});
  this.flush();
 }

 speechStarted(itemId:string){
  const contextKey=this.opts.context();if(!contextKey)return;
  if(this.speech?.itemId===itemId)return;
  if(this.prepared?.itemId&&this.prepared.itemId!==itemId)this.discard('speech_superseded');
  if(this.sent&&this.sent.itemId!==itemId){
   this.emit('image','教材图曾转发，但未确认关联到语音',this.sent,{itemId:this.sent.itemId,state:'speech_superseded'});this.sent=null;
  }
  this.speech={itemId,contextKey};
  if(this.prepared)this.prepared.itemId=itemId;
  this.flush();
 }
 speechStopped(itemId:string):boolean{
  if(this.speech?.itemId!==itemId)return false;
  const contextKey=this.opts.context();
  this.speech=null;
  if(this.prepared?.itemId===itemId)this.discard('speech_ended_before_send');
  const sent=this.sent;this.sent=null;
  if(!sent||sent.itemId!==itemId||sent.contextKey!==contextKey)return false;
  this.emit('image','已关联到本轮语音',sent,{state:'speech_ended',itemId,understandingConfirmed:false});
  return true;
 }
 flush(){
  if(this.pacingTimer){clearTimeout(this.pacingTimer);this.pacingTimer=undefined;}
  const frame=this.prepared,speech=this.speech;
  if(!frame?.image||!speech||frame.itemId!==speech.itemId||frame.contextKey!==speech.contextKey||this.opts.context()!==speech.contextKey||!this.opts.canSend()||this.sent?.itemId===speech.itemId)return;
  const wait=1000-(performance.now()-this.lastSentAt);
  if(wait>0){this.pacingTimer=setTimeout(()=>this.flush(),Math.ceil(wait));this.pacingTimer.unref();return;}
  const {image,...safe}=frame;
  if(!this.opts.send(image))return;
  this.clearTimers();this.prepared=null;this.lastSentAt=performance.now();
  this.sent={...safe,itemId:speech.itemId};
  this.emit('image','已向通义转发本轮教材图',frame,{state:'provider_sent',itemId:speech.itemId,format:'JPEG',bytes:frame.bytes??0,width:frame.width??0,height:frame.height??0,understandingConfirmed:false},'provider');
 }
}
