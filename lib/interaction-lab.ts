import type {ClassroomSnapshot} from './classroom-contract';
import {labTextTarget} from './interaction-lab-textbook';

export const LAB_IMAGE='/course-assets/robot-reading-predict.svg';
export const LAB_URL='/interaction-lab';
export const LAB_EVENT_LIMIT=240;

export type LabEventInput={
 layer:'browser'|'server'|'provider'|'display';
 kind:'connection'|'speech'|'point'|'image'|'tool'|'audio'|'error';
 label:string;
 data?:Record<string,string|number|boolean>;
 transcript?:{role:'child'|'teacher';text:string};
};
export type LabEvent=LabEventInput&{id:string;at:number};
export type LabSession={id:string;snapshot:ClassroomSnapshot};
export type LabEventBatch={events:LabEvent[];cursor:number};

const scalar=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)?value:undefined;
const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
const fraction=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1?value:undefined;
const object=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const details=(value:Record<string,string|number|boolean|undefined>)=>Object.fromEntries(Object.entries(value).filter((pair):pair is [string,string|number|boolean]=>pair[1]!==undefined));
export function labBase64Bytes(value:unknown):number|undefined {
 if(typeof value!=='string'||value.length<4||value.length%4!==0||value.length>64000)return undefined;
 return value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0);
}

/** Project messages only after WebSocket.send has accepted them; never include media or arbitrary payload fields. */
export function labBrowserWireEvent(event:unknown):LabEventInput|null {
 const wire=object(event);
 switch(wire.type){
  case 'interaction.point':{
   const objectId=scalar(wire.objectId),pointId=scalar(wire.eventId),ctx=object(wire.context);
   if(!objectId||!pointId)return null;
   return {layer:'browser',kind:'point',label:'浏览器发出点选',data:details({event:'interaction.point',pointId,objectId,pageId:scalar(ctx.pageId),activityId:scalar(ctx.activityId),courseVersion:scalar(ctx.courseVersion),connectionEpoch:count(ctx.connectionEpoch),stateRevision:count(ctx.stateRevision),coordinatesSent:false,imageSent:false})};
  }
  case 'board.frame':{
   const bytes=labBase64Bytes(wire.image);
   if(bytes===undefined)return null;
   return {layer:'browser',kind:'image',label:'浏览器发出教材画面',data:details({event:'board.frame',format:'JPEG',bytes,generation:count(wire.generation),sequence:count(wire.sequence),content:'教材 + 自己的笔迹'})};
  }
  case 'lab.visual.stage':{
   const visualId=scalar(wire.id),point=object(wire.point);
   if(!visualId||wire.kind!=='board'&&wire.kind!=='region')return null;
   const target=wire.kind==='region'?labTextTarget(wire.textId):null;
   return {layer:'browser',kind:target?'point':'image',label:target?'浏览器发出教材文字点选':wire.kind==='region'?'准备点击位置的教材局部':'准备最新的教材和笔迹',data:details({event:wire.type,visualId,kind:wire.kind,...(wire.kind==='region'?{x:fraction(point.x),y:fraction(point.y)}:{}),...(target?{textId:target.id,word:target.text}:{}),providerSent:false})};
  }
  case 'lab.visual.ready':{
   const visualId=scalar(wire.id),bytes=labBase64Bytes(wire.image);
   if(!visualId||!bytes)return null;
   return {layer:'browser',kind:'image',label:'教材 JPEG 已发到实验台，等待语音',data:{event:wire.type,visualId,format:'JPEG',bytes,providerSent:false}};
  }
  case 'lab.visual.clear':
   return {layer:'browser',kind:'image',label:'撤销尚未发送的教材参考',data:details({event:wire.type,visualId:scalar(wire.id)})};
  case 'text':
   return typeof wire.text==='string'?{layer:'browser',kind:'speech',label:'浏览器发出文字指令',data:{event:'text',characters:wire.text.length}}:null;
  case 'diagnostic.playback':
   if(wire.phase!=='playback_started')return null;
   return {layer:'display',kind:'audio',label:'浏览器报告开始播放老师声音',data:details({event:'diagnostic.playback',turnId:scalar(wire.turnId),spanId:scalar(wire.spanId),elapsedMs:count(wire.elapsedMs)})};
  default:
   return null;
 }
}
