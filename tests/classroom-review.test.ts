import test from 'node:test';
import assert from 'node:assert/strict';
import {requestedClassroomReview,buildClassroomReviewReference} from '../lib/classroom-review';
import {buildClassroomNote} from '../lib/server/classroom-notes';
import {teacherSnapshot} from './teacher-runtime-fixture';
test('only explicit complete requests authorize a lesson-note review',()=>{
 for(const text of ["Let's review.",'Can we review this lesson?','Please recap our notes.','Review my notes.','What did we learn today?','请复习一下这节课的表达。','我们回顾一下今天学过的句子吧！','复习一下'])assert.equal(requestedClassroomReview(text),true,text);
 for(const text of ['review','recap',"I don't want to review.",'Do not recap.','My friend said let us review.','Can we rev','Review the picture.','Review the bill.','I like apples.','不要复习','我不想回顾今天','他让我们复习一下','复习一下，然后停止',' '.repeat(1001),'x'.repeat(1001)])assert.equal(requestedClassroomReview(text),false,text.slice(0,80));
});
test('review reference is bounded source data and never invents grades or teacher playback',()=>{
 const snapshot=teacherSnapshot(),note=buildClassroomNote(snapshot,{epoch:1,itemId:'source',stepIndex:1,transcriptText:'I likes apples.',transcriptSource:'speech',transcriptAt:snapshot.startedAt,contextKey:`${snapshot.id}:1:1`,decisionAt:snapshot.startedAt,decision:{decision:'retry',confidence:'high',reason:'PRIVATE_REASON',suggestedResponse:'I like apples.',nextAction:'model'}});assert(note);
 const output=buildClassroomReviewReference(Array(5).fill(note),'captured_sources');assert.equal(output.status,'reference');assert(output.english.length<=6000);assert(output.english.includes('I likes apples.'));assert(output.english.includes('I like apples.'));assert(!output.english.includes('PRIVATE_REASON'));assert(output.english.includes('not a grade'));assert(output.english.includes('optional'));assert.match(output.english,/start with one short generated reference/iu);assert(output.english.includes('If saved source pairs exist'));assert.equal((output.english.match(/generatedReference/g)??[]).length,3);
 const empty=buildClassroomReviewReference([],'retained_sources');assert(empty.english.includes('No saved expression'));assert(!empty.english.includes('I like apples.'));
});
