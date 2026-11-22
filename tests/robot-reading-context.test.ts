import test from 'node:test';
import assert from 'node:assert/strict';
import type {ClassroomSnapshot,PublishedCourse} from '../lib/classroom-contract';
import type {LessonStep} from '../lib/types';
import {classroomReadingReference,courseReadingSource,isOpenClassroomConversation,isReadingRecital,isReadingStep} from '../lib/classroom-reading';

const passage='A classroom machine moves above the clouds and below the water.';
const step={id:'read-capabilities',kind:'speak',targetId:null,pageId:'read',english:'What else can it do?',chinese:'说出另一种运动',hint:'Look at the final word.',expected:null,reading:{phase:'read',passage,goal:'Explain the two ways it moves.',teacherNotes:'Silent reading and listening are welcome. Reading aloud alone is not understanding.',followUp:'Which part helps it move?'}} as LessonStep;
const course={id:'fixture',version:'1',title:'Fixture',subtitle:'Reading',description:'Fixture',durationMinutes:20,words:['wing'],objectives:[],pages:[],steps:[step],reading:{sourceTitle:'DOGOnews',sourceUrl:'https://www.dogonews.com/example',attribution:'Short excerpt and original Teeko practice.'}} as PublishedCourse;

test('reading activities are optional and terminal conversations preserve the existing picnic flow',()=>{
 assert.equal(isReadingStep(step),true);assert.equal(isReadingStep({...step,reading:undefined}),false);
 assert.equal(isOpenClassroomConversation({...step,kind:'listen',reading:{...step.reading!,phase:'chat'}}),true);
 assert.equal(isOpenClassroomConversation({...step,id:'picnic-chat',kind:'listen',reading:undefined}),true);
 assert.equal(isOpenClassroomConversation(step),false);assert.equal(isOpenClassroomConversation(undefined),false);
});

test('only an extended exact recital is recognized; a short independently expressed answer stays available',()=>{
 assert.equal(isReadingRecital(step,passage),true);assert.equal(isReadingRecital(step,passage.toUpperCase().replaceAll('.','!')),true);
 assert.equal(isReadingRecital(step,'It can fly and swim.'),false);assert.equal(isReadingRecital(step,'Wings.'),false);
 assert.equal(isReadingRecital({...step,reading:undefined},passage),false);
});

test('the teacher receives the current bounded reading reference and never an adjacent page',()=>{
 const snapshot={course,stepIndex:0} as ClassroomSnapshot;
 const reference=classroomReadingReference(snapshot)!;
 assert.equal(reference.passage,passage);assert.equal(reference.phase,'read');assert.equal(reference.goal,step.reading!.goal);
 const oversized={...step,reading:{...step.reading!,teacherNotes:'n'.repeat(4000),followUp:'f'.repeat(4000)}};
 const bounded=classroomReadingReference({...snapshot,course:{...course,steps:[oversized]}})!;
 assert(bounded.teacherNotes.length<=380);assert(bounded.followUp.length<=160);
 assert.equal(classroomReadingReference({...snapshot,stepIndex:1}),null);
});

test('source links are explicit HTTPS references without credentials or unsafe schemes',()=>{
 assert.deepEqual(courseReadingSource(course),course.reading);
 for(const sourceUrl of ['javascript:alert(1)','http://www.dogonews.com/example','https://user:password@example.test/article'])assert.equal(courseReadingSource({...course,reading:{...course.reading!,sourceUrl}}),null);
 assert.equal(courseReadingSource({...course,reading:undefined}),null);
});
