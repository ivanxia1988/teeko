import test from 'node:test';
import assert from 'node:assert/strict';
import type {ClassroomJournalEntry} from '../lib/classroom-journal';

const traceModule=await import('../lib/server/classroom-diagnostic-trace').catch(()=>null);
test('diagnostic spans record ordered server facts once using one monotonic clock',()=>{
 assert(traceModule?.ClassroomDiagnosticTrace,'The diagnostic recorder must exist.');
 let now=100;const entries:ClassroomJournalEntry[]=[],messages:unknown[]=[];
 const trace=new traceModule.ClassroomDiagnosticTrace({current:()=>({scope:'scope-1',contextKey:'class:1:0'}),now:()=>now,emit:entry=>entries.push(entry),notify:value=>{messages.push(value);return true;}});
 const turn=trace.create('typed'),response=trace.create('application',turn);
 trace.mark(turn,'input_received');now=120;trace.mark(response,'response_requested');now=170;trace.mark(response,'response_started');trace.mark(response,'audio_first_received');trace.mark(response,'audio_first_received');
 now=190;trace.audioSent(response);trace.audioSent(response);now=210;trace.responseDone(response);
 assert.deepEqual(entries.map(entry=>entry.details?.phase),['input_received','response_requested','response_started','audio_first_received','audio_first_sent','response_completed']);
 assert.equal(response.turnId,turn.turnId);assert.notEqual(response.spanId,turn.spanId);assert.equal(entries[4].details?.elapsedMs,90);assert(entries.every(entry=>entry.details?.clock==='server'));
 assert.deepEqual(messages.map(value=>(value as {state:string}).state),['started','completed']);
});
test('client playback reports accept only announced current server spans with strict bounded metadata',()=>{
 assert(traceModule?.ClassroomDiagnosticTrace);let scope='scope-1',now=0;const entries:ClassroomJournalEntry[]=[];
 const trace=new traceModule.ClassroomDiagnosticTrace({current:()=>({scope,contextKey:'class:1:0'}),now:()=>now,emit:entry=>entries.push(entry),notify:()=>true});
 const span=trace.create('provider'),message={type:'diagnostic.playback',...span,phase:'playback_started',elapsedMs:0,queueMs:100};
 assert.equal(trace.playback(message),false);trace.audioSent(span);assert.equal(trace.playback({...message,extra:'PRIVATE_TEXT'}),false);assert.equal(trace.playback({...message,spanId:'00000000-0000-4000-8000-000000000001'}),false);
 assert.equal(trace.playback(message),true);assert.equal(trace.playback(message),false);assert.equal(trace.playback({...message,phase:'playback_sample',elapsedMs:10,queueMs:12001}),false);
 assert.equal(trace.playback({...message,phase:'playback_sample',elapsedMs:10}),true);assert.equal(trace.playback({...message,phase:'playback_sample',elapsedMs:11}),false);now=1000;assert.equal(trace.playback({...message,phase:'playback_sample',elapsedMs:1010}),true);
 assert.equal(trace.playback({...message,phase:'playback_finished',elapsedMs:1020}),false);trace.responseDone(span);assert.equal(trace.playback({...message,phase:'playback_finished',elapsedMs:1020}),true);assert.equal(trace.playback({...message,phase:'playback_finished',elapsedMs:1021}),false);
 const other=trace.create('provider');trace.audioSent(other);scope='scope-2';assert.equal(trace.playback({...message,...other}),false);
 assert(entries.filter(entry=>entry.details?.clock==='client').every(entry=>entry.actor==='application'&&entry.details?.source==='client'));assert(!JSON.stringify(entries).includes('PRIVATE_TEXT'));
});
test('cancelled, closed and evicted diagnostic spans cannot authorize playback or retain arbitrary provider IDs',()=>{
 assert(traceModule?.ClassroomDiagnosticTrace);const trace=new traceModule.ClassroomDiagnosticTrace({current:()=>({scope:'one',contextKey:'class:1:0'}),emit:()=>{},notify:()=>true});
 const span=trace.create('speech');trace.bind('input','provider-item',span);assert.deepEqual(trace.lookup('input','provider-item'),span);trace.audioSent(span);trace.responseDone(span,true);
 assert.equal(trace.playback({type:'diagnostic.playback',...span,phase:'playback_started',elapsedMs:0,queueMs:0}),false);
 for(let i=0;i<300;i++){const next=trace.create('application');trace.bind('input',`item-${i}`,next);}assert.equal(trace.lookup('input','provider-item'),undefined);
 trace.close();assert.equal(trace.lookup('input','item-299'),undefined);assert.equal(trace.playback({type:'diagnostic.playback',...span,phase:'playback_sample',elapsedMs:0,queueMs:0}),false);
});
test('failed diagnostic sinks and notification callbacks never break the classroom path',()=>{
 assert(traceModule?.ClassroomDiagnosticTrace);const trace=new traceModule.ClassroomDiagnosticTrace({current:()=>({scope:'one',contextKey:'class:1:0'}),emit:()=>{throw new Error('PRIVATE_SINK_ERROR');},notify:()=>{throw new Error('PRIVATE_NOTIFY_ERROR');}});
 assert.doesNotThrow(()=>{const span=trace.create('application');trace.mark(span,'session_started');trace.audioSent(span);trace.responseDone(span);trace.close();});
});

