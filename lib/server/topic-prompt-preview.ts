import type {ClassroomPreferences, ClassroomSnapshot, PublishedCourse} from '../classroom-contract';
import {classroomAdvanceCue, CLASSROOM_SILENCE_CUE, gptRobotHighlightCue} from '../classroom-cues';
import {sanitizeClassroomJournalText} from '../classroom-journal';
import {spokenUpdate} from '../live-agent';
import type {FrozenTeacherConfig} from '../teacher-agent';
import {buildTeacherGuidance, readTeachingState} from '../teacher-instructions';
import {isTopicCourse, topicIdSchema} from '../topic-learning';
import type {TopicPromptPreview} from '../topic-prompt-preview';
import {buildClassroomVoicePrompt, gptClassroomContextText, gptClassroomDelegation, packagedTopicEntryCue} from './classroom-voice-prompt';
import {diagnosticEntryAllowlist} from './diagnostic-entry';

type Publication = {
  course: PublishedCourse;
  teacher: FrozenTeacherConfig | null;
  profile?: Pick<ClassroomSnapshot['profile'], 'ageRange' | 'level'> | null;
  preferences?: ClassroomPreferences | null;
  defaultVoiceModel?: string;
};

export async function loadTopicPromptPreview(
  topicId: string,
  accountId: string | null,
  enabledAccountIds: readonly string[],
  readPublished: (topicId: string) => Promise<Publication | null>,
): Promise<TopicPromptPreview | undefined> {
  if (!topicIdSchema.safeParse(topicId).success || !accountId || !diagnosticEntryAllowlist(enabledAccountIds).has(accountId.toLowerCase())) return;
  const published = await readPublished(topicId);
  if (!published || published.course.id !== topicId || !isTopicCourse(published.course)) return;

  const {course} = published;
  const release = published.teacher;
  const teacher = release && {...release, systemPrompt: sanitizeClassroomJournalText(release.systemPrompt, 8000)};
  const voiceModel = release ? release.routes.openai?.realtime.model : published.defaultVoiceModel || 'gpt-live-1';
  const duration = course.sessionLimitSeconds ?? course.durationMinutes * 60;
  const sample: ClassroomSnapshot = {
    id: '00000000-0000-4000-8000-000000000001', course,
    profile: {ageRange: '10–11', level: 'unsure', ...published.profile, name: 'Learner'},
    preferences: {language:'bilingual', style:'gentle', voice:'female', soundEffects:true, ...published.preferences, provider:'openai'},
    status: 'active', revision: 1, connectionEpoch: 1, stepIndex: 0,
    elapsedSeconds: 0, remainingSeconds: duration, maxSeconds: duration,
    outcomes: [], teacherObjectIds: [], feedback: null, endReason: null,
    startedAt: '2000-01-01T00:00:00.000Z', endedAt: null, reportStatus: 'unavailable',
  };
  const initial = buildClassroomVoicePrompt(sample, voiceModel ?? '', teacher);
  const delegation = voiceModel ? gptClassroomDelegation(sample, initial.highlightModel) : null;
  return {
    voiceModel: voiceModel ?? '未启用',
    registrationJson: JSON.stringify(delegation, null, 2),
    silenceCue: spokenUpdate(CLASSROOM_SILENCE_CUE),
    activities: voiceModel ? course.steps.map((step, stepIndex) => {
      const snapshot = {...sample, stepIndex, revision: stepIndex + 1,
        teacherObjectIds: course.topic && step.targetId ? [step.targetId] : []};
      const state = readTeachingState({}, snapshot.profile.level);
      const prompt = buildClassroomVoicePrompt(snapshot, voiceModel, teacher, state);
      const activityDelegation = gptClassroomDelegation(snapshot, prompt.highlightModel);
      const opensWithTool = prompt.highlightModel && gptRobotHighlightCue(step.id);
      const page = course.pages.findIndex(item => item.id === step.pageId) + 1;
      const guidance = buildTeacherGuidance(snapshot, teacher, state);
      return {
        id: step.id,
        label: `第 ${page} 页 · ${step.chinese || step.english}`,
        instructions: prompt.instructions,
        opening: prompt.initialCue,
        ...(activityDelegation.type === 'responses' ? {backendInstructions: activityDelegation.responses.instructions} : {}),
        contextUpdate: gptClassroomContextText(snapshot, `${sample.id}:${sample.connectionEpoch}:${stepIndex}`, guidance),
        ...(stepIndex > 0 && !opensWithTool ? {advance: spokenUpdate(packagedTopicEntryCue(snapshot)??classroomAdvanceCue(step.english))} : {}),
      };
    }) : [],
  };
}
