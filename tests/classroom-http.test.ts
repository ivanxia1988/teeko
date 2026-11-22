import test from 'node:test';
import assert from 'node:assert/strict';

test('formal classroom API authenticates, enforces same origin, validates actions and never trusts ownership input',async()=>{
  const {createClassroomHandler}=await import('../lib/server/classroom-http.ts');
  const calls:unknown[]=[];let signedIn=true;
  const handler=createClassroomHandler({origin:'http://127.0.0.1:8080',authenticate:async()=>signedIn?{id:'owner',profileComplete:true}:null,service:{
    courses:async(id:string)=>{calls.push(id);return {courses:[],activeClassroom:null};},
    preferences:async()=>({provider:'qwen',language:'bilingual',style:'gentle',voice:'female',soundEffects:true}),
    savePreferences:async()=>({}), get:async()=>({id:'classroom'}),create:async()=>({id:'new'}),action:async()=>({id:'saved'}),
  } as never,providers:()=>[{id:'qwen',name:'通义',configured:true}],limit:async()=>{}});
  const req=(path:string,body?:unknown,origin='http://127.0.0.1:8080')=>new Request(`http://127.0.0.1:8080/api/v1${path}`,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body),headers:{Origin:origin,'Content-Type':'application/json'}})});
  signedIn=false;assert.equal((await handler(req('/courses'))).status,401);
  signedIn=true;assert.equal((await handler(req('/courses'))).status,200);assert.deepEqual(calls,['owner']);
  assert.equal((await handler(req('/classrooms',{courseId:'picnic'},'https://outside.example'))).status,403);
  assert.equal((await handler(req('/classrooms',{courseId:'picnic',accountId:'someone-else'}))).status,400);
  const id='00000000-0000-4000-8000-000000000001';
  assert.equal((await handler(req(`/classrooms/${id}/actions`,{eventId:crypto.randomUUID(),expectedRevision:0,type:'select',objectIds:['apple'],correct:true}))).status,400);
  assert.equal((await handler(req(`/classrooms/${id}/actions`,{eventId:crypto.randomUUID(),expectedRevision:0,type:'select',objectIds:['apple']}))).status,200);
  assert.equal((await handler(req('/classrooms/not-a-uuid'))).status,404);
});

