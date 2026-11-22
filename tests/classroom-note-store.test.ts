import test from 'node:test';
import assert from 'node:assert/strict';
import {teacherSnapshot} from './teacher-runtime-fixture';
import {buildClassroomNote} from '../lib/server/classroom-notes';
import {parseStoredClassroomNote,parseClassroomNoteManifest,pageClassroomNoteManifest} from '../lib/server/classroom-note-store';
import {decodeClassroomNotesCursor} from '../lib/classroom-notes';
const snapshot=teacherSnapshot(),at='2026-11-11T01:00:01.000123Z';
const note=buildClassroomNote(snapshot,{epoch:1,itemId:'child-1',stepIndex:1,transcriptText:'I likes apples.',transcriptSource:'speech',transcriptAt:'2026-11-11T01:00:00.000Z',contextKey:`${snapshot.id}:1:1`,decisionAt:'2026-11-11T01:00:01.000Z',decision:{decision:'retry',confidence:'high',reason:'PRIVATE_REASON',suggestedResponse:'I like apples.',nextAction:'model'}})!;
const owner={id:snapshot.id,course:snapshot.course,connectionEpoch:1,startedAt:'2026-11-11T01:00:00.000Z',endedAt:'2026-11-11T01:10:00.000Z'};
test('stored notes validate the immutable lesson, input identity and time range again',()=>{
 assert(parseStoredClassroomNote(owner,{card:note,at}));
 for(const card of [{...note,id:'other'},{...note,step:{...note.step,id:'unknown'}},{...note,origin:{...note.origin,connectionEpoch:2}},{...note,reference:{...note.reference,text:'api_key: sk-syntheticsecret12345'}},{...note,original:{...note.original,recordedAt:'2025-01-01T00:00:00Z'}},{...note,reason:'private'}])assert.equal(parseStoredClassroomNote(owner,{card,at}),null);
 assert.equal(parseStoredClassroomNote(owner,{card:note,at:'2026-11-11T01:00:00.000Z'}),null);
});
test('a finalized manifest is bounded and tied to the exact ended revision and course',()=>{
 const manifest={version:1,classroomId:snapshot.id,courseVersion:`${snapshot.course.id}:${snapshot.course.version}`,sourceRevision:4,coverage:'captured_sources',entries:[{card:note,at}]};
 assert(parseClassroomNoteManifest(owner,4,manifest));
 for(const changed of [{sourceRevision:3},{courseVersion:'other:1'},{classroomId:'20000000-0000-4000-8000-000000000001'},{entries:Array(257).fill({card:note,at})},{entries:[{card:{...note,reason:'private'},at}]},{score:100}])assert.equal(parseClassroomNoteManifest(owner,4,{...manifest,...changed}),null);
});
test('manifest pagination preserves stable microsecond and input ordering without exposing private metadata',()=>{
 const older={card:{...note,id:'1:child-2',origin:{...note.origin,itemId:'child-2'}},at:'2026-11-11T01:00:01.000122Z'};
 const manifest={version:1 as const,classroomId:snapshot.id,courseVersion:`${snapshot.course.id}:${snapshot.course.version}`,sourceRevision:4,coverage:'captured_sources' as const,entries:[{card:note,at},older]};
 const first=pageClassroomNoteManifest(manifest,{pageSize:1,cursor:null});assert.equal(first.entries[0].id,note.id);assert(first.nextCursor);const cursor=decodeClassroomNotesCursor(first.nextCursor);assert(cursor);assert.equal(cursor.at,at);
 const second=pageClassroomNoteManifest(manifest,{pageSize:1,cursor});assert.equal(second.entries[0].id,older.card.id);assert.equal(second.nextCursor,null);assert(!JSON.stringify(first).includes('sourceRevision'));
});
