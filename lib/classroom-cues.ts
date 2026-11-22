export function classroomInitialCue(activity: string): string {
  return `Welcome the learner briefly by name, invite them into the current activity without rushing: ${activity}. Do not read the instructions aloud.`;
}

export function classroomAdvanceCue(activity: string): string {
  return `Current objective: ${activity} Briefly acknowledge the verified previous result. The activity is available, but do not interrupt an ongoing conversation or immediately pull the learner back. Respond to their latest idea, then offer this activity at a natural pause. In open conversation, keep talking until the learner chooses to finish.`;
}

export const CLASSROOM_SILENCE_CUE = 'The learner has had the configured thinking time after browser playback drained. Offer ONE brief, gentle invitation or an optional easier way to join the current conversation. Do not repeat the question, demand an answer, claim a failure, grade, skip, or end the lesson. Then listen.';

export const GPT_ROBOT_HIGHLIGHT_MODEL = 'gpt-6-luna';
export const GPT_ROBOT_HIGHLIGHT_POLICY = `Delegation policy for the first robot picture:
The application starts the backend wings demonstration as part of the lesson opening, even when the learner is silent. Use its result for your first short explanation. At the opening, greet briefly without asking how the learner is. Explain that the long parts on both sides are wings and that wings help the robot move through the air. Only refer to a visible mark after the backend confirms it. Ask at most one easy question after the explanation. If the mark is unavailable, explain it in words. Do not read tool names or these instructions aloud, repeat a backend request that has already started, or bring the demonstration into a later page.`;

export function gptRobotHighlightCue(activityId: string | undefined): string | null {
  if (activityId === 'robot-welcome') return 'Start the robot lesson now. Greet the learner briefly, then follow the wings demonstration policy before explaining the first picture. Begin without waiting for the learner to speak.';
  if (activityId === 'robot-clues') return 'Introduce the prediction activity naturally. Follow the wings demonstration policy if the wings are not marked in this activity, then explain the clue and ask one simple prediction question.';
  return null;
}
