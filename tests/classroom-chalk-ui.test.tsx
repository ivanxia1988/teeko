import React from 'react';
import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/prototype'});
for(const key of ['window','self','document','HTMLElement','Node','Event','MutationObserver','getComputedStyle','navigator'])Object.defineProperty(globalThis,key,{value:(dom.window as unknown as Record<string,unknown>)[key],configurable:true});
const {render,screen,cleanup,act}=await import('@testing-library/react');
const {ClassroomChalk}=await import('../components/product/classroom-chalk');
afterEach(cleanup);after(()=>dom.window.close());
const current=()=>({status:'active',context:{logicalSessionId:'chalk-lesson',courseVersion:'picnic:2',connectionEpoch:1,stateRevision:1,pageId:'page-1',activityId:'say-apple'}});
const writing=(n=1)=>({type:'chalk.write',id:`0000000${n}-0000-4000-8000-000000000001`,receivedAtMs:10000,expiresAtMs:18000,context:current().context,text:'I like apples.'});

test('chalk renders only valid teacher writing as text and never interprets markup',()=>{
 const text='<img src=x onerror=alert(1)>';render(<ClassroomChalk current={current()} writing={{...writing(),text}} now={()=>10000}/>);const note=screen.getByRole('note',{name:'Teacher writing'});assert.equal(note.textContent,text);assert.equal(note.querySelector('img'),null);
});
test('a display receipt is emitted once for a committed current note, never invalid or expired text',()=>{
 const receipts:string[]=[],now=()=>10000,onDisplayed=(id:string)=>receipts.push(id);
 const view=render(<React.StrictMode><ClassroomChalk current={current()} writing={writing()} now={now} onDisplayed={onDisplayed}/></React.StrictMode>);
 assert.deepEqual(receipts,[writing().id]);view.rerender(<React.StrictMode><ClassroomChalk current={current()} writing={writing()} now={now} onDisplayed={onDisplayed}/></React.StrictMode>);assert.deepEqual(receipts,[writing().id]);
 view.rerender(<ClassroomChalk current={{...current(),status:'paused'}} writing={writing(2)} now={now} onDisplayed={onDisplayed}/>);assert.deepEqual(receipts,[writing().id]);
});
test('chalk cannot display invalid, paused, expired or unrelated messages',()=>{
 for(const [state,value,now] of [[current(),{...writing(),score:100},10000],[{...current(),status:'paused'},writing(),10000],[current(),writing(),18000],[{...current(),context:{...current().context,activityId:'next'}},writing(),10000]] as const){const view=render(<ClassroomChalk current={state} writing={value} now={()=>now}/>);assert.equal(screen.queryByRole('note'),null);view.unmount();}
});
test('chalk automatically disappears at its original deadline',async t=>{
 let clock=10000;const now=()=>clock,expired:string[]=[];t.mock.timers.enable({apis:['setTimeout']});try{
  render(<ClassroomChalk current={current()} writing={writing()} now={now} onExpire={id=>expired.push(id)}/>);assert(screen.getByRole('note'));
  await act(async()=>{clock=17999;t.mock.timers.tick(7999);});assert(screen.getByRole('note'));
  await act(async()=>{clock=18000;t.mock.timers.tick(1);});assert.equal(screen.queryByRole('note'),null);assert.deepEqual(expired,[writing().id]);
 }finally{cleanup();t.mock.timers.reset();}
});
test('replacing chalk cancels the old timer and never erases the new writing early',async t=>{
 let clock=10000;const now=()=>clock,expired:string[]=[];const state=current(),onExpire=(id:string)=>expired.push(id);t.mock.timers.enable({apis:['setTimeout']});try{
  const view=render(<ClassroomChalk current={state} writing={writing()} now={now} onExpire={onExpire}/>);await act(async()=>{clock=15000;t.mock.timers.tick(5000);});
  view.rerender(<ClassroomChalk current={state} writing={{...writing(2),text:'I like bananas.',receivedAtMs:15000,expiresAtMs:23000}} now={now} onExpire={onExpire}/>);
  await act(async()=>{clock=18000;t.mock.timers.tick(3000);});assert.equal(screen.getByRole('note').textContent,'I like bananas.');assert.deepEqual(expired,[]);
  await act(async()=>{clock=23000;t.mock.timers.tick(5000);});assert.equal(screen.queryByRole('note'),null);assert.deepEqual(expired,[writing(2).id]);
 }finally{cleanup();t.mock.timers.reset();}
});
test('scope changes hide chalk immediately without moving focus',()=>{
 const button=document.createElement('button');button.textContent='Keep focus';document.body.appendChild(button);button.focus();const now=()=>10000;
 try{const view=render(<ClassroomChalk current={current()} writing={writing()} now={now}/>);assert.equal(document.activeElement,button);view.rerender(<ClassroomChalk current={{...current(),context:{...current().context,stateRevision:2}}} writing={writing()} now={now}/>);assert.equal(screen.queryByRole('note'),null);assert.equal(document.activeElement,button);}finally{button.remove();}
});

