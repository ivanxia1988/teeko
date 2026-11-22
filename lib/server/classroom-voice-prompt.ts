import type {ClassroomSnapshot} from '../classroom-contract';
import {classroomInitialCue, GPT_ROBOT_HIGHLIGHT_MODEL, GPT_ROBOT_HIGHLIGHT_POLICY, gptRobotHighlightCue} from '../classroom-cues';
import type {FrozenTeacherConfig} from '../teacher-agent';
import {buildTeacherInstructions, type TeacherTeachingState} from '../teacher-instructions';
import {liveHighlightDelegation} from './classroom-live-highlight';

export function buildClassroomVoicePrompt(snapshot: ClassroomSnapshot, model: string, teacher: FrozenTeacherConfig | null, state?: TeacherTeachingState) {
  const step = snapshot.course.steps[snapshot.stepIndex];
  const robotTools = snapshot.preferences.provider === 'openai' && model === 'gpt-live-1' &&
    snapshot.course.id === 'topic-robot' && snapshot.course.version === '1';
  const instructions = buildTeacherInstructions(snapshot, teacher, state);
  return {
    instructions: robotTools ? `${instructions}\n\n${GPT_ROBOT_HIGHLIGHT_POLICY}` : instructions,
    initialCue: (robotTools ? gptRobotHighlightCue(step?.id) : null) ?? classroomInitialCue(step?.english ?? 'Listen to the learner.'),
    highlightModel: robotTools ? GPT_ROBOT_HIGHLIGHT_MODEL : null,
  };
}

export function gptClassroomDelegation(snapshot: ClassroomSnapshot, highlightModel?: string | null) {
  return highlightModel
    ? {...liveHighlightDelegation(highlightModel, snapshot), acknowledgement_delay_ms: 800}
    : {type: 'client' as const, acknowledgement_delay_ms: 800};
}

export function gptClassroomContextText(snapshot: ClassroomSnapshot, contextKey: string, teachingGuidance?: string) {
  const step = snapshot.course.steps[snapshot.stepIndex];
  return JSON.stringify({
    contextKey,
    revision: snapshot.revision,
    courseVersion: snapshot.course.version,
    task: step ? {id: step.id, kind: step.kind, prompt: step.english} : null,
    objects: snapshot.course.pages.find(page => page.id === step?.pageId)?.objects.map(({id,label}) => ({id,label})),
    teacherObjectIds: snapshot.teacherObjectIds,
    ...(teachingGuidance ? {teachingGuidance: teachingGuidance.slice(0,2400)} : {}),
    feedback: snapshot.feedback ? {kind: snapshot.feedback.kind, message: snapshot.feedback.message.slice(0,240)} : null,
  });
}
