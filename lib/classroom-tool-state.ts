import type { ClassroomSnapshot } from './classroom-contract';
import { captureClassroomState, type ClassroomStateCapture } from './domain/classroom-context';

type ToolSnapshot = Pick<ClassroomSnapshot, 'id' | 'course' | 'status' | 'revision' | 'connectionEpoch' | 'stepIndex'>;

/** Call only with an authenticated application snapshot; a legacy contextKey cannot supply these facts. */
export function captureClassroomToolState(snapshot: ToolSnapshot): ClassroomStateCapture {
  if (!Number.isSafeInteger(snapshot.stepIndex) || snapshot.stepIndex < 0) return { ok: false, reason: 'invalid_state' };
  const step = snapshot.course.steps[snapshot.stepIndex];
  if (!step || !snapshot.course.pages.some(page => page.id === step.pageId)) return { ok: false, reason: 'invalid_state' };
  return captureClassroomState({ status: snapshot.status, context: {
    logicalSessionId: snapshot.id, courseVersion: `${snapshot.course.id}:${snapshot.course.version}`,
    connectionEpoch: snapshot.connectionEpoch, stateRevision: snapshot.revision, pageId: step.pageId, activityId: step.id,
  } });
}
