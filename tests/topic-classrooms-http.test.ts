import test from 'node:test';
import assert from 'node:assert/strict';
import {TOPIC_CATALOG,encodeTopicHistoryCursor} from '../lib/topic-learning';
import {createClassroomHandler,isClassroomApi} from '../lib/server/classroom-http';

test('topic catalogue is public while history is authenticated even before profile completion',async()=>{
 let signedIn=false,authenticationCalls=0;const historyCalls:unknown[][]=[];
 const handler=createClassroomHandler({origin:'http://localhost',authenticate:async()=>{authenticationCalls++;return signedIn?{id:'owner',profileComplete:false}:null;},providers:()=>[],limit:async()=>{},service:{
  topics:async()=>TOPIC_CATALOG,topicHistory:async(...args:unknown[])=>{historyCalls.push(args);return{records:[],nextCursor:null,activeClassroom:null};},
 } as never});
 const get=(path:string)=>new Request(`http://localhost/api/v1${path}`);
 assert(isClassroomApi('/api/v1/topics'));assert(isClassroomApi('/api/v1/topics/history'));
 const catalog=await handler(get('/topics'));assert.equal(catalog.status,200);assert.equal(authenticationCalls,0);
 const data=await catalog.json() as {topics:unknown};
 assert.deepEqual(data.topics,TOPIC_CATALOG);assert.match(catalog.headers.get('cache-control')??'',/no-store/);
 assert.equal((await handler(get('/topics/history'))).status,401);
 signedIn=true;const response=await handler(get('/topics/history?pageSize=6'));assert.equal(response.status,200);
 assert.deepEqual(historyCalls,[['owner',{pageSize:'6'}]]);assert.match(response.headers.get('cache-control')??'',/no-store/);
 assert.equal((await handler(get('/classrooms'))).status,409);
});

test('topic history accepts only bounded canonical pagination and no client ownership',async()=>{
 const calls:unknown[][]=[];
 const handler=createClassroomHandler({origin:'http://localhost',authenticate:async()=>({id:'owner',profileComplete:true}),providers:()=>[],limit:async()=>{},service:{topics:async()=>[],topicHistory:async(...args:unknown[])=>{calls.push(args);return{records:[],nextCursor:null,activeClassroom:null};}} as never});
 const url='http://localhost/api/v1/topics/history';
 for(const query of ['?cursor=bad','?pageSize=0','?pageSize=21','?pageSize=1&pageSize=2','?accountId=someone','?offset=2'])assert.equal((await handler(new Request(url+query))).status,400);
 const cursor=encodeTopicHistoryCursor({endedAt:'2026-11-21T00:00:00.000Z',id:'00000000-0000-4000-8000-000000000001'});
 assert.equal((await handler(new Request(`${url}?pageSize=2&cursor=${cursor}`))).status,200);assert.equal(calls.length,1);
 assert.equal((await handler(new Request(url,{method:'POST',headers:{Origin:'http://localhost'},body:'{}'}))).status,405);
 assert.equal((await handler(new Request('http://localhost/api/v1/topics?accountId=someone'))).status,400);
});
