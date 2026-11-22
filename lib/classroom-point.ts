import {z} from 'zod';
import {captureClassroomToolState} from './classroom-tool-state';
import {classroomTaskContextSchema,validateClassroomContext,type ClassroomTaskContext} from './domain/classroom-context';
import type {PageObject} from './types';

export type ClassroomPointInput={contextKey:string;objectId:string};
export type ClassroomPointRequest={type:'interaction.point';eventId:string;context:ClassroomTaskContext;objectId:string};
export type ConfirmedClassroomPoint={request:ClassroomPointRequest;acceptedAtMs:number};
export const CLASSROOM_POINT_RECALL_MS=30000;
const requestSchema=z.object({
 type:z.literal('interaction.point'),eventId:z.string().uuid(),context:classroomTaskContextSchema,
 objectId:z.string().min(1).max(100).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value)),
}).strict();

/** Captures a received point without replacing the sender's task or grading a selection. */
export function captureClassroomPoint(snapshot:Parameters<typeof captureClassroomToolState>[0],input:unknown):
 {accepted:true;request:ClassroomPointRequest;object:PageObject}|{accepted:false}{
 const request=requestSchema.safeParse(input),current=captureClassroomToolState(snapshot);
 if(!request.success||!current.ok||!validateClassroomContext(current.snapshot,request.data.context).accepted)return {accepted:false};
 const step=snapshot.course.steps[snapshot.stepIndex];
 if(step.kind==='select')return {accepted:false};
 const object=snapshot.course.pages.find(page=>page.id===step.pageId)?.objects.find(candidate=>candidate.id===request.data.objectId);
 return object?{accepted:true,request:request.data,object}:{accepted:false};
}

/** Revalidates a new unscored gesture; speech, answers and persisted actions still require exact revisions. */
export function resolveClassroomPointIntent(snapshot:Parameters<typeof captureClassroomToolState>[0],input:unknown):ReturnType<typeof captureClassroomPoint>{
 const request=requestSchema.safeParse(input),current=captureClassroomToolState(snapshot);
 if(!request.success||!current.ok||request.data.context.stateRevision>current.snapshot.context.stateRevision)return {accepted:false};
 const context={...request.data.context,stateRevision:current.snapshot.context.stateRevision};
 return captureClassroomPoint(snapshot,{...request.data,context});
}

/** The verified gesture is useful conversation context, even if its separate reply was interrupted. */
export function recallClassroomPoint(snapshot:Parameters<typeof captureClassroomToolState>[0],point:ConfirmedClassroomPoint|null,now:number){
 if(!point||!Number.isSafeInteger(now)||!Number.isSafeInteger(point.acceptedAtMs)||now<point.acceptedAtMs||now-point.acceptedAtMs>=CLASSROOM_POINT_RECALL_MS)return null;
 const current=resolveClassroomPointIntent(snapshot,point.request);
 return current.accepted?current:null;
}

export function requestedClassroomPointRecall(text:string):'zh'|'en'|null{
 if(text.length>120)return null;
 const value=text.normalize('NFKC').trim().replace(/[.!?。！？]+$/u,'').trim().toLowerCase().replace(/\s+/g,' ');
 if(/^(?:please tell me )?what(?: part| object)? did i (?:just )?(?:point (?:to|at)|(?:click|tap)(?: on)?)(?: just now)?$/u.test(value))return 'en';
 if(/^(?:请问[,，]?)?我(?:刚刚|刚才|刚)(?:在(?:这|图|教材)上)?(?:点选|点击|点|指)(?:了)?(?:的是|的)?(?:什么|哪个(?:部位|地方|东西)?|哪儿|哪里|哪一块)(?:吗)?$/u.test(value.replace(/\s/g,'')))return 'zh';
 return null;
}
