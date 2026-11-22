import {z} from 'zod';
import {classroomTaskContextSchema} from '../domain/classroom-context';
import {teacherAssessmentResultSchema} from '../teacher-instructions';
import {sanitizeClassroomJournalText} from '../classroom-journal';
const evidenceItemId=z.string().min(1).max(200).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value));
const text=z.string().min(1).max(120).refine(value=>value.trim()===value&&value.length>0&&!/[\u0000-\u001f\u007f]/u.test(value)&&sanitizeClassroomJournalText(value,120)===value);
const candidateSchema=z.object({context:classroomTaskContextSchema,evidenceItemId,text,seconds:z.literal(8)}).strict().readonly();
export type ClassroomChalkCandidate=z.infer<typeof candidateSchema>;
export function parseClassroomChalkCandidate(input:unknown):ClassroomChalkCandidate|null{const parsed=candidateSchema.safeParse(input);return parsed.success?parsed.data:null;}
const sourceSchema=z.object({context:classroomTaskContextSchema,evidenceItemId,decision:teacherAssessmentResultSchema,hints:z.number().int().min(2).safe()}).strict();
/** An existing supported retry, never an assessment made by the display itself. */
export function buildClassroomChalkCandidate(input:unknown):ClassroomChalkCandidate|null{
 const parsed=sourceSchema.safeParse(input);if(!parsed.success)return null;
 const {context,evidenceItemId,decision}=parsed.data;
 if(decision.decision!=='retry'||decision.confidence!=='high'||decision.nextAction!=='model')return null;
 return parseClassroomChalkCandidate({context,evidenceItemId,text:decision.suggestedResponse,seconds:8});
}
export function spokenChalkReference(utterance:string,reference:string):boolean{
 const words=(value:string)=>value.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
 const target=words(reference);return !!target&&` ${words(utterance)} `.includes(` ${target} `);
}
