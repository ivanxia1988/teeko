import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TopicPromptPanel} from '../components/topics/topic-prompt-preview';
import {TOPIC_PICNIC_COURSE, TOPIC_ROBOT_COURSE} from '../lib/server/topic-courses';
import {loadTopicPromptPreview} from '../lib/server/topic-prompt-preview';
import {spokenUpdate} from '../lib/live-agent';
import {CLASSROOM_SILENCE_CUE} from '../lib/classroom-cues';
import {LIVE_ROBOT_HIGHLIGHT_TOOL} from '../lib/server/classroom-live-highlight';
import {bundledTopicContent} from '../lib/server/topic-content';

const owner = 'e487b951-9846-4921-8cbe-446430defa8c';
const ordinary = 'e487b951-9846-4921-8cbe-446430defa8d';

test('packaged GPT opening and page change cues retain the current passage in the actual spoken byte budget',async()=>{
  const {courses}=await bundledTopicContent();
  const course=courses.find(course=>course.id==='whale-snot-drones');
  assert(course);
  const preview=await loadTopicPromptPreview(course.id,owner,[owner],async()=>({course,teacher:null}));
  assert(preview);
  assert.match(spokenUpdate(preview.activities[0].opening), /visible mark on "blow \(spray\)".*A humpback whale/);
  assert.match(preview.activities[1].advance ?? '', /visible mark on "news passage".*58 samples from 26 whales/);
  assert.doesNotMatch(preview.activities[1].advance ?? '', /visible mark on "blow/);
});

test('topic prompt preview only reads a published topic for an allowed signed in account', async () => {
  let reads = 0;
  const read = async () => { reads++; return {course: TOPIC_ROBOT_COURSE, teacher: null}; };
  for (const account of [null, ordinary]) {
    assert.equal(await loadTopicPromptPreview('topic-robot', account, [owner], read), undefined);
  }
  assert.equal(await loadTopicPromptPreview('../picnic', owner, [owner], read), undefined);
  assert.equal(await loadTopicPromptPreview('topic-robot', owner, [owner, 'invalid'], read), undefined);
  assert.equal(reads, 0);
  const result = await loadTopicPromptPreview('topic-robot', owner, [owner], read);
  assert.equal(reads, 1);
  assert.equal(result?.activities.length, 5);
  assert.match(result!.activities[0].instructions, /Describe the machine and visibly point to wings/);
  assert.match(result!.activities[0].opening, /Begin without waiting for the learner to speak/);
  assert.match(result!.activities[2].advance!, /This robot can fly and swim/);
  assert.equal(result!.silenceCue, spokenUpdate(CLASSROOM_SILENCE_CUE));
});

test('prompt preview accepts a published course package and rejects an unmarked legacy course', async () => {
  const course = {...TOPIC_PICNIC_COURSE, id: 'seabird-flights'};
  const readLegacy = async () => ({course, teacher: null});
  assert.equal(await loadTopicPromptPreview(course.id, owner, [owner], readLegacy), undefined);
  const result = await loadTopicPromptPreview(course.id, owner, [owner], async () => ({
    course: {...course, topic: {category: 'science', difficulty: 'starter'}},
    teacher: null,
  }));
  assert.ok(result);
  assert.equal(result.activities.length, course.steps.length);
  assert.match(result.activities[0].instructions, /TOPIC LEARNING/);
});

test('the robot preview shows the complete wire registration and original prompt text', async () => {
  const read = async () => ({
    course: TOPIC_ROBOT_COURSE,
    teacher: null,
    preferences: {provider:'openai',language:'english',style:'strict',voice:'female',soundEffects:false} as const,
  });
  const result = await loadTopicPromptPreview('topic-robot', owner, [owner], read);
  assert.ok(result);
  const delegation = JSON.parse(result.registrationJson);
  assert.equal(delegation.type, 'responses');
  assert.equal(delegation.acknowledgement_delay_ms, 800);
  assert.equal(delegation.responses.model, 'gpt-6-luna');
  assert.deepEqual(delegation.responses.tools, [LIVE_ROBOT_HIGHLIGHT_TOOL]);
  assert.equal(result.activities[0].backendInstructions, delegation.responses.instructions);
  assert.match(result.activities[0].instructions, /NON-OVERRIDABLE CLASSROOM RULES\nYou are Teeko/);
  assert.match(result.activities[0].instructions, /English only/);
  assert.match(result.activities[0].instructions, /Style=strict/);
  assert.match(result.activities[0].instructions, /"childName":"Learner"/);
  assert.equal(JSON.parse(result.activities[2].contextUpdate!).task.id, 'robot-discovery');
  const rendered = renderToStaticMarkup(createElement(TopicPromptPanel, {preview: result}));
  assert.match(rendered, /GPT Live 工具注册/);
  assert.match(rendered, /highlight_objects/);
  assert(rendered.indexOf('highlight_objects') < rendered.indexOf('NON-OVERRIDABLE CLASSROOM RULES'));
  assert.equal(await loadTopicPromptPreview('topic-robot', ordinary, [owner], read), undefined);
  const picnic = await loadTopicPromptPreview('topic-picnic', owner, [owner], async () => ({course: TOPIC_PICNIC_COURSE, teacher: null}));
  assert.ok(picnic);
  assert.deepEqual(JSON.parse(picnic.registrationJson), {type:'client', acknowledgement_delay_ms:800});
});
