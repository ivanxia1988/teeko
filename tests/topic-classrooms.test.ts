import test from 'node:test';
import assert from 'node:assert/strict';
import {TOPIC_CATALOG,isTopicCourseId,topicCatalogResponseSchema,parseTopicHistoryQuery,encodeTopicHistoryCursor} from '../lib/topic-learning';
import {TOPIC_COURSES} from '../lib/server/topic-courses';

test('published topics have matching public material and only voice activities',()=>{
 assert.equal(TOPIC_COURSES.length,2);
 assert.equal(topicCatalogResponseSchema.safeParse({ok:true,topics:TOPIC_CATALOG}).success,true);
 for(const course of TOPIC_COURSES){
  const card=TOPIC_CATALOG.find(item=>item.id===course.id);assert(card);assert.equal(card.title,course.title);
  assert.equal(card.preview.image,course.pages[0].image);assert.equal(course.version,'1');
  assert(course.steps.every(step=>step.kind!=='select'&&step.reading&&step.expected===null));
  assert(course.steps.every(step=>step.reading!.teacherNotes.startsWith('Voice only.')));
  assert(course.steps.every(step=>course.pages.some(page=>page.id===step.pageId)));
  assert.equal(course.steps.at(-1)?.reading?.phase,'chat');
 }
 assert.equal(TOPIC_COURSES[0].pages.length,2);
 assert.equal(isTopicCourseId('topic-robot'),true);assert.equal(isTopicCourseId('picnic'),false);assert.equal(isTopicCourseId('topic-unknown'),false);
});

test('topic history cursor is bounded and rejects invalid or injected queries',()=>{
 const cursor=encodeTopicHistoryCursor({endedAt:'2026-11-21T00:00:00.000Z',id:'00000000-0000-4000-8000-000000000001'});
 const parsed=parseTopicHistoryQuery({cursor,pageSize:'6'});assert(parsed.ok);assert.equal(parsed.query.cursor?.endedAt,'2026-11-21T00:00:00.000Z');
 for(const query of [{cursor:'bad'},{cursor:'x'.repeat(1025)},{pageSize:0},{pageSize:21},{pageSize:1.5},{accountId:'other'},{offset:0}])assert.equal(parseTopicHistoryQuery(query).ok,false);
 assert.equal(parseTopicHistoryQuery({}).ok,true);
});