test('an observed playback interruption revokes already drained response spans without cross-clock arithmetic',()=>{
 assert(traceModule?.ClassroomDiagnosticTrace);const messages:unknown[]=[];const trace=new traceModule.ClassroomDiagnosticTrace({current:()=>({scope:'same',contextKey:'class:1:0'}),emit:()=>{},notify:value=>{messages.push(value);return true;}});const span=trace.create('provider');trace.audioSent(span);trace.responseDone(span);
 assert.equal(typeof trace.interrupt,'function');trace.interrupt();assert.equal(trace.playback({type:'diagnostic.playback',...span,phase:'playback_started',elapsedMs:0,queueMs:0}),false);assert.equal((messages.at(-1) as {state:string}).state,'cancelled');
});


test('the bounded recorder retains the real session end after many independent response spans',()=>{
 assert(traceModule?.ClassroomDiagnosticTrace);const entries:ClassroomJournalEntry[]=[];const trace=new traceModule.ClassroomDiagnosticTrace({current:()=>({scope:'same',contextKey:'class:1:0'}),emit:entry=>entries.push(entry),notify:()=>true});const session=trace.create('application');trace.mark(session,'session_started');for(let i=0;i<300;i++)trace.create('provider');trace.mark(session,'session_ended');assert.equal(entries.at(-1)?.details?.phase,'session_ended');assert.equal(entries.at(-1)?.details?.spanId,session.spanId);
});

test('provider completion is journaled immediately but playback completion waits for every queued byte',()=>{
 assert(traceModule?.ClassroomDiagnosticTrace);const entries:ClassroomJournalEntry[]=[],messages:{state:string}[]=[];
 const trace=new traceModule.ClassroomDiagnosticTrace({current:()=>({scope:'same',contextKey:'class:1:0'}),emit:entry=>entries.push(entry),notify:value=>{messages.push(value);return true;}}),span=trace.create('provider');
 trace.audioQueued(span,3600);trace.audioSent(span);trace.audioDrained(span,2400);trace.responseDone(span);
 assert.equal(entries.filter(entry=>entry.details?.phase==='response_completed').length,1);assert.deepEqual(messages.map(value=>value.state),['started']);
 assert.equal(trace.playback({type:'diagnostic.playback',...span,phase:'playback_started',elapsedMs:0,queueMs:0}),true);assert.equal(trace.playback({type:'diagnostic.playback',...span,phase:'playback_finished',elapsedMs:10,queueMs:0}),false);
 trace.audioDrained(span,1200);trace.responseDone(span);assert.deepEqual(messages.map(value=>value.state),['started','completed']);
 const cancelled=trace.create('provider');trace.audioQueued(cancelled,2400);trace.audioSent(cancelled);trace.responseDone(cancelled);trace.interrupt();trace.audioDrained(cancelled,2400);assert.equal(messages.at(-1)?.state,'cancelled');
});

test('utterance associations carry only their real item identity and fixed deduplicated span metadata',()=>{
 assert(traceModule?.ClassroomDiagnosticTrace);const entries:ClassroomJournalEntry[]=[];
 const trace=new traceModule.ClassroomDiagnosticTrace({current:()=>({scope:'same',contextKey:'class:1:0'}),emit:entry=>entries.push(entry),notify:()=>true}),span=trace.create('speech');
 trace.associate(span,'real-child-item','child','speech');trace.associate(span,'real-child-item','child','speech');trace.associate(undefined,'unbound-teacher-item','teacher','speech');
 assert.equal(entries.length,1);assert.equal(entries[0].name,'diagnostic_association');assert.equal(entries[0].correlationId,'real-child-item');assert.equal(entries[0].text,undefined);assert.deepEqual(entries[0].details,{...span,source:'speech',contextKey:'class:1:0'});assert.match(entries[0].eventKey,/^diagnostic-association:[a-f0-9]{64}$/);
 trace.close();trace.associate(span,'after-close','child','speech');assert.equal(entries.length,1);
});
