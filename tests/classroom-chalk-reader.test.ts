import test from 'node:test';
import assert from 'node:assert/strict';
import {ClassroomChalkReader} from '../lib/server/classroom-chalk-reader';
import {captureClassroomToolState} from '../lib/classroom-tool-state';
import {teacherSnapshot} from './teacher-runtime-fixture';
import type {ClassroomSnapshot} from '../lib/classroom-contract';
import type {ClassroomChalkCandidate} from '../lib/server/classroom-chalk-candidate';
const drain=()=>new Promise<void>(resolve=>setImmediate(resolve));
const candidate=(snapshot:ClassroomSnapshot,text='I like apples.'):ClassroomChalkCandidate=>{
 const captured=captureClassroomToolState(snapshot);assert(captured.ok);return{context:captured.snapshot.context,evidenceItemId:'source',text,seconds:8};
};
test('optional chalk reads never wait on the required heartbeat and cache only the same live scope',async()=>{
 const snapshot=teacherSnapshot();let calls=0,now=1000;
 const reader=new ClassroomChalkReader(async state=>{calls++;return candidate(state);},{now:()=>now,budgetMs:100});
 try{assert.equal(reader.peek(snapshot),null);assert.equal(calls,0);await drain();assert.equal(reader.peek(snapshot)?.text,'I like apples.');assert.equal(calls,1);now=6001;assert.equal(reader.peek(snapshot),null);await drain();assert.equal(calls,2);}finally{reader.close();}
});
test('a timed-out optional chalk read aborts its source and never publishes a late result or queues another read',async()=>{
 const snapshot=teacherSnapshot();let calls=0,signal:AbortSignal|undefined,finish:((value:ClassroomChalkCandidate)=>void)|undefined;
 const reader=new ClassroomChalkReader(async(state,active)=>{calls++;signal=active;if(calls===1)return new Promise(resolve=>{finish=resolve;});return candidate(state,'A fresh reference.');},{budgetMs:5});
 try{
  assert.equal(reader.peek(snapshot),null);await drain();assert(signal);if(!signal.aborted)await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));assert.equal(signal.aborted,true);
  assert.equal(reader.peek(snapshot),null);assert.equal(calls,1);finish!(candidate(snapshot));await drain();assert.equal(reader.peek(snapshot),null);await drain();assert.equal(calls,2);assert.equal(reader.peek(snapshot)?.text,'A fresh reference.');
 }finally{reader.close();}
});
test('scope replacement and closure cancel optional reads without exposing the old candidate',async()=>{
 const snapshot=teacherSnapshot(),newer={...snapshot,revision:snapshot.revision+1};let signal:AbortSignal|undefined,finish:((value:ClassroomChalkCandidate)=>void)|undefined,calls=0;
 const reader=new ClassroomChalkReader(async(state,active)=>{calls++;signal=active;if(calls===1)return new Promise(resolve=>{finish=resolve;});return candidate(state);},{budgetMs:100});
 assert.equal(reader.peek(snapshot),null);await drain();assert.equal(reader.peek(newer),null);assert.equal(signal?.aborted,true);finish!(candidate(snapshot));await drain();assert.equal(reader.peek(newer),null);await drain();assert.equal(reader.peek(newer)?.context.stateRevision,newer.revision);reader.close();assert.equal(reader.peek(newer),null);
});
test('closing an in-flight optional read aborts it and prevents any late publication',async()=>{
 const snapshot=teacherSnapshot();let signal:AbortSignal|undefined,finish:((value:ClassroomChalkCandidate)=>void)|undefined;
 const reader=new ClassroomChalkReader(async(_state,active)=>{signal=active;return new Promise(resolve=>{finish=resolve;});},{budgetMs:100});
 assert.equal(reader.peek(snapshot),null);await drain();reader.close();assert.equal(signal?.aborted,true);finish!(candidate(snapshot));await drain();assert.equal(reader.peek(snapshot),null);
});
