import React from 'react';
import test, {after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/courses'});
for(const key of ['window','self','document','HTMLElement','HTMLInputElement','Node','Event','MouseEvent','MutationObserver','getComputedStyle','navigator'])Object.defineProperty(globalThis,key,{value:(dom.window as unknown as Record<string,unknown>)[key],configurable:true});
const {render,screen,waitFor,cleanup,fireEvent,act}=await import('@testing-library/react');
const {Courses}=await import('../components/product/courses');
afterEach(cleanup);after(()=>dom.window.close());
const id='10000000-0000-4000-8000-000000000001';
test('recent ended classrooms expose saved summaries without creating or reconnecting a lesson',async()=>{
 const calls:string[]=[];
 globalThis.fetch=async input=>{
  calls.push(String(input));
  if(String(input).endsWith('/classroom-options'))return Response.json({ok:true,providers:[],preferences:{provider:'qwen',language:'bilingual',style:'gentle',voice:'female',soundEffects:false}});
  return Response.json({ok:true,courses:[],activeClassroom:null,recentClassrooms:[{id,courseTitle:'一起去野餐',endedAt:'2026-11-01T01:00:00Z',endReason:'manual',elapsedSeconds:91}]});
 };
 render(<Courses navigate={()=>assert.fail('history should use its saved classroom link')}/>);
 await waitFor(()=>assert(screen.getByRole('link',{name:/一起去野餐.*查看小结/})));
 assert.equal(screen.getByRole('link',{name:/一起去野餐.*查看小结/}).getAttribute('href'),`/classroom/${id}`);
 assert(screen.getByText('中途结束 · 1:31'));
 assert.equal(calls.length,2);
});
test('an empty history never substitutes prototype records or a report-ready claim',async()=>{
 globalThis.fetch=async input=>String(input).endsWith('/classroom-options')?Response.json({ok:true,providers:[],preferences:{provider:'qwen',language:'bilingual',style:'gentle',voice:'female',soundEffects:false}}):Response.json({ok:true,courses:[],activeClassroom:null,recentClassrooms:[]});
 render(<Courses/>);
 await waitFor(()=>assert(screen.getByRole('heading',{name:'课程准备中'})));
 assert(!screen.queryByRole('region',{name:'最近的课堂'}));
 assert(!screen.queryByText(/报告已准备好|Weekend plans/));
});


test('Grok preference is returned and saved without changing an already frozen classroom',async()=>{
 const sent:unknown[]=[];const preferences={provider:'grok',language:'bilingual',style:'gentle',voice:'female',soundEffects:false};
 globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith('/classroom-options'))return Response.json({ok:true,providers:[{id:'qwen',name:'通义',configured:true},{id:'openai',name:'GPT Live',configured:true},{id:'grok',name:'Grok Voice 3.0',configured:true}],preferences});
  if(String(input).endsWith('/preferences')){sent.push(JSON.parse(String(init?.body)));return Response.json({ok:true,preferences});}
  return Response.json({ok:true,courses:[],activeClassroom:{id,courseId:'picnic',status:'active',provider:'qwen'},recentClassrooms:[]});
 };
 render(<Courses/>);await waitFor(()=>assert((screen.getByLabelText('Grok Voice 3.0') as HTMLInputElement).checked));
 assert(screen.getByText(/当前课堂使用 通义；结束本节后/));await act(async()=>fireEvent.click(screen.getByRole('button',{name:'保存设置'})));await waitFor(()=>assert.equal(sent.length,1));assert.equal((sent[0] as {provider:string}).provider,'grok');
});

test('choosing a new course explains an unfinished classroom and only resumes that saved lesson',async()=>{
 const {PICNIC_COURSE}=await import('../lib/server/course-catalog');
 const calls:string[]=[],destinations:string[]=[];
 globalThis.fetch=async input=>{
  calls.push(String(input));
  if(String(input).endsWith('/classroom-options'))return Response.json({ok:true,providers:[{id:'qwen',name:'通义',configured:true}],preferences:{provider:'qwen',language:'bilingual',style:'gentle',voice:'female',soundEffects:false}});
  return Response.json({ok:true,courses:[{...PICNIC_COURSE,progress:{stepIndex:1,completed:false}},{...PICNIC_COURSE,id:'robot-reading',title:'会飞又会游的机器人',progress:{stepIndex:0,completed:false}}],activeClassroom:{id,courseId:'picnic',status:'paused',provider:'qwen'},recentClassrooms:[]});
 };
 render(<Courses navigate={path=>destinations.push(path)}/>);await waitFor(()=>assert(screen.getByRole('button',{name:/会飞又会游的机器人/})));
 fireEvent.click(screen.getByRole('button',{name:/会飞又会游的机器人/}));assert(screen.getByText('请先结束正在上的课，再开始这节课。'));
 fireEvent.click(screen.getByRole('button',{name:'回到正在上的课'}));assert.deepEqual(destinations,[`/classroom/${id}`]);assert.equal(calls.length,2);
});
