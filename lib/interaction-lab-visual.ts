import type {ClassroomSnapshot} from './classroom-contract';
import {labBase64Bytes} from './interaction-lab';
import {labTextTarget} from './interaction-lab-textbook';

export const LAB_VISUAL_MAX_BYTES=18000;
export type LabVisualPoint={x:number;y:number};
export type LabVisualPrepare={id:string;contextKey:string;kind:'region'|'board';point?:LabVisualPoint;textId?:string};
export type LabVisualReady={id:string;contextKey:string;image:string};
export type LabVisualMessage=
 |({type:'lab.visual.stage'}&LabVisualPrepare)
 |({type:'lab.visual.ready'}&LabVisualReady)
 |{type:'lab.visual.clear';contextKey:string;id?:string};

/** Attachment scope tracks the lesson/page, not revisions for highlights or known object clicks. */
export function labVisualContext(snapshot:ClassroomSnapshot):string{
 const task=snapshot.course.steps[snapshot.stepIndex];
 if(snapshot.status!=='active'||!task)return '';
 return JSON.stringify([snapshot.id,snapshot.connectionEpoch,snapshot.course.id,snapshot.course.version,task.pageId,task.id]);
}

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,exact:string[])=>Object.keys(value).length===exact.length&&Object.keys(value).every(key=>exact.includes(key));
const coordinate=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
export function parseLabVisualMessage(value:unknown):LabVisualMessage|null{
 if(!object(value)||typeof value.contextKey!=='string'||!value.contextKey||value.contextKey.length>1000)return null;
 const contextKey=value.contextKey,id=typeof value.id==='string'&&uuid.test(value.id)?value.id:undefined;
 if(value.type==='lab.visual.clear'){
  if(!keys(value,id?['type','contextKey','id']:['type','contextKey']))return null;
  return {type:value.type,contextKey,...(id?{id}:{})};
 }
 if(!id)return null;
 if(value.type==='lab.visual.stage'){
  if(value.kind==='board'&&keys(value,['type','id','contextKey','kind']))return{type:value.type,id,contextKey,kind:'board'};
  const target=labTextTarget(value.textId);
  if(value.kind!=='region'||!keys(value,['type','id','contextKey','kind','point',...(target?['textId']:[])])||!object(value.point)||!keys(value.point,['x','y'])||!coordinate(value.point.x)||!coordinate(value.point.y))return null;
  return {type:value.type,id,contextKey,kind:'region',point:{x:value.point.x,y:value.point.y},...(target?{textId:target.id}:{})};
 }
 if(value.type!=='lab.visual.ready'||!keys(value,['type','id','contextKey','image'])||typeof value.image!=='string'||value.image.length>24000)return null;
 const bytes=labBase64Bytes(value.image);
 if(!bytes||bytes>LAB_VISUAL_MAX_BYTES||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.image))return null;
 return {type:value.type,id,contextKey,image:value.image};
}
