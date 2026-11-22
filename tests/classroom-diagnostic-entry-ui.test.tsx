import React from 'react';
import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost'});
for(const key of ['window','document','HTMLElement','Node','MutationObserver','navigator'])Object.defineProperty(globalThis,key,{value:(dom.window as unknown as Record<string,unknown>)[key],configurable:true});
const {render,screen,waitFor,cleanup}=await import('@testing-library/react');
const {useClassroomDiagnosticEntry}=await import('../components/product/classroom-diagnostic-entry');
const id='10000000-0000-4000-8000-000000000001';
function Probe(){const href=useClassroomDiagnosticEntry(id);return href?<a href={href}>查看课堂排查</a>:<span>课堂</span>;}
afterEach(cleanup);after(()=>dom.window.close());
test('entry is absent for disabled or unauthenticated students',async()=>{
 let done=false;globalThis.fetch=async()=>{done=true;return Response.json({ok:true,enabled:false});};render(<Probe/>);await waitFor(()=>assert(done));assert.equal(screen.queryByRole('link'),null);
});
test('only the server-authorized classroom diagnostic link is rendered',async()=>{
 globalThis.fetch=async()=>Response.json({ok:true,enabled:true,url:`https://admin.teeko.app/admin/diagnostics?classroomId=${id}`});render(<Probe/>);await waitFor(()=>assert(screen.getByRole('link')));assert.equal(screen.getByRole('link').getAttribute('href'),`https://admin.teeko.app/admin/diagnostics?classroomId=${id}`);
});
test('malformed external targets cannot become entry links',async()=>{
 for(const url of ['javascript:alert(1)',`https://admin.teeko.app/admin/diagnostics?classroomId=other`,`https://admin.teeko.app/admin/diagnostics?classroomId=${id}&secret=PRIVATE`,`https://user:password@admin.teeko.app/admin/diagnostics?classroomId=${id}`]){
  let done=false;globalThis.fetch=async()=>{done=true;return Response.json({ok:true,enabled:true,url});};render(<Probe/>);await waitFor(()=>assert(done));assert.equal(screen.queryByRole('link'),null);cleanup();
 }
});
