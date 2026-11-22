import assert from 'node:assert/strict';
import test from 'node:test';
import {LAB_GUIDE_PAGE_IDS,labGuidePlan,RobotPredictionGuide} from '../lib/interaction-lab-guide';
import {labTextTarget} from '../lib/interaction-lab-textbook';
import {ROBOT_READING_COURSE} from '../lib/server/robot-reading-course';

test('guided reading resolves different teacher prompts and valid target IDs for each page',()=>{
 assert.deepEqual(LAB_GUIDE_PAGE_IDS,['robot-predict','robot-read']);
 for(const pageId of LAB_GUIDE_PAGE_IDS){
  const page=ROBOT_READING_COURSE.pages.find(page=>page.id===pageId);
  const plan=labGuidePlan(pageId);
  assert(page&&plan);
  assert(plan.instructions.includes(`Current page teaching plan (${pageId})`));
  assert.match(plan.instructions,/current contextKey/);
  assert.match(plan.instructions,/one question.*listen/i);
  assert.equal(new Set(plan.targetIds).size,plan.targetIds.length);
  for(const id of plan.targetIds){
   assert(page.objects.some(object=>object.id===id)||pageId==='robot-predict'&&labTextTarget(id),id);
   assert(plan.instructions.includes(id),id);
  }
 }
});

test('prediction has an application-directed opening while the reading page uses its native highlight tool',()=>{
 const prediction=labGuidePlan('robot-predict')!;
 const reading=labGuidePlan('robot-read')!;
 assert.equal(new RobotPredictionGuide().opening().target,'passage-machine');
 assert.match(reading.openingCue,/highlight_objects.*wings.*before speaking/i);
 assert.match(prediction.instructions,/do not reveal swimming/i);
 assert.match(reading.instructions,/transition.*change/i);
 assert.match(reading.instructions,/Notice the wings as the robot makes its transition from flying to swimming\./);
 assert.equal(prediction.targetIds.includes('title-machine'),false);
 assert.equal(reading.targetIds.includes('passage-machine'),false);
 assert.equal(labGuidePlan('robot-design'),null);
 assert.equal(labGuidePlan('__proto__'),null);
});

test('robot prediction guides one visible target at a time, waits, and reacts to the actual clicked part',()=>{
 const guide=new RobotPredictionGuide();
 assert.equal(guide.playbackEnded()?.target,'body');
 const question=guide.playbackEnded();
 assert.equal(question?.beat,'invite');
 assert.equal(question?.clear,true);
 assert.equal(guide.playbackEnded(),undefined);
 assert.equal(guide.beat,'waiting');
 const wing=guide.pointed('wings');
 assert.match(wing,/lift/i);
 assert.equal(guide.playbackEnded(),undefined);
 const tail=guide.pointed('tail');
 assert.match(tail,/steer/i);
 assert.notEqual(wing,tail);
 assert.equal(guide.playbackEnded(),undefined);
 assert.equal(guide.beat,'waiting');
});

test('interruptions restore the exact unfinished activity, including waiting for a learner-selected part',()=>{
 const guide=new RobotPredictionGuide();
 guide.playbackEnded();
 guide.interrupt();
 assert.equal(guide.question('What does clue mean?').target,'passage-clues');
 guide.interrupt();
 assert.equal(guide.question('请再解释一下').target,undefined);
 assert.equal(guide.playbackEnded()?.target,'body');
 assert.equal(guide.playbackEnded()?.beat,'invite');
 assert.equal(guide.playbackEnded(),undefined);
 guide.interrupt();
 assert.equal(guide.question('what does machine mean?').target,'passage-machine');
 assert.equal(guide.playbackEnded()?.beat,'invite');
 assert.equal(guide.playbackEnded(),undefined);
 guide.interrupt();
 guide.question('what is a clue?');
 guide.pointed('tail');
 assert.equal(guide.playbackEnded(),undefined);
 assert.equal(guide.beat,'waiting');
});
