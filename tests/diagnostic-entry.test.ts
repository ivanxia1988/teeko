import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticEntryHandler} from '../lib/server/diagnostic-entry';

const accountId='00000000-0000-4000-8000-000000000001',classroomId='00000000-0000-4000-8000-000000000002';
const endpoint=`https://teeko.app/api/v1/diagnostics/entry?classroomId=${classroomId}`;
function setup(options:{accountId?:string|null;owner?:boolean;enabled?:readonly string[];origin?:string}={}){
 let checks=0;
 const handler=createDiagnosticEntryHandler({authenticate:async()=>options.accountId===null?null:{accountId:options.accountId??accountId},belongsToClassroom:async(account,id)=>{checks++;assert.equal(account,accountId);assert.equal(id,classroomId);return options.owner??true;},enabledAccountIds:options.enabled??[accountId],adminOrigin:options.origin??'https://admin.teeko.app',appOrigin:'https://teeko.app'});
 return {handler,checks:()=>checks};
}
test('entry requires student authentication and never returns classroom data',async()=>{
 const {handler,checks}=setup({accountId:null});const response=await handler(new Request(endpoint));
 assert.equal(response.status,401);assert.equal(checks(),0);assert.equal(response.headers.get('cache-control'),'no-store');
 assert(!JSON.stringify(await response.json()).includes(classroomId));
});
test('only allowlisted owners receive a fixed dedicated-admin URL without role escalation',async()=>{
 const {handler,checks}=setup();const response=await handler(new Request(endpoint));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,enabled:true,url:`https://admin.teeko.app/admin/diagnostics?classroomId=${classroomId}`});
 assert.equal(checks(),1);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(response.headers.get('set-cookie'),null);assert.equal(response.headers.get('access-control-allow-origin'),null);
});
test('disabled accounts and nonowners get indistinguishable disabled results',async()=>{
 for(const options of [{enabled:[]},{owner:false}]){
  const {handler}=setup(options);const response=await handler(new Request(endpoint));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,enabled:false});
 }
});
test('invalid UUIDs, unknown or duplicate query keys, paths and methods are rejected',async()=>{
 const {handler,checks}=setup();
 for(const url of [endpoint.replace(classroomId,'not-a-uuid'),endpoint+'&classroomId='+classroomId,endpoint+'&next=https://elsewhere.test',endpoint.split('?')[0]]){
  assert.equal((await handler(new Request(url))).status,400);
 }
 assert.equal((await handler(new Request(endpoint.replace('/entry','/other')))).status,404);
 assert.equal((await handler(new Request(endpoint,{method:'POST'}))).status,405);assert.equal(checks(),0);
});
test('cross-site requests cannot expose the privileged navigation URL',async()=>{
 const {handler,checks}=setup();
 const cases:Record<string,string>[]=[{origin:'https://evil.example'},{'sec-fetch-site':'cross-site'},{origin:'null'}];
 for(const headers of cases){
  const response=await handler(new Request(endpoint,{headers}));assert.equal(response.status,403);assert(!JSON.stringify(await response.json()).includes('https://admin'));
 }
 assert.equal(checks(),0);
 assert.equal((await handler(new Request(endpoint,{headers:{origin:'https://teeko.app'}}))).status,200);
});
test('invalid trusted origin or invalid allowlist fails closed without exposing config',async()=>{
 for(const origin of ['http://admin.teeko.app','https://user@admin.teeko.app','https://admin.teeko.app/','https://admin.teeko.app/path','https://admin.teeko.app?next=x']){
  const {handler}=setup({origin});const response=await handler(new Request(endpoint));
  assert.equal(response.status,503);assert(!JSON.stringify(await response.json()).includes(origin));
 }
 for(const enabled of [['not-a-uuid'],[accountId,'not-a-uuid']]){
  const {handler}=setup({enabled});const response=await handler(new Request(endpoint));assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,enabled:false});
 }
 assert.equal((await setup({origin:'http://127.0.0.1:8081'}).handler(new Request(endpoint))).status,200);
});
test('dependency failures stay generic and never leak thrown private values',async()=>{
 const handler=createDiagnosticEntryHandler({authenticate:async()=>{throw new Error('fixture-secret');},belongsToClassroom:async()=>true,enabledAccountIds:[accountId],adminOrigin:'https://admin.teeko.app',appOrigin:'https://teeko.app'});
 const response=await handler(new Request(endpoint));assert.equal(response.status,503);assert(!JSON.stringify(await response.json()).includes('fixture-secret'));
});
test('trusted app origin accepts internal Next URLs and rejects origins supplied by the request URL',async()=>{
 const {handler}=setup();
 assert.equal((await handler(new Request(endpoint.replace('https://teeko.app','http://127.0.0.1:3000'),{headers:{origin:'https://teeko.app',host:'teeko.app'}}))).status,200);
 assert.equal((await handler(new Request(endpoint.replace('https://teeko.app','https://evil.example'),{headers:{origin:'https://evil.example'}}))).status,403);
 const invalid=createDiagnosticEntryHandler({authenticate:async()=>({accountId}),belongsToClassroom:async()=>true,enabledAccountIds:[accountId],adminOrigin:'https://admin.teeko.app',appOrigin:'http://teeko.app'});
 assert.equal((await invalid(new Request(endpoint))).status,503);
});
