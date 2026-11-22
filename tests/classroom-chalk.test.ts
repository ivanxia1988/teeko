import test from 'node:test';
import assert from 'node:assert/strict';
import {ClassroomChalkBoard,validateClassroomChalkWriting} from '../lib/domain/classroom-chalk';
const context=()=>({logicalSessionId:'chalk-lesson',courseVersion:'picnic:2',connectionEpoch:1,stateRevision:1,pageId:'page-1',activityId:'say-apple'});
const current=()=>({status:'active',context:context()});
const id=(n=1)=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-000000000001`;
const writing=(n=1)=>({type:'chalk.write',id:id(n),receivedAtMs:10000,expiresAtMs:18000,context:context(),text:'I like apples.'});

test('chalk is bounded immutable plain text, never scores, HTML templates or an execution receipt',()=>{
 const input=writing(),result=validateClassroomChalkWriting(current(),input,10000);assert(result.accepted);input.text='changed';input.context.pageId='other';assert.equal(result.writing.text,'I like apples.');assert.equal(result.writing.context.pageId,'page-1');assert(Object.isFrozen(result.writing));assert(Object.isFrozen(result.writing.context));
 for(const invalid of [{...writing(),text:''},{...writing(),text:' '},{...writing(),text:'x'.repeat(121)},{...writing(),text:'one\ntwo'},{...writing(),id:'bad'},{...writing(),score:100},{...writing(),played:true},{...writing(),html:'<b>Apple</b>'},{...writing(),image:'PRIVATE_IMAGE'},{...writing(),expiresAtMs:11999},{...writing(),expiresAtMs:30001}])assert.deepEqual(validateClassroomChalkWriting(current(),invalid,10000),{accepted:false,reason:'invalid_chalk'});
 assert(validateClassroomChalkWriting(current(),{...writing(),text:'x'.repeat(120),expiresAtMs:12000},10000).accepted);
});
for(const [field,value] of [['logicalSessionId','other'],['courseVersion','picnic:3'],['connectionEpoch',2],['stateRevision',2],['pageId','other'],['activityId','other']] as const)test(`chalk cannot survive a changed ${field}`,()=>{
 let now=10000;const board=new ClassroomChalkBoard(()=>now);assert(board.write(current(),writing()).accepted);assert.equal(board.read({status:'active',context:{...context(),[field]:value}}),null);now=10001;assert.equal(board.read(current()),null);
});
for(const status of ['preflight','paused','ending','ended'])test(`chalk is cancelled by ${status} and cannot reappear on resume`,()=>{
 const board=new ClassroomChalkBoard(()=>10000);assert(board.write(current(),writing()).accepted);assert.equal(board.read({status,context:context()}),null);assert.equal(board.read(current()),null);
});
test('chalk expiry is exclusive and clearing cannot replay a previously accepted writing',()=>{
 let now=10000;const board=new ClassroomChalkBoard(()=>now);assert(board.write(current(),writing()).accepted);now=17999;assert.equal(board.read(current())?.id,id());now=18000;assert.equal(board.read(current()),null);assert.equal(board.write(current(),writing()).accepted,false);
 now=18001;const next={...writing(2),receivedAtMs:18001,expiresAtMs:20001};assert(board.write(current(),next).accepted);board.clear();assert.equal(board.read(current()),null);assert.deepEqual(board.write(current(),next),{accepted:false,reason:'duplicate'});
});
test('a newer writing owns its own deadline and a stale proposal cannot erase it',()=>{
 let now=10000;const board=new ClassroomChalkBoard(()=>now);assert(board.write(current(),writing()).accepted);now=15000;
 const next={...writing(2),text:'I like bananas.',receivedAtMs:15000,expiresAtMs:23000};assert(board.write(current(),next).accepted);assert.equal(board.write(current(),{...writing(3),score:100}).accepted,false);now=18000;assert.equal(board.read(current())?.text,'I like bananas.');now=23000;assert.equal(board.read(current()),null);
});
test('invalid and backward clocks clear chalk permanently without reopening earlier text',()=>{
 for(const invalid of [NaN,Infinity,-1,9999,Number.MAX_SAFE_INTEGER+1]){let now=10000;const board=new ClassroomChalkBoard(()=>now);assert(board.write(current(),writing()).accepted);now=invalid;assert.equal(board.read(current()),null);now=10000;assert.equal(board.read(current()),null);}
 for(const now of [NaN,10000.5,-1])assert.deepEqual(validateClassroomChalkWriting(current(),writing(),now),{accepted:false,reason:'invalid_time'});
 assert.deepEqual(validateClassroomChalkWriting(current(),writing(),9999),{accepted:false,reason:'future_writing'});
});
test('chalk deduplication is bounded and closing is irreversible',()=>{
 const board=new ClassroomChalkBoard(()=>10000);for(let n=1;n<=250;n++){assert(board.write(current(),writing(n)).accepted);board.clear();}assert.deepEqual(board.write(current(),writing(251)),{accepted:false,reason:'seen_limit'});assert.equal(board.read(current()),null);
 board.close();board.close();assert.deepEqual(board.write(current(),writing(252)),{accepted:false,reason:'closed'});assert.equal(board.read(current()),null);
});
