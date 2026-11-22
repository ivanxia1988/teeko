import test from 'node:test';
import assert from 'node:assert/strict';
import {ClassroomHandoff,type ClassroomHandoffAdvance,type ClassroomHandoffObservation} from '../lib/server/classroom-handoff';

const before={status:'active' as const,stepIndex:0,context:{logicalSessionId:'fixture-classroom',courseVersion:'fixture:1',connectionEpoch:1,stateRevision:1,pageId:'page-one',activityId:'prediction'}};
const after={status:'active' as const,stepIndex:1,context:{...before.context,stateRevision:3,activityId:'clue'}};
const input={itemId:'fixture-input',sequence:2,activity:4};
const advance:ClassroomHandoffAdvance={id:'fixture-advance',before,after,input};
const current:ClassroomHandoffObservation={scope:before,input};
const empty={responsePending:false,outputQueued:false};

test('a verified same-input advance preserves a native reply until complete browser drain, then applies silently once',()=>{
 let now=0;const handoff=new ClassroomHandoff({now:()=>now});
 assert.equal(handoff.offer(advance,current,{id:'reply-one',hasOutput:true,done:false}),true);
 assert.equal(handoff.take(current,empty).action,'wait');
 assert.equal(handoff.playbackDrained('reply-one',input),false,'generation still active');
 handoff.replyDone('reply-one',input);
 assert.equal(handoff.take(current,empty).action,'wait','no browser receipt');
 assert.equal(handoff.playbackDrained('reply-one',input),true);
 assert.equal(handoff.take(current,{...empty,outputQueued:true}).action,'wait');
 const ready=handoff.take(current,empty);assert.equal(ready.action,'apply_silent');assert.equal(ready.advance?.id,advance.id);
 assert.equal(handoff.take(current,empty).action,'none');
 assert.equal(handoff.offer(advance,current),false,'duplicate notification cannot resurrect');now=1;
});

test('a native reply arriving while waiting prevents an application cue and becomes the preserved reply',()=>{
 let now=0;const handoff=new ClassroomHandoff({now:()=>now,replyGraceMs:300});
 assert(handoff.offer(advance,current));now=100;assert.equal(handoff.take(current,{...empty,responsePending:true}).action,'wait');
 assert(handoff.replyStarted('reply-late',input));handoff.replyOutput('reply-late',input);handoff.replyDone('reply-late',input);
 assert.equal(handoff.take(current,empty).action,'wait');handoff.playbackDrained('reply-late',input);
 assert.equal(handoff.take(current,empty).action,'apply_silent');
});

test('absent native reply emits exactly one application cue only after grace and pending response clears',()=>{
 let now=0;const handoff=new ClassroomHandoff({now:()=>now,replyGraceMs:300});assert(handoff.offer(advance,current));
 now=299;assert.equal(handoff.take(current,empty).action,'wait');now=300;assert.equal(handoff.take(current,{...empty,responsePending:true}).action,'wait');
 assert.equal(handoff.take(current,empty).action,'apply_with_cue');assert.equal(handoff.take(current,empty).action,'none');
});

test('a completed native response with no output does not suppress the only application cue',()=>{
 const handoff=new ClassroomHandoff({now:()=>0});assert(handoff.offer(advance,current,{id:'empty',hasOutput:false,done:true}));
 assert.equal(handoff.take(current,empty).action,'apply_with_cue');
});

test('new input, even with the same transcript id, revokes a pending handoff and stale drain cannot finish it',()=>{
 for(const field of ['itemId','sequence','activity'] as const){
  const handoff=new ClassroomHandoff({now:()=>0});assert(handoff.offer(advance,current,{id:'reply',hasOutput:true,done:true}));
  const changed={...input,[field]:field==='itemId'?'new-input':input[field]+1};
  const result=handoff.take({...current,input:changed},empty);assert.equal(result.action,'cancelled');assert.equal(result.reason,'new_input');
  assert.equal(handoff.playbackDrained('reply',input),false);assert.equal(handoff.take(current,empty).action,'none');
 }
});

