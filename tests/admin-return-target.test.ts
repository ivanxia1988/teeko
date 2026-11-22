import React from 'react';
import test,{after,afterEach,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {safeAdminReturnTarget,adminLoginHref} from '../lib/admin-return-target';

const classroomId='00000000-0000-4000-8000-000000000001',target=`/admin/diagnostics?classroomId=${classroomId}&eventId=9007199254740993`;
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://admin.teeko.app/admin/login'});
for(const key of ['window','self','document','HTMLElement','HTMLInputElement','Node','Event','MouseEvent','MutationObserver','getComputedStyle','navigator'])Object.defineProperty(globalThis,key,{value:(dom.window as unknown as Record<string,unknown>)[key],configurable:true});
const {render,screen,fireEvent,waitFor,cleanup}=await import('@testing-library/react');
const {AdminLogin}=await import('../components/admin/admin-login');
const previousFetch=globalThis.fetch,calls:{path:string;body?:unknown}[]=[];
let signedIn=false,loginResponse:Response;
beforeEach(()=>{signedIn=false;calls.length=0;loginResponse=Response.json({ok:true,next:'/admin'});globalThis.fetch=async(input,init)=>{const path=String(input);calls.push({path,body:typeof init?.body==='string'?JSON.parse(init.body):undefined});return path.endsWith('/state')?Response.json({ok:true,user:signedIn?{id:'synthetic-admin',username:'admin'}:null}):loginResponse;};});
afterEach(cleanup);after(()=>{globalThis.fetch=previousFetch;dom.window.close();});
test('admin return accepts only a classroom diagnostic target and canonicalizes allowed parameters',()=>{
 assert.equal(safeAdminReturnTarget(target),target);
 assert.equal(safeAdminReturnTarget(`/admin/diagnostics?eventId=9007199254740993&classroomId=${classroomId}`),target);
 assert.equal(safeAdminReturnTarget(`/admin/diagnostics?classroomId=${classroomId}`),`/admin/diagnostics?classroomId=${classroomId}`);
 assert.equal(safeAdminReturnTarget(`/admin/diagnostics?classroomId=${classroomId}&eventId=9223372036854775807`),`/admin/diagnostics?classroomId=${classroomId}&eventId=9223372036854775807`);
});
test('admin return rejects external, scheme-relative, encoded, normalized and fragment destinations',()=>{
 for(const value of [undefined,null,{},[target],'https://outside.test'+target,'//outside.test'+target,'\\outside.test'+target,'https://admin.teeko.app'+target,'/admin/../admin/diagnostics?classroomId='+classroomId,'/admin/%64iagnostics?classroomId='+classroomId,encodeURIComponent(target),'%252f%252foutside.test',target+'#details',target+'%23hidden',target+'\n',target+'\t',' '+target,'/admin','/admin/login','/admin/diagnostics','/admin/diagnostics?eventId=1']){
  assert.equal(safeAdminReturnTarget(value),'/admin');
 }
});
test('admin return rejects duplicate, unknown, missing and malformed query parameters',()=>{
 for(const value of [target+'&next=/admin',target+'&classroomId='+classroomId,target+'&eventId=2',target+'&',target.replace('classroomId=','CLASSROOMID='),target.replace(classroomId,'not-a-uuid'),target.replace('eventId=9007199254740993','eventId='),target.replace('eventId=9007199254740993','eventId=01'),target.replace('eventId=9007199254740993','eventId=-1'),target.replace('eventId=9007199254740993','eventId=1.5'),target.replace('eventId=9007199254740993','eventId=9223372036854775808'),target.replace(classroomId,encodeURIComponent(classroomId).replace('0','%30'))])assert.equal(safeAdminReturnTarget(value),'/admin');
});
test('admin login href encodes the validated target once and preserves the default login location',()=>{
 assert.equal(adminLoginHref(target),'/admin/login?returnTo='+encodeURIComponent(target));
 assert.equal(new URL(adminLoginHref(target),'https://admin.teeko.app').searchParams.get('returnTo'),target);
 for(const value of [undefined,'/admin','https://outside.test',encodeURIComponent(target),[target]])assert.equal(adminLoginHref(value),'/admin/login');
});

test('successful separate admin authentication returns to the validated diagnostic target',async()=>{
 const destinations:string[]=[];render(React.createElement(AdminLogin,{returnTo:target,navigate:path=>destinations.push(path)}));
 await waitFor(()=>assert(!(screen.getByRole('button',{name:'登录后台'}) as HTMLButtonElement).disabled));
 fireEvent.change(screen.getByLabelText('密码',{exact:true}),{target:{value:'synthetic-admin-password'}});fireEvent.click(screen.getByRole('button',{name:'登录后台'}));
 await waitFor(()=>assert.deepEqual(destinations,[target]));
 assert.deepEqual(calls.find(call=>call.path.endsWith('/login')),{path:'/api/v1/admin/auth/login',body:{username:'admin',password:'synthetic-admin-password'}});
 assert.equal(dom.window.localStorage.length,0);
});
test('an already authenticated administrator resumes the same diagnostic target',async()=>{
 signedIn=true;const destinations:string[]=[];render(React.createElement(AdminLogin,{returnTo:target,navigate:path=>destinations.push(path)}));
 await waitFor(()=>assert.deepEqual(destinations,[target]));assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/v1/admin/auth/state');
});
test('an untrusted return target defaults to the admin page after authentication',async()=>{
 signedIn=true;const destinations:string[]=[];render(React.createElement(AdminLogin,{returnTo:'//outside.test',navigate:path=>destinations.push(path)}));
 await waitFor(()=>assert.deepEqual(destinations,['/admin']));
});
test('invalid server login redirects remain rejected even with a valid diagnostic target',async()=>{
 loginResponse=Response.json({ok:true,next:'https://outside.test'});const destinations:string[]=[];
 render(React.createElement(AdminLogin,{returnTo:target,navigate:path=>destinations.push(path)}));
 await waitFor(()=>assert(!(screen.getByRole('button',{name:'登录后台'}) as HTMLButtonElement).disabled));
 fireEvent.change(screen.getByLabelText('密码',{exact:true}),{target:{value:'synthetic-admin-password'}});fireEvent.click(screen.getByRole('button',{name:'登录后台'}));
 await waitFor(()=>assert(screen.getByRole('alert').textContent?.includes('响应异常')));assert.deepEqual(destinations,[]);
});
