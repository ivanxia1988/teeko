import type {ClassroomSnapshot,PublishedCourse} from './classroom-contract';
import type {LessonStep,ReadingActivity} from './types';

export function isReadingStep(step:LessonStep|undefined):step is LessonStep&{reading:ReadingActivity}{return !!step?.reading;}
export function isOpenClassroomConversation(step:LessonStep|undefined){return !!step&&step.kind==='listen'&&(step.id==='picnic-chat'||step.reading?.phase==='chat');}
const normalize=(text:string)=>text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
/** A long verbatim recital is participation, never evidence of understanding. */
export function isReadingRecital(step:LessonStep|undefined,text:string){
 if(!isReadingStep(step))return false;
 const input=normalize(text),passage=normalize(step.reading.passage);
 return passage.split(' ').length>=8&&input===passage;
}
/** The same small reference reaches live speech and semantic assessment. */
export function classroomReadingReference(snapshot:ClassroomSnapshot):ReadingActivity|null{
 const step=snapshot.course.steps[snapshot.stepIndex];if(!isReadingStep(step))return null;
 const reading=step.reading;
 return{phase:reading.phase,passage:reading.passage.slice(0,500),goal:reading.goal.slice(0,260),teacherNotes:reading.teacherNotes.slice(0,380),followUp:reading.followUp.slice(0,160)};
}
export function courseReadingSource(course:Pick<PublishedCourse,'reading'>):NonNullable<PublishedCourse['reading']>|null{
 const source=course.reading;if(!source||!source.sourceTitle.trim()||source.sourceTitle.length>200||source.attribution.length>300||source.sourceUrl.length>2048)return null;
 try{const url=new URL(source.sourceUrl);return url.protocol==='https:'&&!url.username&&!url.password?source:null;}catch{return null;}
}
