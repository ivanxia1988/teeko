import test from 'node:test';
import assert from 'node:assert/strict';
import {parseClassroomNoteWorkerArgs,runClassroomNoteWorker} from '../scripts/run-classroom-note-jobs';
test('worker accepts only its declared operation without inspecting environment on import',()=>{
 assert.deepEqual(parseClassroomNoteWorkerArgs([]),{once:false});assert.deepEqual(parseClassroomNoteWorkerArgs(['--once']),{once:true});
 for(const args of [['--url','secret'],['--cancel','id'],['--once','--once'],['--unknown']])assert.equal(parseClassroomNoteWorkerArgs(args),null);
});
test('once consumes at most one real task and reports only bounded status counts',async()=>{
 let calls=0;const result=await runClassroomNoteWorker({async runOne(){calls++;return'succeeded' as const;}},{once:true});assert.equal(calls,1);assert.deepEqual(result,{processed:1,succeeded:1});
 const empty=await runClassroomNoteWorker({async runOne(){return'empty' as const;}},{once:true});assert.deepEqual(empty,{processed:0,succeeded:0});
});
test('a worker shutdown stops polling and does not restart a cancelled run',async()=>{
 const controller=new AbortController();let calls=0,waits=0;
 const result=await runClassroomNoteWorker({async runOne(signal){assert.equal(signal,controller.signal);calls++;return'retry' as const;}},{once:false,signal:controller.signal,wait:async()=>{waits++;controller.abort();}});
 assert.equal(calls,1);assert.equal(waits,1);assert.deepEqual(result,{processed:1,succeeded:0});
 const stopped=await runClassroomNoteWorker({async runOne(){throw new Error('must not claim');}},{once:false,signal:controller.signal});assert.equal(stopped.processed,0);
});
