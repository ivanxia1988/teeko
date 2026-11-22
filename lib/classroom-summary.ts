import type { ClassroomSnapshot } from './classroom-contract';
import {isReadingStep} from './classroom-reading';

export type ClassroomSummary = {
 headline: string; description: string;
 completed: {stepId:string;label:string;status:'independent'|'assisted'}[];
 browsed: {stepId:string;label:string}[]; reading:boolean;
 practice: {stepId:string;label:string;reason:string}[];
 nextStep: string; empty: boolean;
};

/** A factual recap of saved task outcomes, independent of any generated report. */
export function buildClassroomSummary(state:ClassroomSnapshot):ClassroomSummary {
 const completed:ClassroomSummary['completed']=[],browsed:ClassroomSummary['browsed']=[],practice:ClassroomSummary['practice']=[],seen=new Set<string>();
 const reading=state.course.steps.length>0&&state.course.steps.every(isReadingStep);
 for(const outcome of state.outcomes){
  const step=state.course.steps.find(item=>item.id===outcome.stepId);
  if(!step||seen.has(step.id))continue;
  seen.add(step.id);
  const label=step.chinese||step.english;
  if(isReadingStep(step)){
   if(step.kind!=='listen'&&outcome.status==='unassessed')browsed.push({stepId:step.id,label});
   if(outcome.status==='skipped')practice.push({stepId:step.id,label,reason:'这次选择跳过，有兴趣时再试；不据此判断能力。'});
   continue;
  }
  if(step.kind==='listen'||outcome.status==='unassessed')continue;
  if(outcome.status==='independent'||outcome.status==='assisted')completed.push({stepId:step.id,label,status:outcome.status});
  if(outcome.status==='assisted')practice.push({stepId:step.id,label,reason:'这次在提示后完成，下次可以先自己试一次。'});
  if(outcome.status==='skipped')practice.push({stepId:step.id,label,reason:'这次选择跳过，有兴趣时再试；不据此判断能力。'});
 }
 const empty=completed.length===0&&browsed.length===0&&practice.length===0;
 const reason=state.endReason==='content_completed'?'本课练习已完成。':state.endReason==='time_limit'?'本次课堂时间已到，进度已保留。':state.endReason==='daily_limit'?'今日练习时间已用完，进度已保留。':'本次中途结束，进度已保留。';
 const next=state.course.steps[state.stepIndex];
 const nextStep=practice[0]?`下次可以试试：${practice[0].label}。`:next&&state.endReason!=='content_completed'?`下次可以接着：${next.chinese||next.english}。`:'下次可以换一种情景，把今天的表达用起来。';
 const description=reason+(reading?empty?'还没有足够的带读记录，不评价理解或掌握。':'以下仅记录浏览和跳过的活动，不评价理解或掌握。':empty?'目前还没有足够的答题记录，不评价掌握情况。':'以下内容来自本次课堂记录。');
 return {headline:'这节课已保存',description,completed,browsed,reading,practice,nextStep,empty};
}
