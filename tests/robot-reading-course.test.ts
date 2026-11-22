import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import type {Pool} from 'pg';
import type {PublishedCourse} from '../lib/classroom-contract';
import * as catalog from '../lib/server/course-catalog';

type ReadingCourse=PublishedCourse&{reading:{sourceTitle:string;sourceUrl:string;attribution:string};sessionLimitSeconds:number};
const getCourse=()=>{
 const course=(catalog as unknown as Record<string,unknown>).ROBOT_READING_COURSE as ReadingCourse|undefined;
 assert(course,'the reviewed robot reading course is published in the real catalog');return course;
};
const normalized=(value:string)=>value.replace(/\s+/g,' ').trim();

test('robot reading is a separate versioned twenty-minute course with eight ungraded stages',()=>{
 const course=getCourse();assert.equal(course.id,'robot-reading');assert.equal(course.version,'1');assert.equal(course.durationMinutes,20);assert.equal(course.sessionLimitSeconds,1200);
 assert.equal(course.pages.length,5);assert.equal(course.steps.length,8);
 assert.deepEqual(course.steps.map(step=>step.id),['predict','prediction-clue','read-capabilities','read-wings','flexible-design','robot-mission','robot-retell','robot-chat']);
 assert(course.steps.every(step=>step.targetId===null&&step.expected===null));
 assert(course.steps.slice(0,-1).every(step=>step.kind==='speak'));assert.equal(course.steps.at(-1)?.kind,'listen');
});

test('robot content has explicit provenance and bounded reading references rather than invented assessment answers',()=>{
 const course=getCourse();assert.equal(new URL(course.reading.sourceUrl).hostname,'www.dogonews.com');assert.match(course.reading.attribution,/original Teeko teaching text/i);assert.match(course.reading.attribution,/original/i);
 const stages=course.steps.map(step=>step.reading!);
 assert.deepEqual(stages.map(reading=>reading.phase),['predict','predict','read','read','explain','design','retell','chat']);
 const limits={passage:500,goal:260,teacherNotes:380,followUp:160};
 for(const reading of stages){for(const field of ['passage','goal','teacherNotes','followUp'] as const){assert.equal(typeof reading[field],'string');assert(reading[field].length>0&&reading[field].length<=limits[field]);}}
 assert.match(stages[0].teacherNotes,/guess|prediction/i);assert.match(stages[2].teacherNotes,/read.*(?:not|does not)|recit/i);assert.match(stages[5].teacherNotes,/idea|proposal/i);assert.match(stages.at(-1)!.teacherNotes,/end/i);
 const passage=stages[2].passage;assert.match(passage,/wings.*flying to swimming/i);assert.equal(stages[3].passage,passage);
 assert(course.words.includes('wings'));assert(course.words.includes('flexible'));assert(course.words.includes('transition'));
});

test('every reading page is a local original SVG with matching legible passage and valid known-object boxes',async()=>{
 const course=getCourse();const pageIds=new Set(course.pages.map(page=>page.id));assert.equal(pageIds.size,5);
 for(const page of course.pages){
  assert.match(page.image,/^\/course-assets\/robot-reading-[a-z]+\.svg$/);assert.equal(page.width,900);assert.equal(page.height,720);
  const svg=await readFile(new URL(`../public${page.image}`,import.meta.url),'utf8');const dom=new JSDOM(svg,{contentType:'image/svg+xml'}),document=dom.window.document;
  try{
   assert(document.querySelector('svg > title')?.textContent);assert(document.querySelector('svg > desc')?.textContent);
   assert.equal(document.querySelectorAll('script,image,foreignObject,animate,animateTransform').length,0);assert(!/(?:href|src)\s*=\s*["']https?:/i.test(svg));
   const text=document.querySelector('[data-reading-passage]');assert(text);assert(Number(text.getAttribute('font-size'))>=32);
   const lines=Array.from(text.querySelectorAll('tspan'));const visible=normalized(lines.length?lines.map(line=>line.textContent).join(' '):text.textContent??'');
   const passages=course.steps.filter(step=>step.pageId===page.id).map(step=>step.reading!.passage);assert(passages.length);assert(passages.every(passage=>normalized(passage)===visible));
   assert(page.objects.length>0);assert.equal(new Set(page.objects.map(object=>object.id)).size,page.objects.length);
   for(const object of page.objects){assert(object.id&&object.label&&object.chinese);const box=object.box;assert(box.x>=0&&box.y>=0&&box.w>0&&box.h>0&&box.x+box.w<=1&&box.y+box.h<=1);}
  }finally{dom.window.close();}
 }
 assert(course.steps.every(step=>pageIds.has(step.pageId)));
});

test('adding the robot lesson preserves immutable picnic manifests',()=>{
 assert.equal(createHash('sha256').update(JSON.stringify(catalog.PICNIC_COURSE_V1)).digest('hex'),'e8d6c85e5d3232e0a4f9899802239b208d765821f28d626919866eceacf4df4a');
 assert.equal(createHash('sha256').update(JSON.stringify(catalog.PICNIC_COURSE)).digest('hex'),'2d6c241092193b7766eee027cb0b3bb8d4d60c535e4b49a0ca2a4186536e8c4f');
});

test('the existing course publisher inserts the robot revision and verifies all checksums',async()=>{
 const writes:{id:string;version:string;manifest:string;checksum:string}[]=[],checksums=new Map<string,string>();
 const pool={query:async(sql:string,values:unknown[])=>{
  const [id,version,manifest,checksum]=values as string[],key=`${id}:${version}`;
  if(sql.startsWith('INSERT')){writes.push({id,version,manifest,checksum});if(!checksums.has(key))checksums.set(key,checksum);return{rows:[]};}
  return{rows:checksums.has(key)?[{checksum:checksums.get(key)}]:[]};
 }} as unknown as Pool;
 await catalog.publishTrialCourses(pool);assert.deepEqual(writes.map(write=>`${write.id}:${write.version}`),['picnic:1','picnic:2','robot-reading:1','topic-robot:1','topic-picnic:1']);
 const robot=writes.find(write=>write.id==='robot-reading')!;assert.equal(JSON.parse(robot.manifest).steps.length,8);assert.equal(robot.checksum,createHash('sha256').update(robot.manifest).digest('hex'));
});
