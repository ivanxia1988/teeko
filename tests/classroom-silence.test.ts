import assert from 'node:assert/strict';
import test from 'node:test';
import {ClassroomSilencePrompt} from '../lib/server/classroom-silence';

test('silence waits from confirmed playback, not model generation or elapsed wall time alone',()=>{
 const prompt=new ClassroomSilencePrompt();
 assert.equal(prompt.canProbe,false);
 prompt.teacherAudio(1);
 assert.equal(prompt.confirmPlayback(0,10000,8000),false);
 assert.equal(prompt.confirmPlayback(1,10000,8000),false);
 assert.equal(prompt.confirmPlayback(1,17999,8000),false);
 assert.equal(prompt.confirmPlayback(1,18000,8000),true);
});

test('silence reminder cannot repeat itself after its own audio finishes',()=>{
 const prompt=new ClassroomSilencePrompt();prompt.teacherAudio(1);
 prompt.confirmPlayback(1,0,8000);assert.equal(prompt.confirmPlayback(1,8000,8000),true);
 prompt.teacherAudio(2);assert.equal(prompt.canProbe,false);
 assert.equal(prompt.confirmPlayback(2,50000,8000),false);
 prompt.speechStarted();prompt.learnerFinal('An apple.');prompt.teacherAudio(3);
 prompt.confirmPlayback(3,60000,8000);assert.equal(prompt.confirmPlayback(3,68000,8000),true);
});

test('silence resets for drawing and never prompts after interruption or stale playback',()=>{
 const prompt=new ClassroomSilencePrompt();prompt.teacherAudio(1);prompt.confirmPlayback(1,0,8000);
 prompt.drawing();assert.equal(prompt.confirmPlayback(1,8000,8000),false);
 assert.equal(prompt.confirmPlayback(1,16000,8000),true);
 prompt.speechStarted();prompt.learnerFinal('Banana.');assert.equal(prompt.canProbe,false);
 assert.equal(prompt.confirmPlayback(1,100000,8000),false);
 prompt.teacherAudio(2);prompt.interrupt();assert.equal(prompt.canProbe,false);
});

for(const text of ['Wait a moment, please.','Give me some time to think.','Let me think.','等一下，我想一想。','先别说话。'])test(`silence respects an explicit wait request: ${text}`,()=>{
 const prompt=new ClassroomSilencePrompt();prompt.speechStarted();prompt.learnerFinal(text);prompt.teacherAudio(1);
 assert.equal(prompt.canProbe,false);assert.equal(prompt.confirmPlayback(1,100000,8000),false);
 prompt.speechStarted();prompt.learnerFinal('I like bananas.');prompt.teacherAudio(2);assert.equal(prompt.canProbe,true);
});

test('silence scope reset discards previous playback and wait state',()=>{
 const prompt=new ClassroomSilencePrompt();prompt.teacherAudio(1);prompt.confirmPlayback(1,0,8000);
 prompt.reset();assert.equal(prompt.confirmPlayback(1,99999,8000),false);assert.equal(prompt.canProbe,false);
});

for(const text of ['I wait for the bus.','I like the waiter.'])test(`silence only suppresses explicit wait requests: ${text}`,()=>{
 const prompt=new ClassroomSilencePrompt();prompt.learnerFinal(text);prompt.teacherAudio(1);assert.equal(prompt.canProbe,true);
});