test('lesson note reads authenticate and validate pagination without exposing actions or accepting ownership input',async()=>{
 const {createClassroomHandler}=await import('../lib/server/classroom-http');const calls:unknown[]=[];let signedIn=true,profileComplete=true;
 const id='00000000-0000-4000-8000-000000000001';
 const handler=createClassroomHandler({origin:'http://localhost',authenticate:async()=>signedIn?{id:'owner',profileComplete}:null,providers:()=>[],limit:async()=>{},service:{notes:async(...args:unknown[])=>{calls.push(args);return{classroomId:id,courseVersion:'picnic:2',entries:[],nextCursor:null,coverage:'retained_sources'};},action:async()=>{throw new Error('notes must never dispatch an action');}} as never});
 const get=(query='')=>new Request(`http://localhost/api/v1/classrooms/${id}/notes${query}`);
 signedIn=false;assert.equal((await handler(get())).status,401);signedIn=true;profileComplete=false;assert.notEqual((await handler(get())).status,200);profileComplete=true;
 const response=await handler(get('?pageSize=1'));assert.equal(response.status,200);assert.match(response.headers.get('cache-control')??'',/no-store/);assert.equal(calls.length,1);assert.deepEqual(calls[0],['owner',id,{pageSize:'1'}]);
 for(const query of ['?cursor=bad','?pageSize=11','?pageSize=1.5','?accountId=other','?pageSize=1&pageSize=2'])assert.equal((await handler(get(query))).status,400);
 assert.equal((await handler(new Request(get().url,{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json'},body:'{}'}))).status,405);assert.equal(calls.length,1);
});

test('only successful authenticated navigation sends the trusted owner interruption reason',async()=>{
 const {createClassroomHandler}=await import('../lib/server/classroom-http');
 const changes:unknown[][]=[];let fail=false,signedIn=true;
 const id='00000000-0000-4000-8000-000000000001',origin='http://localhost';
 const handler=createClassroomHandler({origin,authenticate:async()=>signedIn?{id:'owner',profileComplete:true}:null,providers:()=>[],limit:async()=>{},changed:async(...args)=>{changes.push(args);},service:{action:async()=>{if(fail)throw new Error('synthetic action failure');return{id};}} as never});
 const action=(type:string,extra={})=>new Request(`${origin}/api/v1/classrooms/${id}/actions`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({type,eventId:crypto.randomUUID(),expectedRevision:1,...extra})});
 for(const type of ['next','skip','pause','resume','end']){assert.equal((await handler(action(type))).status,200);assert.deepEqual(changes.at(-1),[id,'explicit_navigation']);}
 assert.equal((await handler(action('hint'))).status,200);assert.deepEqual(changes.at(-1),[id,undefined]);
 const count=changes.length;fail=true;assert.equal((await handler(action('next'))).status,503);fail=false;signedIn=false;assert.equal((await handler(action('next'))).status,401);signedIn=true;
 assert.equal((await handler(action('hint',{reason:'explicit_navigation'}))).status,400);assert.equal(changes.length,count);
});

test('point diagnostic batches authenticate, enforce origin and rate limits, and cannot submit server authority',async()=>{
 const {createClassroomHandler}=await import('../lib/server/classroom-http');const id='00000000-0000-4000-8000-000000000001',origin='http://localhost',calls:unknown[][]=[];let signed=true,limited=false,limits=0;
 const handler=createClassroomHandler({origin,authenticate:async()=>signed?{id:'owner',profileComplete:true}:null,providers:()=>[],limit:async()=>{limits++;},limitDiagnostics:async()=>{if(limited)throw{code:'RATE_LIMITED',status:429,message:'请稍后重试。'};},service:{pointDiagnostics:async(...args:unknown[])=>{calls.push(args);}}as never});
 const event={id:crypto.randomUUID(),pointId:crypto.randomUUID(),context:{logicalSessionId:id,courseVersion:'robot:1',connectionEpoch:1,stateRevision:2,pageId:'p1',activityId:'reading'},stage:'send_failed',reason:'not_ready',objectId:'wings'};
 const request=(body:unknown={events:[event]},headers:Record<string,string>={Origin:origin},method='POST')=>new Request(`${origin}/api/v1/classrooms/${id}/diagnostics`,{method,headers:{...headers,'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)})});
 signed=false;assert.equal((await handler(request())).status,401);signed=true;assert.equal((await handler(request(undefined,{Origin:'https://foreign.example'}))).status,403);assert.equal((await handler(request(undefined,{Origin:origin,'sec-fetch-site':'cross-site'}))).status,403);
 const response=await handler(request());assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});assert.deepEqual(calls,[['owner',id,[event]]]);assert.match(response.headers.get('cache-control')??'',/no-store/);
 for(const body of [{events:[{...event,stage:'accepted'}]},{events:[{...event,raw:'private'}]},{events:Array(11).fill(event)},{events:[event],accountId:'other'}])assert.equal((await handler(request(body))).status,400);
 assert.equal((await handler(request(undefined,undefined,'GET'))).status,405);limited=true;assert.equal((await handler(request())).status,429);assert.equal(calls.length,1);assert.equal(limits,0);
});
test('diagnostic traffic has its own budget and a missing diagnostic limiter fails closed without consuming classroom actions',async()=>{
 const {createClassroomHandler}=await import('../lib/server/classroom-http');const origin='http://localhost',id='00000000-0000-4000-8000-000000000001';let actionLimits=0,diagnosticLimits=0,actions=0;
 const event={id:crypto.randomUUID(),pointId:crypto.randomUUID(),context:{logicalSessionId:id,courseVersion:'robot:1',connectionEpoch:1,stateRevision:1,pageId:'p1',activityId:'reading'},stage:'clicked'};
 const deps={origin,authenticate:async()=>({id:'owner',profileComplete:true}),providers:()=>[],limit:async()=>{actionLimits++;},service:{pointDiagnostics:async()=>{},action:async()=>{actions++;return{id};}}as never};
 const req=(path:string,body:unknown)=>new Request(`${origin}/api/v1/classrooms/${id}/${path}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const handler=createClassroomHandler({...deps,limitDiagnostics:async()=>{if(++diagnosticLimits>2)throw{code:'RATE_LIMITED',status:429,message:'请稍后重试。'};}});
 assert.equal((await handler(req('diagnostics',{events:[event]}))).status,200);assert.equal((await handler(req('diagnostics',{events:[event]}))).status,200);assert.equal((await handler(req('diagnostics',{events:[event]}))).status,429);assert.equal(actionLimits,0);
 for(const type of ['pause','end'])assert.equal((await handler(req('actions',{eventId:crypto.randomUUID(),expectedRevision:1,type}))).status,200);assert.equal(actionLimits,2);assert.equal(actions,2);
 const noLimiter=createClassroomHandler(deps);assert.equal((await noLimiter(req('diagnostics',{events:[event]}))).status,503);assert.equal(actionLimits,2);
});