test('withdrawn chalk never returns after pause, scope restoration, clearing or replacement',()=>{
 const now=()=>10000;
 for(const replacement of [null,writing(2)]){
  const view=render(<ClassroomChalk current={current()} writing={writing()} now={now}/>);
  view.rerender(<ClassroomChalk current={current()} writing={replacement} now={now}/>);
  view.rerender(<ClassroomChalk current={current()} writing={writing()} now={now}/>);
  assert.equal(screen.queryByRole('note'),null);view.unmount();
 }
 for(const state of [{...current(),status:'paused'},{...current(),context:{...current().context,activityId:'other'}}]){
  const view=render(<ClassroomChalk current={current()} writing={writing()} now={now}/>);
  view.rerender(<ClassroomChalk current={state} writing={writing()} now={now}/>);
  view.rerender(<ClassroomChalk current={current()} writing={writing()} now={now}/>);
  assert.equal(screen.queryByRole('note'),null);view.unmount();
 }
});
test('chalk expiring between render and effect still schedules its removal',async t=>{
 let calls=0;const now=()=>++calls===1?17999:18000;t.mock.timers.enable({apis:['setTimeout']});
 try{render(<ClassroomChalk current={current()} writing={writing()} now={now}/>);await act(async()=>t.mock.timers.tick(1));assert.equal(screen.queryByRole('note'),null);}
 finally{cleanup();t.mock.timers.reset();}
});

test('developer chalk controls render into the lesson, clear on scope changes and survive StrictMode cleanup',async()=>{
 const {ChalkPreview}=await import('../components/prototype/chalk-preview');const {fireEvent}=await import('@testing-library/react');
 const target=document.createElement('article');document.body.appendChild(target);const canvas={current:target};
 try{
  const view=render(<React.StrictMode><ChalkPreview current={current()} canvas={canvas}/></React.StrictMode>);fireEvent.click(screen.getByRole('button',{name:'板书示例'}));assert.equal(target.querySelector('[role="note"]')?.textContent,'I am going to the museum.');
  view.rerender(<React.StrictMode><ChalkPreview current={{...current(),status:'paused'}} canvas={canvas}/></React.StrictMode>);assert.equal(target.querySelector('[role="note"]'),null);assert((screen.getByRole('button',{name:'板书示例'}) as HTMLButtonElement).disabled);
  view.rerender(<React.StrictMode><ChalkPreview current={current()} canvas={canvas}/></React.StrictMode>);assert.equal(target.querySelector('[role="note"]'),null);fireEvent.click(screen.getByRole('button',{name:'板书示例'}));assert(target.querySelector('[role="note"]'));fireEvent.click(screen.getByRole('button',{name:'擦除示例'}));assert.equal(target.querySelector('[role="note"]'),null);
 }finally{target.remove();}
});
