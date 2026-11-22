import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {captureClassroomPoint,CLASSROOM_POINT_RECALL_MS,recallClassroomPoint,requestedClassroomPointRecall,resolveClassroomPointIntent} from '../lib/classroom-point';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import {ROBOT_READING_COURSE} from '../lib/server/robot-reading-course';
import {teacherSnapshot} from './teacher-runtime-fixture';

const snapshot=teacherSnapshot({course:ROBOT_READING_COURSE,stepIndex:0});
const state=captureClassroomToolState(snapshot);assert(state.ok);
const object=snapshot.course.pages.find(page=>page.id===snapshot.course.steps[0].pageId)!.objects[0];
const request=()=>({type:'interaction.point' as const,eventId:randomUUID(),context:{...state.snapshot.context},objectId:object.id});

test('point captures a known object in the current non-select activity without rewriting client scope or identity',()=>{
 const wire=request(),point=captureClassroomPoint(snapshot,wire);assert(point.accepted);
 assert.deepEqual(point.request,wire);assert.deepEqual(point.object,object);
 assert.equal(wire.context.stateRevision,snapshot.revision);
});

test('point rejects malformed UUIDs, unknown fields and the UI-only legacy context key shape',()=>{
 const valid=request();
 for(const input of [null,[],{}, {...valid,type:'point'}, {...valid,eventId:'not-a-uuid'}, {...valid,eventId:''}, {...valid,contextKey:`${snapshot.id}:${snapshot.connectionEpoch}:0`}, {contextKey:`${snapshot.id}:${snapshot.connectionEpoch}:0`,objectId:object.id}, {...valid,objectId:[]}, {...valid,objectId:` ${object.id}`}, {...valid,objectId:'x'.repeat(101)}])assert.equal(captureClassroomPoint(snapshot,input).accepted,false);
});

test('point rejects old, future, foreign and incomplete full contexts',()=>{
 const valid=request();
 for(const context of [
  {...valid.context,stateRevision:valid.context.stateRevision-1}, {...valid.context,stateRevision:valid.context.stateRevision+1},
  {...valid.context,connectionEpoch:valid.context.connectionEpoch+1}, {...valid.context,logicalSessionId:randomUUID()},
  {...valid.context,courseVersion:'other:1'}, {...valid.context,pageId:'other-page'}, {...valid.context,activityId:'other-task'},
  {...valid.context,unexpected:true}, {},
 ])assert.equal(captureClassroomPoint(snapshot,{...valid,context}).accepted,false);
});

test('point requires active state, a current page object and a non-select activity',()=>{
 const valid=request();
 for(const status of ['preflight','paused','ended'] as const)assert.equal(captureClassroomPoint({...snapshot,status},valid).accepted,false);
 assert.equal(captureClassroomPoint(snapshot,{...valid,objectId:'unknown-object'}).accepted,false);
 const otherPageObject=snapshot.course.pages.find(page=>page.id!==state.snapshot.context.pageId)!.objects.find(candidate=>candidate.id!==object.id)!;
 assert.equal(captureClassroomPoint(snapshot,{...valid,objectId:otherPageObject.id}).accepted,false);
 const select={...snapshot,course:{...snapshot.course,steps:[{...snapshot.course.steps[0],kind:'select' as const}]} };
 assert.equal(captureClassroomPoint(select,valid).accepted,false);
 const listen={...snapshot,course:{...snapshot.course,steps:[{...snapshot.course.steps[0],kind:'listen' as const}]} };
 assert.equal(captureClassroomPoint(listen,valid).accepted,true);
 assert.equal(captureClassroomPoint({...snapshot,stepIndex:-1},valid).accepted,false);
});

test('a fresh pointer intent can be revalidated after a same-task revision without relaxing evidence validation',()=>{
 const wire=request(),newer={...snapshot,revision:snapshot.revision+2};
 assert.equal(captureClassroomPoint(newer,wire).accepted,false);
 const resolved=resolveClassroomPointIntent(newer,wire);assert(resolved.accepted);
 assert.deepEqual(resolved.request,{...wire,context:{...wire.context,stateRevision:newer.revision}});
 assert.equal(wire.context.stateRevision,snapshot.revision);
 assert.equal(captureClassroomPoint(newer,resolved.request).accepted,true);
});

test('pointer intent revalidation rejects future revisions, task changes, invalid objects and inactive classrooms',()=>{
 const wire=request();
 for(const context of [
  {...wire.context,stateRevision:snapshot.revision+1}, {...wire.context,connectionEpoch:snapshot.connectionEpoch+1},
  {...wire.context,logicalSessionId:randomUUID()}, {...wire.context,courseVersion:'other:1'},
  {...wire.context,pageId:'other-page'}, {...wire.context,activityId:'other-task'},
 ])assert.equal(resolveClassroomPointIntent(snapshot,{...wire,context}).accepted,false);
 assert.equal(resolveClassroomPointIntent({...snapshot,status:'paused'},wire).accepted,false);
 assert.equal(resolveClassroomPointIntent(snapshot,{...wire,objectId:'unknown'}).accepted,false);
 assert.equal(resolveClassroomPointIntent(snapshot,{...wire,extra:true}).accepted,false);
});

test('pointer recall is explicit in Chinese or English and does not turn other requests into pointer questions',()=>{
 for(const text of ['我刚点了什么？','我刚才点了哪个部位？','请问，我刚刚点击了哪里？'])assert.equal(requestedClassroomPointRecall(text),'zh');
 for(const text of ['What did I point to?','What did I just click on?','What part did I just tap?'])assert.equal(requestedClassroomPointRecall(text),'en');
 for(const text of ['Did I click wings?','Can you circle it?','I asked what did I point to in the story.','我没有点翅膀。','我刚才点了翅膀。'])assert.equal(requestedClassroomPointRecall(text),null);
});

test('a confirmed pointer remains usable across same-activity revisions only, within thirty seconds',()=>{
 const point={request:request(),acceptedAtMs:1784250000000};
 const next={...snapshot,revision:snapshot.revision+1};
 const valid=recallClassroomPoint(next,point,point.acceptedAtMs+CLASSROOM_POINT_RECALL_MS-1);
 assert.equal(valid?.object.id,object.id);assert.equal(valid?.request.eventId,point.request.eventId);
 for(const change of [{...next,status:'paused' as const},{...next,id:randomUUID()},{...next,connectionEpoch:next.connectionEpoch+1},{...next,stepIndex:1}]){
  assert.equal(recallClassroomPoint(change,point,point.acceptedAtMs+100),null);
 }
 assert.equal(recallClassroomPoint(next,point,point.acceptedAtMs+CLASSROOM_POINT_RECALL_MS),null);
 assert.equal(recallClassroomPoint(next,point,point.acceptedAtMs-1),null);
 assert.equal(recallClassroomPoint(next,null,point.acceptedAtMs),null);
});
