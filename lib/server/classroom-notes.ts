import {z} from 'zod';
import type {ClassroomSnapshot} from '../classroom-contract';
import {teacherAssessmentResultSchema} from '../teacher-instructions';
import {sanitizeClassroomJournalText} from '../classroom-journal';
import {classroomNoteSchema,type ClassroomNote} from '../classroom-notes';
const identifier=z.string().min(1).max(200).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value));
const timestamp=z.string().datetime(),epoch=z.number().int().positive().safe();
const sourceSchema=z.object({epoch,itemId:identifier,stepIndex:z.number().int().nonnegative().safe(),transcriptText:z.string().min(1).max(1000),transcriptSource:z.enum(['speech','typed']),transcriptAt:timestamp,contextKey:z.string().max(200),decisionAt:timestamp,decision:teacherAssessmentResultSchema}).strict();

/** Saved text plus a linked proposal, never a transcript of actual teacher playback or a diagnosis. */
export function buildClassroomNote(snapshot:Pick<ClassroomSnapshot,'id'|'course'|'connectionEpoch'>,input:unknown):ClassroomNote|null{
 const parsed=sourceSchema.safeParse(input);if(!parsed.success)return null;
 const value=parsed.data,step=snapshot.course.steps[value.stepIndex],reference=value.decision.suggestedResponse;
 if(value.epoch>snapshot.connectionEpoch||!step||!snapshot.course.pages.some(page=>page.id===step.pageId)||value.contextKey!==`${snapshot.id}:${value.epoch}:${value.stepIndex}`||value.decision.confidence!=='high'||value.decision.nextAction!=='model'||reference.length>180||/[\u0000-\u001f\u007f]/u.test(reference)||sanitizeClassroomJournalText(reference,180)!==reference||Date.parse(value.decisionAt)<Date.parse(value.transcriptAt))return null;
 const original=sanitizeClassroomJournalText(value.transcriptText,1000).trim();if(!original)return null;
 const note=classroomNoteSchema.safeParse({id:`${value.epoch}:${value.itemId}`,step:{id:step.id,label:(step.chinese||step.english).slice(0,180)},original:{text:original.slice(0,300),excerpt:original.length>300,source:value.transcriptSource,recordedAt:value.transcriptAt},reference:{text:reference,kind:'generated_teaching_reference',createdAt:value.decisionAt},origin:{connectionEpoch:value.epoch,itemId:value.itemId}});
 return note.success?note.data:null;
}
