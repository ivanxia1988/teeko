import test from 'node:test';
import assert from 'node:assert/strict';
import type {ClassroomJournalEvent} from '../lib/classroom-journal';
import {projectClassroomDiagnostics,exportClassroomDiagnostics,isDiagnosticAnomaly} from '../lib/classroom-diagnostics';

const turn='00000000-0000-4000-8000-000000000001',span='00000000-0000-4000-8000-000000000002';
const event=(id:string,overrides:Partial<ClassroomJournalEvent>={},details:Record<string,unknown>={}):ClassroomJournalEvent=>({id,createdAt:'2026-11-12T00:00:00Z',epoch:1,revision:2,stepIndex:3,kind:'interaction',actor:'application',status:'recorded',name:'test_event',text:null,correlationId:null,...overrides,details} as ClassroomJournalEvent);

test('projection orders decimal IDs without mutating input and never groups by nearby time',()=>{
 const input=[event('9007199254740994'),event('9007199254740993')];
 const result=projectClassroomDiagnostics(input);
 assert.deepEqual(result.events.map(value=>value.id),['9007199254740993','9007199254740994']);
 assert.deepEqual(input.map(value=>value.id),['9007199254740994','9007199254740993']);
 assert.equal(result.turns.length,2);assert(result.turns.every(value=>value.association==='unknown'));
 assert.equal(result.coverage.unlinkedEventCount,2);assert.equal(result.coverage.complete,false);
 assert.equal(result.coverage.totalEventCount,null);
});
test('explicit unique span and correlation attach events to a turn only in the same epoch',()=>{
 const result=projectClassroomDiagnostics([
  event('1',{correlationId:'response_1'},{turnId:turn,spanId:span}),
  event('2',{}, {spanId:span}),event('3',{correlationId:'response_1'}),
  event('4',{epoch:2},{turnId:turn}),event('5',{epoch:2,correlationId:'response_1'}),
 ]);
 assert.deepEqual(result.turns[0].eventIds,['1','2','3']);assert.equal(result.turns[0].association,'turn');
 assert.equal(result.turns.length,3);assert.deepEqual(result.turns[1].eventIds,['4']);
});
test('ambiguous shared correlation never merges distinct explicit turns',()=>{
 const second='00000000-0000-4000-8000-000000000003';
 const result=projectClassroomDiagnostics([event('1',{correlationId:'shared'},{turnId:turn}),event('2',{correlationId:'shared'},{turnId:second}),event('3',{correlationId:'shared'})]);
 assert.equal(result.turns.length,3);assert.deepEqual(result.turns.map(value=>value.eventIds),[['1'],['2'],['3']]);
});
test('timing uses only bounded explicit values with a known clock and does not subtract timestamps',()=>{
 const result=projectClassroomDiagnostics([
  event('1',{}, {clock:'server',elapsedMs:15,queueMs:4,rttMs:90,spanId:span}),
  event('2',{createdAt:'2026-11-12T00:00:02Z'}, {clock:'client',elapsedMs:24,spanId:span}),
  event('3',{}, {elapsedMs:500}),event('4',{}, {clock:'server',elapsedMs:-1,queueMs:Infinity,rttMs:86_400_001}),
 ]);
 assert.deepEqual(result.events.map(value=>value.elapsedMs),[15,24,null,null]);
 assert.equal(result.events[0].queueMs,4);assert.equal(result.events[0].rttMs,90);
 assert.equal(result.events[3].queueMs,null);assert.equal(result.events[3].rttMs,null);
 assert.equal(result.coverage.timingEventCount,2);
});
test('first anomaly means first loaded failure or rejection, never absence of an uncollected stage',()=>{
 const result=projectClassroomDiagnostics([event('7',{status:'failed'}),event('3',{status:'rejected'}),event('2')],{coverage:'legacy_transcripts',totalEventCount:99});
 assert.equal(result.firstAnomaly?.id,'3');assert.equal(result.coverage.source,'legacy_transcripts');
 assert.equal(result.coverage.loadedEventCount,3);assert.equal(result.coverage.totalEventCount,99);
 assert.equal(result.coverage.complete,false);
 assert.equal(projectClassroomDiagnostics([event('1')]).firstAnomaly,null);
});
test('default export includes only loaded whitelisted metadata, never arbitrary text or identifiers',()=>{
 const sensitive='fixture-private-content';
 const input=[event('1',{text:sensitive,name:sensitive,correlationId:sensitive},{turnId:turn,spanId:span,clock:'server',elapsedMs:9,message:sensitive,errorCode:sensitive,question:sensitive,phase:sensitive,raw:sensitive})];
 const result=exportClassroomDiagnostics(projectClassroomDiagnostics(input,{coverage:'journal',complete:false,totalEventCount:100}));
 const serialized=JSON.stringify(result);
 assert(!serialized.includes(sensitive));assert(!serialized.includes('text'));assert(!serialized.includes('accountId'));
 assert.equal(result.coverage.loadedEventCount,1);assert.equal(result.coverage.totalEventCount,100);assert.equal(result.coverage.complete,false);
 assert.equal(result.events.length,1);assert.equal(result.events[0].turnId,turn);assert.equal(result.events[0].elapsedMs,9);
});
test('empty and legacy coverage explicitly describe no collected timing',()=>{
 const result=projectClassroomDiagnostics([],{coverage:'none',complete:true,totalEventCount:0});
 assert.equal(result.firstAnomaly,null);assert.equal(result.coverage.firstEventId,null);assert.equal(result.coverage.lastEventId,null);
 assert.equal(result.coverage.timingEventCount,0);assert.equal(result.coverage.complete,true);
});
test('generation and explicit client playback reports stay distinct without claiming delivery',()=>{
 const result=projectClassroomDiagnostics([event('1',{}, {source:'provider',playback:'generated'}),event('2',{}, {source:'client',phase:'playback_started',clock:'client'}),event('3',{}, {source:'unexpected',playback:'unknown'})]);
 assert.deepEqual(result.events.map(value=>value.source),['provider','client',null]);
 assert.deepEqual(result.events.map(value=>value.playback),['generated','client_reported',null]);
 assert.equal(result.events[1].elapsedMs,null);
});
test('explicit error phases and journal gaps are anomalies, while successful cancellation is not',()=>{
 const result=projectClassroomDiagnostics([event('1',{}, {phase:'response_cancelled'}),event('2',{}, {phase:'input_failed'}),event('3',{name:'journal_gap'}),event('4',{}, {phase:'error'})]);
 assert.deepEqual(result.events.map(isDiagnosticAnomaly),[false,true,true,true]);assert.equal(result.firstAnomaly?.id,'2');
});
test('overlapping pages deduplicate loaded IDs and do not claim completeness with missing events',()=>{
 const result=projectClassroomDiagnostics([event('1'),event('1'),event('3')],{complete:true,totalEventCount:3});
 assert.equal(result.events.length,2);assert.equal(result.coverage.loadedEventCount,2);assert.equal(result.coverage.complete,false);
});
test('export coverage uses an explicit whitelist even if the caller attaches extra context',()=>{
 const projection=projectClassroomDiagnostics([]);
 Object.assign(projection.coverage,{accountId:'fixture-context-to-omit',email:'fixture-email-to-omit'});
 const serialized=JSON.stringify(exportClassroomDiagnostics(projection));
 assert(!serialized.includes('fixture-context-to-omit'));assert(!serialized.includes('fixture-email-to-omit'));
});
test('fault codes and state are visible as sanitized bounded labels but omitted from the metadata export',()=>{
 const result=projectClassroomDiagnostics([event('1',{status:'failed'},{errorCode:'provider_error',state:'closed'}),event('2',{}, {errorCode:'xai-abcdefghijklmnop',state:'sk-abcdefghijklmnop'})]);
 assert.equal(result.events[0].errorCode,'provider_error');assert.equal(result.events[0].state,'closed');
 assert(!JSON.stringify(result).includes('abcdefghijklmnop'));assert(!JSON.stringify(exportClassroomDiagnostics(result)).includes('provider_error'));
});
test('scoped diagnostic exports carry stable classroom and persistent event IDs without free text',()=>{
 const classroomId='10000000-0000-4000-8000-000000000001';
 const projection=projectClassroomDiagnostics([event('9007199254740993',{text:'do-not-share-dialogue',correlationId:'do-not-share-provider-id'})],{coverage:'journal'});
 const result=exportClassroomDiagnostics(projection,classroomId);
 assert.equal(result.diagnosticId,`TKLOG1:${classroomId}`);assert.equal(result.events[0].diagnosticId,`TKLOG1:${classroomId}:E9007199254740993`);
 assert(!JSON.stringify(result).includes('do-not-share'));assert.equal(result.coverage.complete,false);
});
test('legacy export IDs locate only the classroom and unscoped exports keep their existing shape',()=>{
 const classroomId='10000000-0000-4000-8000-000000000001';const projection=projectClassroomDiagnostics([event('1')],{coverage:'legacy_transcripts'});
 const result=exportClassroomDiagnostics(projection,classroomId);assert.equal(result.diagnosticId,`TKLOG1:${classroomId}`);assert.equal(result.events[0].diagnosticId,undefined);
 assert.equal(exportClassroomDiagnostics(projection).diagnosticId,undefined);assert.throws(()=>exportClassroomDiagnostics(projection,'invalid-classroom'));
});
const providerError={providerErrorType:'invalid_request_error',providerErrorCode:'invalid_value',providerErrorParam:'response.cancel',requestCorrelation:'matched',requestId:'tkreq_00000000-0000-4000-8000-000000000001',requestType:'response.cancel'};
test('projection and diagnostic export retain fixed provider error facts without provider messages',()=>{
 const projection=projectClassroomDiagnostics([event('1',{status:'failed',name:'voice_provider_failure',text:'omit-provider-body',correlationId:'omit-provider-id'},{...providerError,message:'omit-provider-body',rawEvent:{private:'omit-provider-body'}})]);
 for(const [key,value]of Object.entries(providerError))assert.equal(Reflect.get(projection.events[0],key),value,key);
 const exported=exportClassroomDiagnostics(projection);for(const [key,value]of Object.entries(providerError))assert.equal(Reflect.get(exported.events[0],key),value,key);
 assert(!JSON.stringify(exported).includes('omit-provider'));assert(!JSON.stringify(exported).includes('rawEvent'));
});
test('unknown provider error labels and arbitrary provider IDs are never promoted to export metadata',()=>{
 const projection=projectClassroomDiagnostics([event('1',{}, {providerErrorType:'unapproved-type',providerErrorCode:'unapproved-code',providerErrorParam:'session.unapproved-prompt',requestCorrelation:'unapproved-correlation',requestId:'provider-unapproved-id',requestType:'unapproved-command'})]);
 for(const key of Object.keys(providerError))assert.equal(Reflect.get(projection.events[0],key),undefined,key);
 assert(!JSON.stringify(exportClassroomDiagnostics(projection)).includes('unapproved'));
 Object.assign(projection.events[0],{...providerError,requestId:'provider-unapproved-id',providerErrorParam:'unapproved-param',requestType:'unapproved-command',rawMessage:'unapproved-body'});
 const exported=exportClassroomDiagnostics(projection);assert.equal(exported.events[0].providerErrorType,'invalid_request_error');assert.equal(exported.events[0].requestCorrelation,'matched');
 assert(!JSON.stringify(exported).includes('unapproved'));
});
test('diagnostic export preserves safe point linkage, stages, reasons and capability versions with independent validation',()=>{
 const metadata={pointId:turn,pointStage:'timeout',pointReason:'ack_timeout',clientDiagnosticsVersion:1,clientPointVersion:1};const projection=projectClassroomDiagnostics([event('1',{},metadata)]),result=exportClassroomDiagnostics(projection);
 for(const [key,value]of Object.entries(metadata))assert.equal(Reflect.get(result.events[0],key),value);
 Object.assign(projection.events[0],{pointStage:'raw-stage',pointReason:'private-body',pointId:'provider-arbitrary',clientDiagnosticsVersion:99});assert(!JSON.stringify(exportClassroomDiagnostics(projection)).includes('private-body'));assert.equal(Reflect.get(exportClassroomDiagnostics(projection).events[0],'pointStage'),undefined);
});
test('provider error inspection survives diagnostic export only as fixed metadata and fingerprints',()=>{
 const metadata={providerErrorReason:'empty_output',providerErrorCodeKind:'missing',providerErrorCodeShape:'none',providerErrorMessageFingerprint:'abcdef0123456789',providerErrorMessageCategories:['response','empty','text']};const projection=projectClassroomDiagnostics([event('1',{},metadata)]);const exported=exportClassroomDiagnostics(projection);for(const[key,value]of Object.entries(metadata))assert.deepEqual(Reflect.get(exported.events[0],key),value);
 Object.assign(projection.events[0],{providerErrorReason:'raw-message',providerErrorCodeFingerprint:'private-token',providerErrorMessageCategories:['private-message']});const safe=exportClassroomDiagnostics(projection);assert.equal(Reflect.get(safe.events[0],'providerErrorReason'),undefined);assert(!JSON.stringify(safe).includes('private'));
});
test('recovery export retains fixed checking actions and stages without opening free state or action fields',()=>{
 const projection=projectClassroomDiagnostics([event('1',{name:'voice_provider_failure',status:'failed'},{action:'recovery_check'}),event('2',{name:'voice_request_recovery'},{state:'checking'}),event('3',{name:'voice_request_recovery'},{state:'private-state',action:'private-action'})]);const exported=exportClassroomDiagnostics(projection);assert.equal(Reflect.get(exported.events[0],'providerErrorAction'),'recovery_check');assert.equal(Reflect.get(exported.events[1],'recoveryState'),'checking');assert(!JSON.stringify(exported).includes('private-'));
});
