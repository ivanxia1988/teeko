import React from 'react';
import {after,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {teacherSnapshot} from './teacher-runtime-fixture';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost',pretendToBeVisual:true});
for(const key of ['window','self','document','HTMLElement','Node','Event','MutationObserver','navigator'])Object.defineProperty(globalThis,key,{value:(dom.window as unknown as Record<string,unknown>)[key],configurable:true});
const {render,waitFor,cleanup}=await import('@testing-library/react');
const {ClassroomBoardFeed}=await import('../components/product/classroom-board-feed');
afterEach(cleanup);after(()=>dom.window.close());
const image={current:{} as HTMLImageElement};
test('a connected classroom sends its actual current marks without opening a camera',async()=>{
 const sent:unknown[]=[],snapshot=teacherSnapshot();let captured=0,stops=0;
 const marks=[{pageId:snapshot.course.steps[snapshot.stepIndex].pageId,points:[{x:.1,y:.2},{x:.3,y:.4}]}];
 const props={snapshot,enabled:true,image,marks,client:{current:{sendBoard(value:unknown){sent.push(value);return true;},stopBoard(){stops++;}}},onError(){throw new Error('unexpected');},capture:async(_image:HTMLImageElement,strokes:unknown)=>{captured++;assert.deepEqual(strokes,marks);return '/9j/2Q==';}};
 const ui=render(<ClassroomBoardFeed {...props}/>);
 await waitFor(()=>assert.equal(sent.length,1));assert.equal(captured,1);ui.unmount();assert.equal(stops,1);
});
test('pause or a changed drawing invalidates a pending image before it can be sent',async()=>{
 let release!:(image:string)=>void,started=0;const sent:unknown[]=[],snapshot=teacherSnapshot();
 const props={snapshot,enabled:true,image,marks:[],client:{current:{sendBoard(value:unknown){sent.push(value);return true;},stopBoard(){}}},onError(){},capture:async()=>{started++;return new Promise<string>(r=>{release=r;});}};
 const ui=render(<ClassroomBoardFeed {...props}/>);await waitFor(()=>assert.equal(started,1));
 ui.rerender(<ClassroomBoardFeed {...props} enabled={false}/>);release('/9j/2Q==');await Promise.resolve();assert.equal(sent.length,0);
});
test('an identical snapshot from a tool receipt keeps the current board sharing session alive',async()=>{
 let stops=0;const sent:unknown[]=[],snapshot=teacherSnapshot();
 const props={snapshot,enabled:true,image,marks:[],client:{current:{sendBoard(value:unknown){sent.push(value);return true;},stopBoard(){stops++;}}},onError(){},capture:async()=>'/9j/2Q=='};
 const ui=render(<ClassroomBoardFeed {...props}/>);await waitFor(()=>assert.equal(sent.length,1));
 ui.rerender(<ClassroomBoardFeed {...props} snapshot={structuredClone(snapshot)}/>);
 assert.equal(stops,0,'a read-only tool snapshot must not revoke the committed textbook image');
 ui.unmount();assert.equal(stops,1);
});
test('equivalent snapshots do not discard capture in flight, but a changed board context does',async()=>{
 let release!:(image:string)=>void,captures=0;const sent:unknown[]=[],snapshot=teacherSnapshot();
 const props={snapshot,enabled:true,image,marks:[],client:{current:{sendBoard(value:unknown){sent.push(value);return true;},stopBoard(){}}},onError(){},capture:async()=>{captures++;return new Promise<string>(r=>{release=r;});}};
 const ui=render(<ClassroomBoardFeed {...props}/>);await waitFor(()=>assert.equal(captures,1));
 ui.rerender(<ClassroomBoardFeed {...props} snapshot={structuredClone(snapshot)}/>);release('/9j/2Q==');await waitFor(()=>assert.equal(sent.length,1));
 ui.rerender(<ClassroomBoardFeed {...props} snapshot={{...snapshot,revision:snapshot.revision+1}}/>);await waitFor(()=>assert.equal(captures,2));
 ui.rerender(<ClassroomBoardFeed {...props} enabled={false}/>);release('/9j/2Q==');await Promise.resolve();assert.equal(sent.length,1);
});
