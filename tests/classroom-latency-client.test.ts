import test from 'node:test';
import assert from 'node:assert/strict';
import {ClassroomLatencyClient} from '../lib/classroom-latency-client';
const input='10000000-0000-4000-8000-000000000001',measurement='20000000-0000-4000-8000-000000000001',turn='30000000-0000-4000-8000-000000000001',span='40000000-0000-4000-8000-000000000001';
function harness(){let now=0,next=0;const sent:Record<string,unknown>[]=[];const tracker=new ClassroomLatencyClient({now:()=>now,id:()=>next++? '10000000-0000-4000-8000-000000000002':input,send:value=>{sent.push(value);return true;}});return{tracker,sent,set:(value:number)=>{now=value;},frame:(atMs:number,level:number)=>{now=atMs;return tracker.capture({atMs,level,frameMs:100});}};}
const bound=(lastVoiceSequence=0)=>({type:'diagnostic.latency',measurementId:measurement,inputId:input,turnId:turn,spanId:span,basis:'provider_turn',state:'bound',lastVoiceSequence});
test('client latency uses capture frame end to approved audible output in one monotonic clock',()=>{
 const h=harness();assert.deepEqual(h.frame(100,.2),{latencyInputId:input,audioSequence:0});h.frame(200,0);assert.deepEqual(h.sent[0],{type:'diagnostic.input',inputId:input,firstSequence:0,lastVoiceSequence:0,phase:'stopped',silenceMs:100});
 h.tracker.receive(bound());for(let at=300;at<=1000;at+=100)h.frame(at,0);assert.equal(h.tracker.audio(measurement)?.startsWith(measurement),true);h.frame(1100,0);h.set(1300);h.tracker.audible({measurementId:h.tracker.audio(measurement)??measurement,atMs:1200});
 assert.deepEqual(h.sent.at(-1),{type:'diagnostic.latency',measurementId:measurement,phase:'playback_started',waitMs:1100,captureGapMs:0,playbackMs:200});h.tracker.audible({measurementId:h.tracker.audio(measurement)??measurement,atMs:1250});assert.equal(h.sent.filter(e=>e.type==='diagnostic.latency').length,1);
});
test('client latency cannot finish on unapproved, mixed or cancelled audio',()=>{
 for(const mode of ['unapproved','mixed','cancelled'] as const){const h=harness();h.frame(100,.2);h.frame(200,0);if(mode!=='unapproved')h.tracker.receive(bound());if(mode==='mixed')h.tracker.audio(null);if(mode==='cancelled')h.tracker.receive({...bound(),state:'cancelled'});h.set(300);h.tracker.audio(measurement);h.tracker.audible({measurementId:h.tracker.audio(measurement)??measurement,atMs:300});assert.equal(h.sent.filter(e=>e.type==='diagnostic.latency').length,0);}
});
test('late binding with an older lastVoiceSequence cannot attach to a renewed input',()=>{
 const h=harness();h.frame(100,.2);h.frame(200,0);h.frame(300,.2);h.frame(400,0);h.tracker.receive(bound(0));h.set(500);assert.equal(h.tracker.audio(measurement),undefined);h.tracker.audible({measurementId:h.tracker.audio(measurement)??measurement,atMs:500});assert.equal(h.sent.filter(e=>e.type==='diagnostic.latency').length,0);
});
test('new voice, capture discontinuity, explicit invalidation and expiration discard old measurements',()=>{
 for(const mode of ['voice','gap','invalidate','expired'] as const){const h=harness();h.frame(100,.2);h.frame(200,0);h.tracker.receive(bound());h.tracker.audio(measurement);if(mode==='voice')h.frame(300,.2);if(mode==='gap')h.frame(800,0);if(mode==='invalidate')h.tracker.reset();if(mode==='expired')h.set(121000);else h.set(850);h.tracker.audible({measurementId:h.tracker.audio(measurement)??measurement,atMs:mode==='expired'?121000:850});assert.equal(h.sent.filter(e=>e.type==='diagnostic.latency').length,0);}
});
test('missing native capture metadata leaves existing audio callers uninstrumented',()=>{
 const h=harness();assert.equal(h.tracker.capture(undefined),undefined);assert.equal(h.tracker.capture({atMs:NaN,level:.2,frameMs:100}),undefined);assert.equal(h.sent.length,0);
});

test('an unknown but well-formed audio measurement invalidates a previously approved wait',()=>{
 const h=harness();h.frame(100,.2);h.frame(200,0);h.tracker.receive(bound());h.tracker.audio(measurement);
 h.tracker.audio('20000000-0000-4000-8000-000000000099');h.set(300);h.tracker.audible({measurementId:h.tracker.audio(measurement)??measurement,atMs:300});assert.equal(h.sent.filter(e=>e.type==='diagnostic.latency').length,0);
});
test('a failing optional input identifier never throws through the capture media callback',()=>{
 const tracker=new ClassroomLatencyClient({now:()=>100,id:()=>{throw new Error('optional unavailable');},send:()=>true});
 assert.doesNotThrow(()=>tracker.capture({atMs:100,level:.2,frameMs:100}));
});

test('task changes require a fresh server binding and cannot reuse an older local playback callback',()=>{
 const h=harness();h.frame(100,.2);h.frame(200,0);h.tracker.receive(bound());const oldTag=h.tracker.audio(measurement)!;
 assert.equal(typeof h.tracker.scopeChanged,'function');h.tracker.scopeChanged();assert.equal(h.tracker.audio(measurement),undefined);
 h.tracker.receive(bound());const newTag=h.tracker.audio(measurement)!;assert.notEqual(oldTag,newTag);h.set(300);
 h.tracker.audible({measurementId:oldTag,atMs:280});assert.equal(h.sent.filter(e=>e.type==='diagnostic.latency').length,0);
 h.tracker.audible({measurementId:newTag,atMs:280});assert.equal(h.sent.filter(e=>e.type==='diagnostic.latency').length,1);
});

test('capture gaps and unknown playback explain once why a real input could not be measured',()=>{
 for(const reason of ['capture_gap','playback_unbound'] as const){
  const h=harness();h.frame(100,.2);h.frame(200,0);h.tracker.receive(bound());h.tracker.audio(measurement);
  if(reason==='capture_gap')h.frame(900,0);else h.tracker.audio(null);
  h.tracker.audio(null);h.tracker.capture(undefined);
  const reports=h.sent.filter(e=>e.phase==='unmeasured');assert.equal(reports.length,1);assert.equal(reports[0].inputId,input);assert.equal(reports[0].reason,reason);
  if(reason==='capture_gap')assert.equal(reports[0].captureGapMs,600);
 }
});
test('a capture gap belongs to the discarded input rather than the next clean input',()=>{
 const h=harness();h.frame(100,.2);h.frame(200,0);const renewed=h.frame(900,.2)!;h.frame(1000,0);
 h.tracker.receive({...bound(renewed.audioSequence),inputId:renewed.latencyInputId});const tag=h.tracker.audio(measurement)!;h.set(1100);h.tracker.audible({measurementId:tag,atMs:1080});
 assert.equal(h.sent.find(e=>e.phase==='playback_started')?.captureGapMs,0);
});
test('the first actual quiet capture frame reports a stop despite sub-millisecond clock mapping jitter',()=>{
 const h=harness();h.frame(100,.2);h.frame(199.8,0);assert.equal(h.sent.find(e=>e.phase==='stopped')?.silenceMs,100);
});
