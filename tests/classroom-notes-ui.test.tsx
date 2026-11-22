import React from 'react';
import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {encodeClassroomNotesCursor,type ClassroomNotesPage} from '../lib/classroom-notes';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/classroom/one'});
for(const key of ['window','self','document','HTMLElement','Node','Event','MouseEvent','MutationObserver','getComputedStyle','navigator'])Object.defineProperty(globalThis,key,{value:(dom.window as unknown as Record<string,unknown>)[key],configurable:true});
const {render,screen,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react');
const {ClassroomNotes}=await import('../components/product/classroom-notes');
const savedFetch=globalThis.fetch;afterEach(()=>{cleanup();globalThis.fetch=savedFetch;});after(()=>dom.window.close());
const id='10000000-0000-4000-8000-000000000001',courseVersion='picnic:2';
const cursor=encodeClassroomNotesCursor({at:'2026-11-11T01:00:00.000Z',epoch:1,itemId:'input-a'});
const page=(overrides:Partial<ClassroomNotesPage>={}):ClassroomNotesPage=>({ok:true,classroomId:id,courseVersion,entries:[{id:'1:input-a',step:{id:'say-apple',label:'说说喜欢什么'},original:{text:'I likes apples.',excerpt:false,source:'speech',recordedAt:'2026-11-11T01:00:00.000Z'},reference:{text:'I like apples.',kind:'generated_teaching_reference',createdAt:'2026-11-11T01:00:00.000Z'},origin:{connectionEpoch:1,itemId:'input-a'}}],nextCursor:null,coverage:'retained_sources',...overrides});
test('notes load real source text and distinguish saved recognition from a generated teaching reference',async()=>{
 let resolve:(response:Response)=>void=()=>{};const calls:string[]=[];globalThis.fetch=async(input)=>{calls.push(String(input));return new Promise<Response>(done=>{resolve=done;});};
 render(<ClassroomNotes classroomId={id} courseVersion={courseVersion}/>);assert(screen.getByRole('status').textContent?.includes('读取'));await act(async()=>resolve(Response.json(page())));await waitFor(()=>assert(screen.getByText('I like apples.')));
 assert(screen.getByText('课堂识别文字'));assert(screen.getByText('当时的表达参考'));assert(screen.getByText('I likes apples.'));assert.equal(calls.length,1);assert.match(calls[0],new RegExp(`/classrooms/${id}/notes\\?pageSize=1`));assert(!screen.queryByText(/已掌握|你说错了/));
});
test('an empty scanned page preserves next navigation and paging keeps keyboard focus on its control',async()=>{
 globalThis.fetch=async(input)=>Response.json(String(input).includes('cursor=')?page():page({entries:[],nextCursor:cursor}));
 render(<ClassroomNotes classroomId={id} courseVersion={courseVersion}/>);await waitFor(()=>assert(screen.getByText('这页没有可展示的表达记录。')));const next=screen.getByRole('button',{name:'下一页'});assert.equal(next.getAttribute('aria-disabled'),'false');next.focus();fireEvent.click(next);await waitFor(()=>assert(screen.getByText('I like apples.')));assert.equal(document.activeElement,next);assert.equal(next.getAttribute('aria-disabled'),'true');
 fireEvent.click(screen.getByRole('button',{name:'上一页'}));await waitFor(()=>assert(screen.getByText('这页没有可展示的表达记录。')));
});
test('notes failures show a retry and never display a fabricated example',async()=>{
 let calls=0;globalThis.fetch=async()=>++calls===1?Response.json({ok:false,error:{code:'UNAVAILABLE',message:'暂时无法读取。'}},{status:503}):Response.json(page());
 render(<ClassroomNotes classroomId={id} courseVersion={courseVersion}/>);await waitFor(()=>assert(screen.getByRole('alert')));assert(!screen.queryByText('I like apples.'));fireEvent.click(screen.getByRole('button',{name:'重新读取'}));await waitFor(()=>assert(screen.getByText('I like apples.')));assert.equal(calls,2);
});
test('an empty terminal page does not claim the whole lesson had no notes',async()=>{
 globalThis.fetch=async(input)=>Response.json(String(input).includes('cursor=')?page({entries:[]}):page({nextCursor:cursor}));
 render(<ClassroomNotes classroomId={id} courseVersion={courseVersion}/>);await waitFor(()=>assert(screen.getByText('I like apples.')));fireEvent.click(screen.getByRole('button',{name:'下一页'}));await waitFor(()=>assert(screen.getByText('这页没有可展示的表达记录。')));assert(!screen.queryByText('这节课还没有可回看的表达参考。'));
});
test('late previous-class responses are aborted and cannot populate a new classroom',async()=>{
 let resolveOld:(response:Response)=>void=()=>{};let firstSignal:AbortSignal|null|undefined;const other='20000000-0000-4000-8000-000000000002';
 globalThis.fetch=async(input,init)=>{if(String(input).includes(id)){firstSignal=init?.signal;return new Promise<Response>(resolve=>{resolveOld=resolve;});}return Response.json(page({classroomId:other,entries:[]}));};
 const view=render(<ClassroomNotes classroomId={id} courseVersion={courseVersion}/>);view.rerender(<ClassroomNotes classroomId={other} courseVersion={courseVersion}/>);await waitFor(()=>assert(screen.getByText('这节课还没有可回看的表达参考。')));assert(firstSignal?.aborted);await act(async()=>resolveOld(Response.json(page())));assert(!screen.queryByText('I like apples.'));
});
test('foreign course versions and hidden response fields fail safely rather than appearing as lesson notes',async()=>{
 for(const value of [page({courseVersion:'picnic:1'}),{...page(),reason:'PRIVATE_REASON'}]){
  globalThis.fetch=async()=>Response.json(value);const view=render(<ClassroomNotes classroomId={id} courseVersion={courseVersion}/>);await waitFor(()=>assert(screen.getByRole('alert')));assert(!screen.queryByText('I like apples.'));assert(!screen.queryByText('PRIVATE_REASON'));view.unmount();
 }
});

for(const preparation of ['pending','ready','unavailable'] as const)test(`notes distinguish ${preparation} consolidation from saved source content`,async()=>{
 globalThis.fetch=async()=>Response.json(page({coverage:preparation==='ready'?'captured_sources':'limited_sources',preparation}));
 render(<ClassroomNotes classroomId={id} courseVersion={courseVersion}/>);await waitFor(()=>assert(screen.getByText('I like apples.')));
 const status=screen.getByRole('status');assert(status.textContent?.includes(preparation==='pending'?'正在整理':preparation==='ready'?'已整理':'暂不可用'));
 if(preparation!=='ready'){assert(status.textContent?.includes('不完整'));assert(screen.getByRole('button',{name:'重新读取'}));}
});
