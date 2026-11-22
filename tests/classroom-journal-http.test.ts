import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdminHandler} from '../lib/server/admin-http';
const origin='http://127.0.0.1:8082',classroomId='10000000-0000-4000-8000-000000000001';
test('journal routes require admin authentication and forward only validated bounded filters',async()=>{
 let user:{id:string}|null=null,admin=false;const calls:unknown[][]=[];
 const handler=createAdminHandler({origin,authenticate:async()=>user,service:{isAdmin:async()=>admin} as never,providers:()=>({qwen:true,openai:true}),limit:async()=>{},preview:async()=>'',tryout:async()=>null,journal:{list:async(...args:unknown[])=>{calls.push(args);return{classrooms:[],total:0,page:0,pageSize:20};},events:async(...args:unknown[])=>{calls.push(args);return{classroom:{id:classroomId},events:[],nextCursor:null,coverage:'none'} as never;}}});
 const get=(path:string)=>handler(new Request(`${origin}/api/v1/admin${path}`));
 assert.equal((await get('/classrooms')).status,401);user={id:'admin'};assert.equal((await get('/classrooms')).status,403);assert.equal(calls.length,0);
 admin=true;assert.equal((await get('/classrooms?query=Leo&from=2026-11-01&to=2026-11-02')).status,200);
 assert.deepEqual(calls[0],['admin',{query:'Leo',from:'2026-11-01',to:'2026-11-02',page:0,pageSize:20}]);
 assert.equal((await get(`/classrooms/${classroomId}/events?after=9007199254740993&limit=25`)).status,200);
 assert.deepEqual(calls[1],['admin',classroomId,{after:'9007199254740993',limit:25}]);
 for(const path of ['/classrooms?pageSize=1000','/classrooms?from=2026-02-30','/classrooms?from=2026-11-02&to=2026-11-01',`/classrooms/${classroomId}/events?after=-1`,'/classrooms/not-an-id/events'])assert.equal((await get(path)).status,400,path);
 assert.equal(calls.length,2);admin=false;assert.equal((await get(`/classrooms/${classroomId}/events`)).status,403);
});
test('journal queries enforce admin host and never expose database errors',async()=>{
 const handler=createAdminHandler({origin,authenticate:async()=>({id:'admin'}),service:{isAdmin:async()=>true} as never,providers:()=>({qwen:true,openai:true}),limit:async()=>{},preview:async()=>'',tryout:async()=>null,journal:{list:async()=>{throw Error('PRIVATE_DATABASE_PAYLOAD');},events:async()=>{throw Error('PRIVATE_DATABASE_PAYLOAD');}}});
 assert.equal((await handler(new Request('http://127.0.0.1:8080/api/v1/admin/classrooms'))).status,403);
 const response=await handler(new Request(`${origin}/api/v1/admin/classrooms`));assert.equal(response.status,503);assert(!(await response.text()).includes('PRIVATE'));
});
