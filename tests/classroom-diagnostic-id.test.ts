import test from 'node:test';
import assert from 'node:assert/strict';
const diagnosticIdModule=await import('../lib/classroom-diagnostic-id').catch(()=>null);
const classroomId='10000000-0000-4000-8000-000000000001',otherId='10000000-0000-4000-8000-000000000002';

test('classroom diagnostic IDs round-trip without containing account details or content',()=>{
 assert(diagnosticIdModule?.formatClassroomDiagnosticId);assert(diagnosticIdModule.parseClassroomDiagnosticId);
 const value=diagnosticIdModule.formatClassroomDiagnosticId({classroomId});assert.equal(value,`TKLOG1:${classroomId}`);
 assert.deepEqual(diagnosticIdModule.parseClassroomDiagnosticId(value),{classroomId});
});
test('persistent event references keep the complete PostgreSQL bigint as a string',()=>{
 assert(diagnosticIdModule);for(const eventId of ['1','9007199254740993','9223372036854775807']){
 const reference={classroomId,eventId},value=diagnosticIdModule.formatClassroomDiagnosticId(reference);
 assert.equal(value,`TKLOG1:${classroomId}:E${eventId}`);assert.deepEqual(diagnosticIdModule.parseClassroomDiagnosticId(value),reference);
 }
});
test('the same event number in different classrooms never produces the same reference',()=>{
 assert(diagnosticIdModule);assert.notEqual(diagnosticIdModule.formatClassroomDiagnosticId({classroomId,eventId:'42'}),diagnosticIdModule.formatClassroomDiagnosticId({classroomId:otherId,eventId:'42'}));
});
test('copied whitespace is trimmed and UUID spelling is canonicalized',()=>{
 assert(diagnosticIdModule);const upper='ABCDEFAB-1234-4000-8000-ABCDEFABCDEF';
 assert.equal(diagnosticIdModule.formatClassroomDiagnosticId({classroomId:upper}),`TKLOG1:${upper.toLowerCase()}`);
 assert.deepEqual(diagnosticIdModule.parseClassroomDiagnosticId(` \nTKLOG1:${upper}:E12\n `),{classroomId:upper.toLowerCase(),eventId:'12'});
});
test('parsing rejects malformed, unscoped and out-of-range references without echoing input',()=>{
 assert(diagnosticIdModule);for(const value of [null,{},1,'','42',classroomId,`TKLOG2:${classroomId}`,`TKLOG1:${classroomId}:E0`,`TKLOG1:${classroomId}:E01`,`TKLOG1:${classroomId}:E-1`,`TKLOG1:${classroomId}:E9223372036854775808`,`TKLOG1:${classroomId}:E1:extra`,`https://example.test/TKLOG1:${classroomId}`,`TKLOG1:invalid`, 'x'.repeat(200)])assert.equal(diagnosticIdModule.parseClassroomDiagnosticId(value),null);
});
test('formatting rejects invalid IDs and unexpected metadata rather than copying it',()=>{
 assert(diagnosticIdModule);for(const reference of [{classroomId:'bad'},{classroomId,eventId:'0'},{classroomId,eventId:'9223372036854775808'},{classroomId,email:'do-not-copy@example.test'}])assert.throws(()=>diagnosticIdModule.formatClassroomDiagnosticId(reference));
});
test('temporary legacy rows and invalid event zero never receive a persistent event ID',()=>{
 assert(diagnosticIdModule?.formatPersistentEventDiagnosticId);const reference={classroomId,eventId:'1'};
 assert.equal(diagnosticIdModule.formatPersistentEventDiagnosticId(reference,'journal'),`TKLOG1:${classroomId}:E1`);
 for(const coverage of ['legacy_transcripts','none'] as const)assert.equal(diagnosticIdModule.formatPersistentEventDiagnosticId(reference,coverage),null);
 assert.equal(diagnosticIdModule.formatPersistentEventDiagnosticId({classroomId,eventId:'0'},'journal'),null);
});
