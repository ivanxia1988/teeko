import assert from 'node:assert/strict';
import test from 'node:test';
import {ClassroomVisualQueue} from '../lib/server/classroom-visual-queue';
import type {ClassroomStateSnapshot} from '../lib/domain/classroom-context';

const state:ClassroomStateSnapshot={status:'active',context:{logicalSessionId:'lesson',courseVersion:'picnic:1',connectionEpoch:1,stateRevision:1,pageId:'page',activityId:'task'}};
const update=(source:'camera'|'board'='camera',description='An apple')=>({source,generation:1,context:{...state.context},receivedAtMs:100,expiresAtMs:8100,observation:{visible:true,description},first:true});
const ready={foregroundIdle:true,childQuiet:true,playbackQuiet:true};
function fixture(){let now=100;return {queue:new ClassroomVisualQueue(()=>now),at:(value:number)=>{now=value;}};}

test('two sources keep only their latest bounded observation and preserve a pending first acknowledgement',()=>{
 const {queue}=fixture();assert(queue.offer(state,update()));assert(queue.offer(state,update('board','A circle')));
 assert(queue.offer(state,{...update('camera','A banana'),first:false}));assert.equal(queue.size,2);
 const first=queue.take(state,ready)!;assert.equal(first.source,'camera');assert.equal(first.observation.description,'A banana');assert.equal(first.first,true);
 assert.equal(queue.take(state,ready)!.source,'board');assert.equal(queue.take(state,ready),null);
});
for(const condition of ['foregroundIdle','childQuiet','playbackQuiet'] as const)test(`visual dispatch waits for ${condition}`,()=>{
 const {queue}=fixture();queue.offer(state,update());assert.equal(queue.take(state,{...ready,[condition]:false}),null);assert.equal(queue.size,1);
 assert(queue.take(state,ready));
});
test('a repeated published fact is suppressed until invalidated',()=>{
 const {queue}=fixture();queue.offer(state,update());queue.take(state,ready);
 assert.equal(queue.offer(state,{...update(),first:false}),false);assert.equal(queue.size,0);
 queue.cancel('camera');assert(queue.offer(state,update()));
});
test('waiting never extends the original frame deadline',()=>{
 const {queue,at}=fixture();at(8000);assert(queue.offer(state,update()));assert.equal(queue.take(state,{...ready,childQuiet:false}),null);
 at(8100);assert.equal(queue.take(state,ready),null);assert.equal(queue.size,0);assert.equal(queue.offer(state,update()),false);
});
for(const [key,value] of [['logicalSessionId','other'],['courseVersion','2'],['connectionEpoch',2],['stateRevision',2],['pageId','other'],['activityId','other']] as const)test(`waiting visual ${key} must remain current`,()=>{
 const {queue}=fixture();queue.offer(state,update());assert.equal(queue.take({...state,context:{...state.context,[key]:value}},ready),null);assert.equal(queue.size,0);
});
test('pause clears waiting facts even while dispatch is blocked',()=>{
 const {queue}=fixture();queue.offer(state,update());assert.equal(queue.take({...state,status:'paused'},{...ready,childQuiet:false}),null);assert.equal(queue.size,0);
});
test('new generations do not inherit the old first acknowledgement',()=>{
 const {queue}=fixture();queue.offer(state,update());queue.offer(state,{...update(),generation:2,first:false});assert.equal(queue.take(state,ready)!.first,false);
});
test('cancel and close release observations without reviving the connection',()=>{
 const {queue}=fixture();queue.offer(state,update());queue.offer(state,update('board'));queue.cancel('camera');assert.equal(queue.size,1);
 queue.close();assert.equal(queue.size,0);assert.equal(queue.offer(state,update()),false);assert.equal(queue.take(state,ready),null);
});
test('input is copied and frozen; hidden payloads or scheduling authority are rejected',()=>{
 const {queue}=fixture();const raw=update();queue.offer(state,raw);raw.observation.description='mutated';const next=queue.take(state,ready)!;
 assert.equal(next.observation.description,'An apple');assert(Object.isFrozen(next.observation));assert(Object.isFrozen(next.context));
 for(const invalid of [{...update(),image:'raw'},{...update(),priority:99},{...update(),observation:{visible:true,description:'x'.repeat(301)}}])assert.equal(queue.offer(state,invalid),false);
});
test('unsafe, future and backwards time cannot dispatch a visual fact',()=>{
 for(const time of [NaN,Infinity,99]){const {queue,at}=fixture();queue.offer(state,update());at(time);assert.equal(queue.take(state,ready),null);assert.equal(queue.size,0);}
 const {queue}=fixture();assert.equal(queue.offer(state,{...update(),receivedAtMs:101}),false);
});

test('returning to the published fact cancels an older pending replacement',()=>{
 const {queue}=fixture();queue.offer(state,update('camera','A'));queue.take(state,ready);
 queue.offer(state,{...update('camera','B'),first:false});assert.equal(queue.size,1);
 assert.equal(queue.offer(state,{...update('camera','A'),first:false}),false);
 assert.equal(queue.size,0);assert.equal(queue.take(state,ready),null);
});
