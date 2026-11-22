import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeClassroomJournalEntry,type ClassroomJournalEvent} from '../lib/classroom-journal';
import {projectClassroomDiagnostics,exportClassroomDiagnostics} from '../lib/classroom-diagnostics';
const measurementId='10000000-0000-4000-8000-000000000001',inputId='20000000-0000-4000-8000-000000000001';
const entry=(details:Record<string,unknown>)=>sanitizeClassroomJournalEntry({eventKey:'latency-fixture',kind:'connection',actor:'application',status:'recorded',name:'latency_stage',details});

test('latency journal keeps bounded measurement metadata and discards arbitrary payloads',()=>{
 const result=entry({measurementId,latencyInputId:inputId,latencyStage:'playback_started',latencyBasis:'application_window',waitMs:3200,playbackMs:140,captureGapMs:100,prompt:'private text',audio:'private bytes'});
 assert.deepEqual(result.details,{measurementId,latencyInputId:inputId,latencyStage:'playback_started',latencyBasis:'application_window',waitMs:3200,playbackMs:140,captureGapMs:100});
});

test('latency metadata refuses unsafe identifiers, nonfinite durations and invented stages',()=>{
 assert.deepEqual(entry({measurementId:'invalid',latencyInputId:'invalid',latencyStage:'model_reasoning',latencyBasis:'guess',waitMs:-1,playbackMs:120001,captureGapMs:10001}).details,{});
 assert.deepEqual(entry({waitMs:Infinity,playbackMs:NaN}).details,{});
});

function event(details:Record<string,unknown>):ClassroomJournalEvent{return{id:'9007199254740993',createdAt:'2026-11-15T00:00:00.000Z',epoch:1,revision:1,stepIndex:0,kind:'connection',actor:'application',status:'recorded',name:'latency_stage',text:'Private speech',correlationId:'private-provider-id',details:entry(details).details??{}};}
test('diagnostic export includes only safe latency metadata while retaining bigint event IDs',()=>{
 const projection=projectClassroomDiagnostics([event({measurementId,latencyInputId:inputId,latencyStage:'playback_started',latencyBasis:'provider_turn',clock:'client',waitMs:3200,playbackMs:140})]);
 const result=exportClassroomDiagnostics(projection),row=result.events[0] as unknown as Record<string,unknown>;
 assert.equal(row.id,'9007199254740993');assert.equal(row.measurementId,measurementId);assert.equal(row.waitMs,3200);assert.equal(row.playbackMs,140);assert.equal(row.latencyStage,'playback_started');assert.equal(row.latencyBasis,'provider_turn');
 assert.equal(projection.coverage.timingEventCount,1);
 assert(!JSON.stringify(result).includes('Private speech'));assert(!JSON.stringify(result).includes('private-provider-id'));
});
test('legacy events do not gain invented latency or measured zero values',()=>{
 const row=exportClassroomDiagnostics(projectClassroomDiagnostics([event({})])).events[0] as unknown as Record<string,unknown>;
 assert(!('waitMs' in row));assert(!('measurementId' in row));
});

test('advanced diagnostics group explicit measurement IDs without treating them as unlinked turns',()=>{
 const first=event({measurementId,latencyStage:'input_received'}),second={...event({measurementId,latencyStage:'input_final'}),id:'9007199254740994'};
 const result=projectClassroomDiagnostics([first,second]);assert.equal(result.turns.length,1);assert.equal(result.turns[0].association,'measurement');assert.equal(result.coverage.unlinkedEventCount,0);
 const other={...second,id:'9007199254740995',epoch:2};assert.equal(projectClassroomDiagnostics([first,other]).turns.length,2);
});

test('pending server snapshots keep their same-origin elapsed time separately from client total wait',()=>{
 const details=entry({measurementId,latencyStage:'wait_update',clock:'server',elapsedMs:2400,state:'waiting_reply'}).details!;assert.equal(details.latencyStage,'wait_update');assert.equal(details.elapsedMs,2400);assert(!('waitMs' in details));
});

test('latency exports preserve only fixed diagnostic states and omit arbitrary state text',()=>{
 const exported=(details:Record<string,unknown>)=>exportClassroomDiagnostics(projectClassroomDiagnostics([event(details)])).events[0] as unknown as Record<string,unknown>;
 assert.equal(exported({measurementId,latencyStage:'unmeasured',state:'playback_clock'}).latencyState,'playback_clock');
 assert.equal(exported({measurementId,latencyStage:'wait_update',state:'waiting_audio'}).latencyState,'waiting_audio');
 assert(!('latencyState' in exported({measurementId,state:'private text'})));
 assert(!('latencyState' in exported({state:'playback_clock'})));
});