test('manual task/revision change, pause, epoch and course changes revoke rather than migrate a pending reply',()=>{
 const scopes=[after,{...before,status:'paused' as const},{...before,context:{...before.context,stateRevision:2}},{...before,context:{...before.context,connectionEpoch:2}},{...before,context:{...before.context,courseVersion:'fixture:2'}}];
 for(const scope of scopes){const handoff=new ClassroomHandoff({now:()=>0});assert(handoff.offer(advance,current));const result=handoff.take({...current,scope},empty);assert.equal(result.action,'cancelled');assert.equal(result.reason,'scope_changed');}
});

test('forged, skipped, backwards, inactive and cross-session advance scopes never become a handoff',()=>{
 const invalid=[{...advance,after:{...after,stepIndex:2}},{...advance,after:{...after,context:{...after.context,stateRevision:1}}},{...advance,after:{...after,status:'ended' as const}},{...advance,after:{...after,context:{...after.context,logicalSessionId:'another'}}},{...advance,after:{...after,context:{...after.context,connectionEpoch:2}}},{...advance,input:{...input,sequence:3}}];
 for(const candidate of invalid){const handoff=new ClassroomHandoff({now:()=>0});assert.equal(handoff.offer(candidate,current),false);assert.equal(handoff.take(current,empty).action,'none');}
});

test('ambiguous native replies cannot silence the next activity or accept a stale playback receipt',()=>{
 const handoff=new ClassroomHandoff({now:()=>0});assert(handoff.offer(advance,current,{id:'reply',hasOutput:true,done:true}));
 assert.equal(handoff.playbackDrained('other',input),false);assert.equal(handoff.replyStarted('other',input),false);
 const result=handoff.take(current,empty);assert.equal(result.action,'cancelled');assert.equal(result.reason,'ambiguous_reply');
});

test('deadline expiry, backwards clock and explicit cancellation discard the pending handoff without replay',()=>{
 for(const end of [1000,-1,Infinity]){let now=0;const handoff=new ClassroomHandoff({now:()=>now,maxWaitMs:1000});assert(handoff.offer(advance,current));now=end;assert.equal(handoff.take(current,empty).action,'cancelled');assert.equal(handoff.take(current,empty).action,'none');}
 const handoff=new ClassroomHandoff({now:()=>0});assert(handoff.offer(advance,current));handoff.cancel();assert.equal(handoff.take(current,empty).action,'none');assert.equal(handoff.offer(advance,current),false);
});

test('a late output chunk revokes an earlier drain receipt and waits for the new browser drain',()=>{
 const handoff=new ClassroomHandoff({now:()=>0});assert(handoff.offer(advance,current,{id:'reply',hasOutput:true,done:true}));
 assert(handoff.playbackDrained('reply',input));assert(handoff.replyOutput('reply',input));
 assert.equal(handoff.take(current,empty).action,'wait');assert(handoff.playbackDrained('reply',input));
 assert.equal(handoff.take(current,empty).action,'apply_silent');
});

test('captured advance remains immutable while a second offer cannot replace a pending handoff',()=>{
 const handoff=new ClassroomHandoff({now:()=>0});const candidate=structuredClone(advance);
 assert(handoff.offer(candidate,current,{id:'reply',hasOutput:true,done:true}));
 assert.equal(handoff.offer({...advance,id:'another'},current),false);
 Object.assign(candidate.after.context,{activityId:'mutated'});Object.assign(candidate.input,{sequence:999});
 assert(handoff.playbackDrained('reply',input));const result=handoff.take(current,empty);
 assert.equal(result.action,'apply_silent');assert.equal(result.advance.after.context.activityId,'clue');assert.equal(result.advance.input.sequence,2);
 assert(Object.isFrozen(result.advance));assert(Object.isFrozen(result.advance.after.context));
});
