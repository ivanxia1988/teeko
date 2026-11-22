import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {closeTeachingLiveResources} from './manual/classroom-teaching-live-cleanup';
test('an invalid manual test database never echoes its input or attempts a live session',async()=>{
 const marker='synthetic-invalid-private-url-marker';let output='';
 const environment:NodeJS.ProcessEnv={...process.env,TEEKO_SYNTHETIC_CLASSROOM_LIVE:'true',TEST_DATABASE_URL:marker};delete environment.NODE_TEST_CONTEXT;
 try{await promisify(execFile)(process.execPath,['--import','tsx','--test','tests/manual/classroom-teaching-live.test.ts'],{cwd:process.cwd(),env:environment,timeout:10000,maxBuffer:16384});assert.fail('Expected configuration failure');}
 catch(error){const captured=error as {stdout?:string;stderr?:string};output=(captured.stdout??'')+(captured.stderr??'');}
 assert(output.includes('fail'));assert.equal(output.includes(marker),false);assert.equal(output.includes('TEEKO_SYNTHETIC_SUMMARY'),false);
});
test('a failed voice cleanup still closes HTTP, pools and the owned schema without echoing its cause',async()=>{
 const calls:string[]=[];
 await assert.rejects(closeTeachingLiveResources([
  async()=>{calls.push('voice');throw new Error('synthetic-private-failure-marker');},
  async()=>{calls.push('http');},async()=>{calls.push('pool');throw new Error('synthetic-private-db-marker');},async()=>{calls.push('schema');},async()=>{calls.push('admin');},
 ]),{message:'Synthetic fixture cleanup incomplete.'});
 assert.deepEqual(calls,['voice','http','pool','schema','admin']);
});

test('fixed synthetic speech frames preserve PCM and zero-pad only the last transport frame',async()=>{
 const {teachingAudioFrames}=await import('./manual/classroom-teaching-synthetic-audio');
 for(const length of [2,3200,3202,6400]){
  const source=Buffer.alloc(length,0x17),frames=teachingAudioFrames(source),joined=Buffer.concat(frames);
  assert(frames.every(frame=>frame.length===3200));assert.deepEqual(joined.subarray(0,length),source);assert(joined.subarray(length).every(byte=>byte===0));assert.equal(frames.length,Math.ceil(length/3200));
 }
 assert.throws(()=>teachingAudioFrames(Buffer.alloc(3)),{message:'Invalid synthetic speech fixture.'});assert.throws(()=>teachingAudioFrames(Buffer.alloc(0)),{message:'Invalid synthetic speech fixture.'});
});
