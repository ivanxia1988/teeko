import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {encodeClassroomNotesCursor,decodeClassroomNotesCursor,parseClassroomNotesQuery,classroomNotesPageSchema} from '../lib/classroom-notes';
import {buildClassroomNote} from '../lib/server/classroom-notes';
import {teacherSnapshot} from './teacher-runtime-fixture';
const snapshot=()=>teacherSnapshot();
const source=()=>({epoch:1,itemId:'child-input',stepIndex:1,transcriptText:'My brother like dinosaurs.',transcriptSource:'speech',transcriptAt:'2026-11-11T01:00:00.000Z',contextKey:`${snapshot().id}:1:1`,decisionAt:'2026-11-11T01:00:01.000Z',decision:{decision:'conversation',confidence:'high',reason:'PRIVATE_REASON',suggestedResponse:'Your brother likes dinosaurs.',nextAction:'model'}});
test('the browser note contract does not pull in server projection or teaching instructions',async()=>{
 const contract=await readFile(new URL('../lib/classroom-notes.ts',import.meta.url),'utf8');assert.doesNotMatch(contract,/from\s+['"][^'"]*(?:server\/|teacher-instructions|teacher-agent|classroom-journal)/);
});
test('notes keep saved input and a generated model reference separate without promoting either to learning evidence',()=>{
 const note=buildClassroomNote(snapshot(),source());assert(note);assert.equal(note.original.text,source().transcriptText);assert.equal(note.reference.text,source().decision.suggestedResponse);assert.equal(note.reference.kind,'generated_teaching_reference');assert.equal(note.origin.itemId,'child-input');assert.equal(note.step.id,snapshot().course.steps[1].id);
 for(const hidden of ['PRIVATE_REASON','confidence','score','correct','provider','played','mastered'])assert(!JSON.stringify(note).includes(hidden),hidden);
 assert.equal(classroomNotesPageSchema.safeParse({ok:true,classroomId:snapshot().id,courseVersion:`${snapshot().course.id}:${snapshot().course.version}`,entries:[note],nextCursor:null,coverage:'retained_sources'}).success,true);
});
test('notes require a valid current course activity and matching saved connection/input association',()=>{
 for(const value of [null,{...source(),epoch:0},{...source(),epoch:2},{...source(),contextKey:'other:1:1'},{...source(),stepIndex:99},{...source(),itemId:' '},{...source(),transcriptText:''},{...source(),transcriptSource:'image'},{...source(),decisionAt:'wrong'},{...source(),authorized:true}])assert.equal(buildClassroomNote(snapshot(),value),null);
 assert.equal(buildClassroomNote({...snapshot(),course:{...snapshot().course,pages:[]}},source()),null);
});
test('notes omit low confidence, unsupported or long reference proposals and never manufacture a correction',()=>{
 for(const decision of [{...source().decision,confidence:'low'},{...source().decision,nextAction:'clarify'},{...source().decision,suggestedResponse:'x'.repeat(181)},{...source().decision,suggestedResponse:' '},{...source().decision,suggestedResponse:'one\ntwo'},{...source().decision,corrected:true}])assert.equal(buildClassroomNote(snapshot(),{...source(),decision}),null);
});
test('notes redact credentials in source excerpts and never expose a credential-bearing model reference',()=>{
 const note=buildClassroomNote(snapshot(),{...source(),transcriptText:'My api_key is sk-syntheticsecret12345. '+ 'a word '.repeat(60)});assert(note);assert(!note.original.text.includes('syntheticsecret'));assert(note.original.excerpt);assert(note.original.text.length<=300);
 assert.equal(buildClassroomNote(snapshot(),{...source(),decision:{...source().decision,suggestedResponse:'Use api_key: sk-syntheticsecret12345'}}),null);
});
test('cursor encoding is canonical, bounded and supports non-ASCII input IDs',()=>{
 const cursor={at:source().decisionAt,epoch:1,itemId:'孩子/one'};const encoded=encodeClassroomNotesCursor(cursor);assert.deepEqual(decodeClassroomNotesCursor(encoded),cursor);
 for(const value of ['',encoded+'=',encoded+'!', 'a'.repeat(1025),btoa(JSON.stringify({...cursor,itemId:'plain',accountId:'other'}))])assert.equal(decodeClassroomNotesCursor(value),null);
 assert.deepEqual(parseClassroomNotesQuery({}),{ok:true,query:{pageSize:5,cursor:null}});assert.deepEqual(parseClassroomNotesQuery({cursor:encoded,pageSize:'1'}),{ok:true,query:{pageSize:1,cursor}});
 for(const value of [{cursor:'bad'},{pageSize:0},{pageSize:11},{pageSize:1.5},{accountId:'other'}])assert.deepEqual(parseClassroomNotesQuery(value),{ok:false,reason:'invalid_query'});
});
