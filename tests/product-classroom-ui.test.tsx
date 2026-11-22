import React from 'react';
import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { ClassroomSnapshot } from '../lib/classroom-contract';
import {ROBOT_READING_COURSE} from '../lib/server/robot-reading-course';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/courses' });
for (const key of ['window', 'self', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle', 'navigator']) Object.defineProperty(globalThis, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true });
function check(value:unknown):asserts value { assert.equal(Boolean(value),true); }
const { render, screen, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react');
const { Courses } = await import('../components/product/courses.tsx');
const { Classroom, checkClassroomMicrophone } = await import('../components/product/classroom.tsx');
afterEach(cleanup); after(() => dom.window.close());
export const snapshot: ClassroomSnapshot = {
 id:'10000000-0000-4000-8000-000000000001', course:{id:'picnic',version:'1',title:'一起去野餐',subtitle:"Let's have a picnic!",description:'聊聊喜欢的水果。',words:['apple','banana'],objectives:['认识水果','说说喜欢什么'],durationMinutes:8,pages:[{id:'p1',image:'/course-assets/picnic-v1.svg',width:900,height:720,objects:[{id:'apple',label:'apple',chinese:'苹果',box:{x:.15,y:.3,w:.25,h:.35}}]}],steps:[{id:'find-apple',kind:'select',pageId:'p1',targetId:'apple',english:'Can you find the apple?',chinese:'找出苹果',hint:'Look for the red fruit.',expected:'apple'}]},
 profile:{name:'Mia',ageRange:'8–9',level:'starter'},preferences:{provider:'qwen',language:'bilingual',style:'gentle',voice:'female',soundEffects:false},status:'preflight',revision:0,connectionEpoch:0,stepIndex:0,elapsedSeconds:0,remainingSeconds:600,maxSeconds:600,outcomes:[],teacherObjectIds:[],feedback:null,endReason:null,startedAt:'2026-11-01T00:00:00Z',endedAt:null,reportStatus:'unavailable'
};
const options={ok:true,providers:[{id:'qwen',name:'通义',configured:true},{id:'openai',name:'GPT Live',configured:true}],preferences:snapshot.preferences};

test('published courses offer one real start action and never request microphone on arrival', async()=>{
 let mediaCalls=0; Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{mediaCalls++;throw new Error('must not run');}}});
 const calls:{path:string,body?:unknown}[]=[],destinations:string[]=[];
 globalThis.fetch=async(input,init)=>{
  calls.push({path:String(input),body:typeof init?.body==='string'?JSON.parse(init.body):undefined});
  if(String(input).endsWith('/classroom-options'))return Response.json(options);
  if(String(input).endsWith('/classrooms'))return Response.json({ok:true,classroom:snapshot});
  return Response.json({ok:true,courses:[{...snapshot.course,progress:{stepIndex:0,completed:false}}],activeClassroom:null});
 };
 render(<Courses navigate={path=>destinations.push(path)} />);
 await waitFor(()=>check(screen.getByRole('button',{name:'跟 Teeko 老师一起学'})));
 assert.equal(mediaCalls,0);
 fireEvent.click(screen.getByRole('button',{name:'跟 Teeko 老师一起学'}));
 await waitFor(()=>assert.deepEqual(destinations,[`/classroom/${snapshot.id}`]));
 const start=calls.find(c=>c.path==='/api/v1/classrooms');
 assert.deepEqual(start?.body,{courseId:'picnic',preferences:snapshot.preferences});
 assert.equal(mediaCalls,0);
});

function fixture(initial:ClassroomSnapshot=snapshot,behavior:{pauseOnStop?:boolean;readyFirst?:boolean;pointResult?:boolean}={}){
 const calls:{path:string,body?:{type?:string;expectedRevision?:number;events?:import('../lib/classroom-point-diagnostics').ClassroomPointDiagnosticEvent[]}}[]=[];
 let current=initial, stops=0,starts=0,disposes=0,visionStarts=0,visionStops=0;const chalkReceipts:string[]=[],chalkExpired:string[]=[],muted:boolean[]=[],points:{contextKey:string;objectId:string}[]=[],interactions:import('../lib/classroom-voice-client').ClassroomAnnotationInput[]=[];
 let callbacks:Parameters<import('../components/product/classroom.tsx').VoiceFactory>[0]|null=null;
 globalThis.fetch=async(input,init)=>{
  const body=typeof init?.body==='string'?JSON.parse(init.body):undefined;calls.push({path:String(input),body});
  if(body?.expectedRevision!==undefined&&body.expectedRevision!==current.revision)return Response.json({ok:false,error:{code:'STALE_REVISION',message:'课堂已经更新，请重新试一次。'}},{status:409});
  if(body?.type==='pause')current={...current,status:'paused',revision:current.revision+1};
  if(body?.type==='resume')current={...current,status:'preflight',revision:current.revision+1};
  if(body?.type==='end')current={...current,status:'ended',revision:current.revision+1,endReason:'manual',endedAt:'2026-11-01T00:01:00Z',elapsedSeconds:60};
  return Response.json({ok:true,classroom:current});
 };
 const voiceFactory:import('../components/product/classroom.tsx').VoiceFactory=options=>{callbacks=options;return{async start(){starts++;current={...current,status:'active',revision:current.revision+1};if(behavior.readyFirst){options.onState('connected');options.onSnapshot(current);}else{options.onSnapshot(current);options.onState('connected');}},async stop(){stops++;if(behavior.pauseOnStop)current={...current,status:'paused',revision:current.revision+1};options.onState('closed');},dispose(){disposes++;},setMuted(value){muted.push(value);},sendText(){},sendPoint(value:{contextKey:string;objectId:string}){points.push(value);return behavior.pointResult!==false;},chalkDisplayed(id){chalkReceipts.push(id);return true;},chalkExpired(id){chalkExpired.push(id);},sendInteraction(value){interactions.push(value);return true;},startVision(){visionStarts++;options.onVisionState?.({status:'starting',generation:visionStarts});return true;},stopVision(){visionStops++;options.onVisionState?.({status:'off',generation:visionStarts});}};};
 return{calls,muted,points,interactions,chalkReceipts,chalkExpired,chalk(value:import('../lib/domain/classroom-chalk').ClassroomChalkWriting|null){callbacks?.onChalk?.(value);},voiceFactory,checkMicrophone:async()=>true,get visionStarts(){return visionStarts;},get visionStops(){return visionStops;},vision(value:import('../lib/classroom-vision').ClassroomVisionState){callbacks?.onVisionState?.(value);},get starts(){return starts;},get stops(){return stops;},get disposes(){return disposes;},disconnect(next:ClassroomSnapshot,state:'closed'|'error'='closed'){current=next;callbacks?.onState(state);},emit(next:ClassroomSnapshot){current=next;callbacks?.onSnapshot(next);},fail(next:ClassroomSnapshot){current=next;callbacks?.onFailure?.({code:'provider_error',message:'语音服务返回异常，课堂连接已停止，请重新连接。'});callbacks?.onError('语音服务返回异常，课堂连接已停止，请重新连接。');callbacks?.onState('error');}};
}

test('topic classroom keeps teacher circles and audio controls without learner pointing, pen or next buttons',async()=>{
 const f=fixture({...snapshot,teacherObjectIds:['apple']});
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone} variant="topic"/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));
 assert.equal(screen.getByRole('link',{name:'回到主题首页'}).getAttribute('href'),'/topics');
 await startCameraTestLesson();
 assert.equal(document.querySelector('.tk-real-hotspots'),null);
 for(const name of ['指针','画笔','撤销笔迹','下一段'])assert.equal(screen.queryByRole('button',{name}),null);
 check(document.querySelector('.tk-real-annotation ellipse'));
 check(screen.getByRole('button',{name:'暂停课堂'}));
 check(screen.getByRole('button',{name:'关闭麦克风'}));
 assert.equal(f.points.length,0);assert.equal(f.interactions.length,0);
});

test('topic classroom saves an ended session and exposes its actual expression advice and topic records',async()=>{
 const f=fixture(),baseFetch=globalThis.fetch;let noteReads=0;
 globalThis.fetch=async(input,init)=>{
  if(String(input).includes('/notes?')){noteReads++;return Response.json({ok:true,classroomId:snapshot.id,courseVersion:'picnic:1',entries:[],nextCursor:null,coverage:'captured_sources',preparation:'ready'});}
  return baseFetch(input,init);
 };
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone} variant="topic"/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 fireEvent.click(screen.getByRole('button',{name:'结束课堂'}));fireEvent.click(screen.getByRole('button',{name:'结束并保存'}));
 await waitFor(()=>check(screen.getByRole('heading',{name:'Teeko 给你的表达建议'})));
 await waitFor(()=>check(screen.getByText('这节课还没有可回看的表达参考。')));
 assert.equal(noteReads,1);
 assert.equal(screen.getByRole('link',{name:/查看我的学习记录/}).getAttribute('href'),'/topics/me');
 assert.equal(screen.getByRole('link',{name:/再选一个感兴趣的主题/}).getAttribute('href'),'/topics');
});

test('topic classroom retains its own return route on expired login and confirmed exit',async()=>{
 const destinations:string[]=[];
 globalThis.fetch=async()=>Response.json({ok:false,error:{code:'UNAUTHORIZED',message:'请先登录。'}},{status:401});
 const navigate=(path:string)=>destinations.push(path);
 render(<Classroom classroomId={snapshot.id} voiceFactory={()=>{throw new Error('must not connect');}} variant="topic" navigate={navigate}/>);
 await waitFor(()=>assert.deepEqual(destinations,[`/topics/login?next=${encodeURIComponent(`/topics/classroom/${snapshot.id}`)}`]));
 cleanup();destinations.length=0;
 const f=fixture();render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone} variant="topic" navigate={navigate}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 fireEvent.click(screen.getByRole('button',{name:'退出课堂'}));fireEvent.click(screen.getByRole('button',{name:'保存并退出'}));
 await waitFor(()=>assert.deepEqual(destinations,['/topics']));
});

test('opening camera shares automatically once voice connects, with no second consent button',async()=>{
 const f=fixture();let tracksStopped=0;
 const track=document.createElement('span') as unknown as MediaStreamTrack;Object.assign(track,{stop(){tracksStopped++;}});
 const stream={getTracks:()=>[track],getVideoTracks:()=>[track]} as unknown as MediaStream;
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>stream}});
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'开启摄像头'})));fireEvent.click(screen.getByRole('button',{name:'开启摄像头'}));
 await waitFor(()=>check(screen.getByLabelText('Mia的摄像头预览')));assert.equal(f.visionStarts,0);check(!screen.queryByRole('button',{name:'让老师看见我'}));
 await startCameraTestLesson();await waitFor(()=>assert.equal(f.visionStarts,1));check(!screen.queryByText('画面分享中'));
 f.vision({status:'sharing',generation:1});await waitFor(()=>check(!screen.queryByText('画面分享中')));
 check(!screen.queryByRole('button',{name:'停止分享'}));
 fireEvent.click(screen.getByRole('button',{name:'关闭摄像头'}));await waitFor(()=>check(screen.getByRole('button',{name:'开启摄像头'})));assert.equal(tracksStopped,1);check(f.visionStops>=1);
 fireEvent.click(screen.getByRole('button',{name:'开启摄像头'}));await waitFor(()=>assert.equal(f.visionStarts,2));
});
test('vision errors keep voice and camera preview alive without an automatic retry loop',async()=>{
 const f=fixture();const track=document.createElement('span') as unknown as MediaStreamTrack;Object.assign(track,{stop(){}});
 const stream={getTracks:()=>[track],getVideoTracks:()=>[track]} as unknown as MediaStream;
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>stream}});
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 fireEvent.click(screen.getByRole('button',{name:'开启摄像头'}));await waitFor(()=>assert.equal(f.visionStarts,1));
 f.vision({status:'error',generation:1});await waitFor(()=>check(screen.getByRole('button',{name:'重试画面分享'})));
 assert.equal(f.visionStarts,1);check(screen.getByLabelText('Mia的摄像头预览'));check(!(screen.getByRole('button',{name:'暂停课堂'}) as HTMLButtonElement).disabled);
 fireEvent.click(screen.getByRole('button',{name:'重试画面分享'}));await waitFor(()=>assert.equal(f.visionStarts,2));
});
test('pause, end confirmation and disconnection stop image sharing and ignore terminal callbacks',async t=>{
 for(const cause of ['pause','end','disconnect'] as const)await t.test(cause,async()=>{
  const f=fixture();const track=document.createElement('span') as unknown as MediaStreamTrack;let tracksStopped=0;Object.assign(track,{stop(){tracksStopped++;}});
  const stream={getTracks:()=>[track],getVideoTracks:()=>[track]} as unknown as MediaStream;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>stream}});
  render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
  await waitFor(()=>check(screen.getByRole('button',{name:'开启摄像头'})));fireEvent.click(screen.getByRole('button',{name:'开启摄像头'}));await waitFor(()=>check(screen.getByLabelText('Mia的摄像头预览')));await startCameraTestLesson();
  await waitFor(()=>assert.equal(f.visionStarts,1));f.vision({status:'sharing',generation:1});await waitFor(()=>check(!screen.queryByText('画面分享中')));
  if(cause==='pause')fireEvent.click(screen.getByRole('button',{name:'暂停课堂'}));
  if(cause==='end'){fireEvent.click(screen.getByRole('button',{name:'结束课堂'}));await waitFor(()=>check(screen.getByRole('dialog',{name:'结束确认'})));fireEvent.click(screen.getByRole('button',{name:'结束并保存'}));}
  if(cause==='disconnect')f.disconnect({...snapshot,status:'paused',revision:8});
  await waitFor(()=>assert.equal(tracksStopped,1));check(f.visionStops>0);check(!screen.queryByText('画面分享中'));
  if(cause==='end'){await waitFor(()=>check(screen.getByRole('heading',{name:'这节课已保存'})));f.vision({status:'sharing',generation:1});check(!screen.queryByText('画面分享中'));}
  cleanup();
 });
});

test('classroom removes the task strip and its hint and skip controls',async()=>{
 const f=fixture();render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 assert.equal(screen.queryByRole('button',{name:'课堂提示'}),null);
 assert.equal(screen.queryByRole('button',{name:'提示一下'}),null);
 assert.equal(screen.queryByRole('button',{name:'换一题'}),null);
 assert.equal(document.querySelector('.tk-real-task'),null);assert.equal(f.stops,0);
});

test('top exit asks for confirmation, Escape cancels, and successful save returns to courses',async()=>{
 const f=fixture(),destinations:string[]=[];
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone} navigate={path=>destinations.push(path)}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 fireEvent.click(screen.getByRole('button',{name:'退出课堂'}));
 check(screen.getByRole('dialog',{name:'退出确认'}));assert.deepEqual(destinations,[]);
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});assert.equal(screen.queryByRole('dialog'),null);assert.equal(f.calls.filter(x=>x.body?.type==='end').length,0);
 fireEvent.click(screen.getByRole('button',{name:'退出课堂'}));fireEvent.click(screen.getByRole('button',{name:'保存并退出'}));
 await waitFor(()=>assert.deepEqual(destinations,['/courses']));assert.equal(f.calls.filter(x=>x.body?.type==='end').length,1);
});
test('failed exit save keeps the classroom visible and never navigates away',async()=>{
 const f=fixture(),baseFetch=globalThis.fetch,destinations:string[]=[];
 globalThis.fetch=async(input,init)=>String(input).endsWith('/actions')?Response.json({ok:false,error:{code:'UNAVAILABLE',message:'保存失败，请重试。'}},{status:503}):baseFetch(input,init);
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone} navigate={path=>destinations.push(path)}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 fireEvent.click(screen.getByRole('button',{name:'退出课堂'}));fireEvent.click(screen.getByRole('button',{name:'保存并退出'}));
 await waitFor(()=>check(screen.getByRole('alert').textContent?.includes('保存失败')));assert.deepEqual(destinations,[]);check(screen.getByRole('dialog',{name:'退出确认'}));
});
test('a saved terminal snapshot clears leave protection immediately, before effect cleanup',async()=>{
 const f=fixture();render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 const before=new window.Event('beforeunload',{cancelable:true});window.dispatchEvent(before);assert.equal(before.defaultPrevented,true);
 f.emit({...snapshot,status:'ended',revision:20,endReason:'manual',endedAt:'2026-11-01T00:01:00Z'});
 const after=new window.Event('beforeunload',{cancelable:true});window.dispatchEvent(after);assert.equal(after.defaultPrevented,false);
});
test('connection badges distinguish measured quality and never show good before measurement',async()=>{
 const f=fixture();let callback:((value:{link:'device'|'teacher';quality:{status:'checking'|'good'|'fair'|'poor'|'unavailable';rttMs:number|null}})=>void)|undefined;
 const factory:import('../components/product/classroom').VoiceFactory=options=>{callback=(options as typeof options&{onConnectionQuality?:typeof callback}).onConnectionQuality;return f.voiceFactory(options);};
 render(<Classroom classroomId={snapshot.id} voiceFactory={factory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 assert.equal(screen.getByLabelText('老师连接质量').textContent,'检测中');
 callback?.({link:'teacher',quality:{status:'fair',rttMs:480}});callback?.({link:'device',quality:{status:'good',rttMs:60}});
 await waitFor(()=>assert.equal(screen.getByLabelText('老师连接质量').textContent,'连接一般'));
 assert.equal(screen.getByLabelText('你的连接质量').textContent,'连接良好');
 callback?.({link:'teacher',quality:{status:'poor',rttMs:1200}});
 await waitFor(()=>assert.equal(screen.getByLabelText('老师连接质量').textContent,'连接较差'));
 assert.equal(f.stops,0);
});
test('only a new verified correct outcome triggers reward; old feedback and ordinary speech do not',async()=>{
 const feedback={id:'old-correct',kind:'correct' as const,message:'找到了！'};
 const initial={...snapshot,feedback,outcomes:[{stepId:'earlier-task',status:'independent' as const}]};const f=fixture(initial);
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();check(!document.querySelector('.tk-real-fireworks'));
 f.emit({...initial,status:'active',revision:2,feedback:{id:'unbacked-correct',kind:'correct',message:'普通回应'}});
 await waitFor(()=>check(screen.getByText('普通回应')));check(!document.querySelector('.tk-real-fireworks'));
 f.emit({...initial,status:'active',revision:3,feedback:{id:'new-correct',kind:'correct',message:'答对了'},outcomes:[...initial.outcomes,{stepId:'find-apple',status:'independent'}]});
 await waitFor(()=>check(document.querySelector('.tk-real-fireworks')));
 f.emit({...initial,status:'active',revision:4,feedback:{id:'retry',kind:'retry',message:'再想想'}});
 await waitFor(()=>check(!document.querySelector('.tk-real-fireworks')));
});

test('classroom asks for microphone only after the check click and connects on a separate start gesture',async()=>{
 const f=fixture();let checked=0;
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={async()=>{checked++;return true;}}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));
 assert.equal(checked,0);assert.equal(f.starts,0);
 fireEvent.click(screen.getByRole('button',{name:'检查麦克风'}));
 await waitFor(()=>check(!(screen.getByRole('button',{name:'开始上课'}) as HTMLButtonElement).disabled));
 assert.equal(checked,1);assert.equal(f.starts,0);
 fireEvent.click(screen.getByRole('button',{name:'开始上课'}));
 await waitFor(()=>assert.equal(f.starts,1));
 assert.equal(screen.queryByText('字幕'),null);
});

test('pause stops media and end requires confirmation, then late snapshots cannot revive it',async()=>{
 const f=fixture();render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));
 fireEvent.click(screen.getByRole('button',{name:'检查麦克风'}));await waitFor(()=>check(!(screen.getByRole('button',{name:'开始上课'}) as HTMLButtonElement).disabled));fireEvent.click(screen.getByRole('button',{name:'开始上课'}));
 await waitFor(()=>check(screen.getByRole('button',{name:'暂停课堂'})));
 fireEvent.click(screen.getByRole('button',{name:'暂停课堂'}));
 await waitFor(()=>check(screen.getByRole('heading',{name:'已暂停'})));assert.equal(f.stops,1);
 fireEvent.click(screen.getByRole('button',{name:'结束课堂'}));
 check(screen.getByRole('dialog',{name:'结束确认'}));assert.equal(f.calls.filter(c=>c.body?.type==='end').length,0);
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});check(!screen.queryByRole('dialog',{name:'结束确认'}));check(screen.getByRole('dialog',{name:'课堂已暂停'}));
 fireEvent.click(screen.getByRole('button',{name:'结束课堂'}));fireEvent.click(screen.getByRole('button',{name:'结束并保存'}));
 await waitFor(()=>check(screen.getByRole('heading',{name:'这节课已保存'})));
 f.emit({...snapshot,status:'active',revision:99});
 await waitFor(()=>check(screen.getByRole('heading',{name:'这节课已保存'})));
 assert.equal(f.calls.filter(c=>c.body?.type==='end').length,1);
 assert.equal(f.starts,1);
});

test('an already ended lesson opens its factual summary without starting microphone or voice',async()=>{
 const f=fixture({...snapshot,status:'ended',endReason:'content_completed',endedAt:'2026-11-01T00:03:00Z',elapsedSeconds:180,outcomes:[{stepId:'find-apple',status:'assisted'}]});let checked=0;
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={async()=>{checked++;return true;}}/>);
 await waitFor(()=>check(screen.getByRole('heading',{name:'这节课已保存'})));
 assert.equal(checked,0);assert.equal(f.starts,0);check(screen.getByRole('heading',{name:'本次完成'}));check(screen.getByRole('heading',{name:'再练一点'}));assert.equal(screen.getAllByText('找出苹果').length,2);check(screen.getByText('这次在提示后完成，下次可以先自己试一次。'));check(!screen.queryByText('详细报告暂未开放。'));
 check(!screen.queryByText(/已掌握|发音分数|整理中/));
});

test('an early ending with no assessed answers shows an honest empty recap',async()=>{
 const f=fixture({...snapshot,status:'ended',endReason:'manual',endedAt:'2026-11-01T00:01:00Z',elapsedSeconds:60});
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('heading',{name:'这节课已保存'})));
 check(screen.getByText(/还没有足够的答题记录/));check(screen.getByText('还没有完成的答题记录。'));check(screen.getByText(/下次可以接着：找出苹果/));assert.equal(f.starts,0);
});
test('skipped practice stays a suggestion rather than a completed or mastered answer',async()=>{
 const f=fixture({...snapshot,status:'ended',endReason:'manual',endedAt:'2026-11-01T00:01:00Z',outcomes:[{stepId:'find-apple',status:'skipped'}]});
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('heading',{name:'再练一点'})));
 check(screen.getByText('这次选择跳过，有兴趣时再试；不据此判断能力。'));check(screen.getByText('还没有完成的答题记录。'));check(!screen.queryByText(/已掌握/));
});
test('the final conversation offers a clear recap action instead of ending during speech',async()=>{
 const finalStep={...snapshot.course.steps[0],id:'picnic-chat',kind:'listen' as const,targetId:null,expected:null,english:'We can chat about our picnic.',chinese:'聊聊我们的野餐'};
 const f=fixture({...snapshot,course:{...snapshot.course,steps:[finalStep]}});
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 check(screen.getByRole('button',{name:'查看小结'}));assert.equal(f.calls.filter(call=>call.body?.type==='next').length,0);
 fireEvent.click(screen.getByRole('button',{name:'查看小结'}));await waitFor(()=>assert.equal(f.calls.filter(call=>call.body?.type==='next').length,1));
});

function readingSnapshot(phase:'read'|'chat'='read'):ClassroomSnapshot{
 const reading={phase,passage:'A robot can move through air and water.',goal:'Share one observation.',teacherNotes:'Respect optional reading.',followUp:'What do you notice?'};
 const step={...snapshot.course.steps[0],id:phase==='chat'?'robot-chat':'robot-read',kind:phase==='chat'?'listen' as const:'speak' as const,targetId:null,expected:null,chinese:'读一读机器人的本领',reading};
 return{...snapshot,course:{...snapshot.course,id:'robot-reading',title:'会飞又会游的机器人',durationMinutes:20,reading:{sourceTitle:'DOGOnews',sourceUrl:'https://www.dogonews.com/2026/11/5/robot-inspired-by-diving-birds-can-fly-and-swim',attribution:'DOGOnews 短摘句＋Teeko 原创图示与练习'},steps:[step]}};
}
test('a pointer click shares its ID with the voice attempt and HTTP observation before any server receipt',async()=>{
 const state=readingSnapshot(),f=fixture(state);let attemptedId:string|undefined;
 const voiceFactory:import('../components/product/classroom').VoiceFactory=options=>({...f.voiceFactory(options),sendPoint(_input,id){attemptedId=id;return true;}});
 render(<Classroom classroomId={state.id} voiceFactory={voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();fireEvent.click(screen.getByRole('button',{name:'指认 apple'}));
 await waitFor(()=>check(f.calls.some(call=>call.path.endsWith('/diagnostics'))));
 const event=f.calls.flatMap(call=>call.body?.events??[]).find(event=>event.stage==='clicked');check(event);
 assert.equal(event.pointId,attemptedId);assert.equal(event.objectId,'apple');assert.equal(event.context.activityId,state.course.steps[0].id);assert.equal(f.calls.filter(call=>call.body?.type==='select').length,0);
});
test('an unsupported voice handle leaves a visible retry and an HTTP failure instead of a silent click',async()=>{
 const state=readingSnapshot(),f=fixture(state);
 const voiceFactory:import('../components/product/classroom').VoiceFactory=options=>{const client=f.voiceFactory(options);delete client.sendPoint;return client;};
 render(<Classroom classroomId={state.id} voiceFactory={voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();fireEvent.click(screen.getByRole('button',{name:'指认 apple'}));
 await waitFor(()=>check(f.calls.flatMap(call=>call.body?.events??[]).some(event=>event.stage==='send_failed'&&event.reason==='unsupported')));
 check(screen.getByRole('alert').textContent?.includes('这次指认没有发出，请再点一下。'));assert.equal(f.calls.filter(call=>call.body?.type==='select').length,0);
});
test('reading pointer activation identifies the object locally and sends a bounded unscored reference',async()=>{
 const state=readingSnapshot(),f=fixture(state);render(<Classroom classroomId={state.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 const target=screen.getByRole('button',{name:'指认 apple'}) as HTMLButtonElement;assert.equal(target.disabled,false);
 target.focus();const {default:userEvent}=await import('@testing-library/user-event');await userEvent.setup({document}).keyboard('{Enter}');
 fireEvent.click(target);fireEvent.click(target);
 assert.deepEqual(f.points,[{contextKey:state.id+':0:0',objectId:'apple'}]);assert.equal(target.getAttribute('aria-pressed'),'true');check(target.classList.contains('is-pointed'));
 check(screen.getByRole('status').textContent?.includes('指向 apple'));assert.equal(f.calls.filter(call=>call.body?.type==='select').length,0);check(!document.querySelector('.tk-real-fireworks'));check(!target.classList.contains('is-highlighted'));
 fireEvent.click(screen.getByRole('button',{name:'画笔'}));assert.equal(target.disabled,true);check(screen.getByRole('link',{name:'阅读 DOGOnews 原文'}));
});
test('a confirmed teacher circle separately marks the named robot part on the current textbook',async()=>{
 const state={...snapshot,course:ROBOT_READING_COURSE},f=fixture(state);
 const {container}=render(<Classroom classroomId={state.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 const wings=screen.getByRole('button',{name:'指认 wings'}),body=screen.getByRole('button',{name:'指认 body'});
 assert.equal(container.querySelector('.tk-real-annotation ellipse'),null);
 await act(async()=>f.emit({...state,status:'active',revision:2,teacherObjectIds:['wings']}));
 assert.equal(wings.classList.contains('is-highlighted'),true);
 assert.equal(wings.getAttribute('aria-pressed'),'false');
 assert.equal(body.classList.contains('is-highlighted'),false);
 assert.equal(container.querySelectorAll('.tk-real-annotation ellipse').length,1);
 assert.equal(f.points.length,0);
 assert.equal(f.calls.filter(call=>call.body?.type==='select').length,0);
 await act(async()=>f.emit({...state,status:'active',revision:3,stepIndex:2,teacherObjectIds:[]}));
 assert.equal(container.querySelector('.tk-real-annotation ellipse'),null);
});
test('a rejected pointer send shows a retryable error and retry does not claim a teacher response',async()=>{
 const state=readingSnapshot(),behavior={pointResult:false},f=fixture(state,behavior);render(<Classroom classroomId={state.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();fireEvent.click(screen.getByRole('button',{name:'指认 apple'}));
 check(screen.getByRole('alert').textContent?.includes('这次指认没有发出，请再点一下。'));behavior.pointResult=true;fireEvent.click(screen.getByRole('button',{name:'指认 apple'}));
 assert.equal(f.points.length,2);check(!screen.queryByRole('alert'));assert.equal(f.calls.filter(call=>call.body?.type==='select').length,0);
});
for(const change of ['step','epoch','pause','disconnect'] as const)test('local pointer clears on '+change+' and never replays',async()=>{
 const state=readingSnapshot();state.course.steps.push({...state.course.steps[0],id:'robot-read-next'});const f=fixture(state);render(<Classroom classroomId={state.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();fireEvent.click(screen.getByRole('button',{name:'指认 apple'}));check(document.querySelector('.is-pointed'));
 const next={...state,status:'active' as const,revision:2,...(change==='step'?{stepIndex:1}:change==='epoch'?{connectionEpoch:1}:change==='pause'?{status:'paused' as const}:{})};
 await act(async()=>{if(change==='disconnect')f.disconnect(next,'error');else f.emit(next);});
 check(!document.querySelector('.is-pointed'));assert.equal(f.points.length,1);check(!document.querySelector('.sr-only[role="status"]')?.textContent?.includes('指向 apple'));
 if(change==='step'||change==='epoch'){fireEvent.click(screen.getByRole('button',{name:'指认 apple'}));assert.equal(f.points.length,2);assert.equal(f.points[1].contextKey,[state.id,next.connectionEpoch,next.stepIndex].join(':'));}
});
test('overlapping reading objects keep smaller targets above broad wings while preserving source access',async()=>{
 const state={...snapshot,course:ROBOT_READING_COURSE},f=fixture(state);render(<Classroom classroomId={state.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 const body=screen.getByRole('button',{name:'指认 body'}),wings=screen.getByRole('button',{name:'指认 wings'});
 check(Number(body.style.zIndex)>Number(wings.style.zIndex));fireEvent.click(body);assert.equal(f.points[0].objectId,'body');check(screen.getByRole('link',{name:/阅读 .* 原文/}));
});
test('reading navigation is learner-driven, versioned and available only after voice connects',async()=>{
 const state=readingSnapshot(),f=fixture(state);
 render(<Classroom classroomId={state.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));
 const next=document.querySelector<HTMLButtonElement>('.tk-real-main-controls button[aria-label="下一段"]');check(next);check(next.disabled);
 await startCameraTestLesson();check(!screen.getByRole('button',{name:'下一段'}).hasAttribute('disabled'));
 assert.equal(f.calls.filter(call=>call.body?.type==='next').length,0);
 const source=screen.getByRole('link',{name:'阅读 DOGOnews 原文'});assert.equal(source.getAttribute('target'),'_blank');assert.equal(source.getAttribute('rel'),'noopener noreferrer');assert(source.getAttribute('href')?.startsWith('https://www.dogonews.com/'));
 fireEvent.click(screen.getByRole('button',{name:'下一段'}));await waitFor(()=>assert.equal(f.calls.filter(call=>call.body?.type==='next').length,1));assert.equal(f.calls.find(call=>call.body?.type==='next')?.body?.expectedRevision,1);
});
test('the reading terminal chat offers recap, while picnic never gains reading navigation',async()=>{
 const state=readingSnapshot('chat'),f=fixture(state);render(<Classroom classroomId={state.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();check(screen.getByRole('button',{name:'查看小结'}));check(!screen.queryByRole('button',{name:'下一段'}));cleanup();
 const picnic=fixture();render(<Classroom classroomId={snapshot.id} voiceFactory={picnic.voiceFactory} checkMicrophone={picnic.checkMicrophone}/>);await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();check(!screen.queryByRole('button',{name:'下一段'}));check(!screen.queryByRole('link',{name:/阅读 .* 原文/}));
});
test('reading source metadata cannot create a script link or a remote fetch',async()=>{
 const state=readingSnapshot();state.course.reading!.sourceUrl='javascript:alert(1)';const f=fixture(state);render(<Classroom classroomId={state.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();check(!screen.queryByRole('link',{name:/阅读 .* 原文/}));check(f.calls.every(call=>call.path.startsWith('/api/v1/')));
});
test('reading recap lists browsed activities without zero-score achievement counters',async()=>{
 const state=readingSnapshot();state.status='ended';state.endReason='manual';state.endedAt='2026-11-15T00:01:00Z';state.outcomes=[{stepId:'robot-read',status:'unassessed'}];const f=fixture(state);
 render(<Classroom classroomId={state.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('heading',{name:'已浏览的带读活动'})));check(screen.getByText('读一读机器人的本领'));check(screen.getByText('已浏览活动'));check(!screen.queryByText('独立完成'));check(!screen.queryByText('提示后完成'));check(screen.getByText(/不评价理解或掌握/));assert.equal(f.starts,0);
});

test('reading course introduction keeps one start action and clearly names its material',async()=>{
 const state=readingSnapshot(),calls:string[]=[];globalThis.fetch=async input=>{calls.push(String(input));return String(input).endsWith('/classroom-options')?Response.json(options):Response.json({ok:true,courses:[{...state.course,progress:{stepIndex:0,completed:false}}],activeClassroom:null,recentClassrooms:[]});};
 render(<Courses/>);await waitFor(()=>check(screen.getByRole('heading',{name:state.course.title})));check(screen.getByText('约 20 分钟'));check(screen.getByText(state.course.reading!.attribution));check(screen.getByRole('link',{name:'阅读 DOGOnews 原文'}));assert.equal(screen.getAllByRole('button',{name:'跟 Teeko 老师一起学'}).length,1);assert.equal(calls.length,2);
});

test('repeated selection while a server action is pending sends only one versioned action',async()=>{
 const f=fixture();const baseFetch=globalThis.fetch;let finish:((response:Response)=>void)|undefined;
 globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith('/actions')&&typeof init?.body==='string'&&JSON.parse(init.body).type==='select'){
   f.calls.push({path:String(input),body:JSON.parse(init.body)});return new Promise<Response>(resolve=>{finish=resolve;});
  }
  return baseFetch(input,init);
 };
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));fireEvent.click(screen.getByRole('button',{name:'检查麦克风'}));await waitFor(()=>check(!(screen.getByRole('button',{name:'开始上课'}) as HTMLButtonElement).disabled));fireEvent.click(screen.getByRole('button',{name:'开始上课'}));
 await waitFor(()=>check(!(screen.getByRole('button',{name:'选择 apple'}) as HTMLButtonElement).disabled));
 const target=screen.getByRole('button',{name:'选择 apple'});fireEvent.click(target);fireEvent.click(target);
 assert.equal(f.calls.filter(call=>call.body?.type==='select').length,1);
 finish?.(Response.json({ok:true,classroom:{...snapshot,status:'active',revision:2,feedback:{id:'answer-1',kind:'correct',message:'You found the apple!'}}}));
 await waitFor(()=>check(screen.getByText('You found the apple!')));
});

test('an action conflict rereads the authoritative classroom and does not report success',async()=>{
 const f=fixture();const baseFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>String(input).endsWith('/actions')?Response.json({ok:false,error:{code:'STALE_REVISION',message:'课堂已经更新，请重新试一次。'}},{status:409}):baseFetch(input,init);
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));fireEvent.click(screen.getByRole('button',{name:'检查麦克风'}));await waitFor(()=>check(!(screen.getByRole('button',{name:'开始上课'}) as HTMLButtonElement).disabled));fireEvent.click(screen.getByRole('button',{name:'开始上课'}));
 await waitFor(()=>check(!(screen.getByRole('button',{name:'选择 apple'}) as HTMLButtonElement).disabled));fireEvent.click(screen.getByRole('button',{name:'选择 apple'}));
 await waitFor(()=>check(screen.getByRole('alert').textContent?.includes('课堂已经更新')));
 check(f.calls.filter(call=>call.path===`/api/v1/classrooms/${snapshot.id}`).length>=2);
 check(!document.querySelector('.tk-real-fireworks'));
});

test('a pending connection replaces preflight with an accessible cancel action',async()=>{
 const f=fixture();let stopped=0;
 const waitingVoice:import('../components/product/classroom.tsx').VoiceFactory=options=>({start:async()=>{options.onState('connecting');},stop:async()=>{stopped++;options.onState('closed');},dispose(){},setMuted(){},sendText(){},startVision(){return false;},stopVision(){}});
 render(<Classroom classroomId={snapshot.id} voiceFactory={waitingVoice} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));fireEvent.click(screen.getByRole('button',{name:'检查麦克风'}));await waitFor(()=>check(!(screen.getByRole('button',{name:'开始上课'}) as HTMLButtonElement).disabled));fireEvent.click(screen.getByRole('button',{name:'开始上课'}));
 check(screen.getByRole('button',{name:'取消连接'}));check(!screen.queryByRole('region',{name:'准备上课'}));
 fireEvent.click(screen.getByRole('button',{name:'取消连接'}));await waitFor(()=>assert.equal(stopped,1));
});


test('ending uses the revision after media close and succeeds with one confirmation',async()=>{
 const f=fixture(snapshot,{pauseOnStop:true});render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));fireEvent.click(screen.getByRole('button',{name:'检查麦克风'}));await waitFor(()=>check(!(screen.getByRole('button',{name:'开始上课'}) as HTMLButtonElement).disabled));fireEvent.click(screen.getByRole('button',{name:'开始上课'}));
 await waitFor(()=>check(screen.getByRole('button',{name:'结束课堂'})));fireEvent.click(screen.getByRole('button',{name:'结束课堂'}));fireEvent.click(screen.getByRole('button',{name:'结束并保存'}));
 await waitFor(()=>check(screen.getByRole('heading',{name:'这节课已保存'})));
 const endings=f.calls.filter(call=>call.body?.type==='end');assert.equal(endings.length,1);assert.equal(endings[0].body?.expectedRevision,2);
});

test('pause accepts a server-confirmed close transition without posting a stale pause action',async()=>{
 const f=fixture(snapshot,{pauseOnStop:true});render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));fireEvent.click(screen.getByRole('button',{name:'检查麦克风'}));await waitFor(()=>check(!(screen.getByRole('button',{name:'开始上课'}) as HTMLButtonElement).disabled));fireEvent.click(screen.getByRole('button',{name:'开始上课'}));
 await waitFor(()=>check(screen.getByRole('button',{name:'暂停课堂'})));fireEvent.click(screen.getByRole('button',{name:'暂停课堂'}));
 await waitFor(()=>check(screen.getByRole('heading',{name:'已暂停'})));assert.equal(f.calls.filter(call=>call.body?.type==='pause').length,0);check(!screen.queryByRole('alert'));
});

test('server end observed only after socket closure is reread into the terminal summary',async()=>{
 const f=fixture();render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));fireEvent.click(screen.getByRole('button',{name:'检查麦克风'}));await waitFor(()=>check(!(screen.getByRole('button',{name:'开始上课'}) as HTMLButtonElement).disabled));fireEvent.click(screen.getByRole('button',{name:'开始上课'}));
 await waitFor(()=>assert.equal(f.starts,1));f.disconnect({...snapshot,status:'ended',revision:3,endReason:'time_limit',endedAt:'2026-11-01T00:10:00Z',elapsedSeconds:600});
 await waitFor(()=>check(screen.getByRole('heading',{name:'这节课已保存'})));check(screen.getByText(/本次课堂时间已到，进度已保留。/));assert.equal(f.starts,1);
});

test('close-related revision conflicts retry once with the same event ID',async()=>{
 const f=fixture(snapshot,{pauseOnStop:true}),baseFetch=globalThis.fetch;const endings:{eventId:string;expectedRevision:number}[]=[];
 let race=true;
 globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith('/actions')&&typeof init?.body==='string'&&JSON.parse(init.body).type==='end'){
   const body=JSON.parse(init.body);endings.push(body);
   if(race){race=false;return Response.json({ok:false,error:{code:'STALE_REVISION',message:'课堂已经更新。'}},{status:409});}
  }
  return baseFetch(input,init);
 };
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));fireEvent.click(screen.getByRole('button',{name:'检查麦克风'}));await waitFor(()=>check(!(screen.getByRole('button',{name:'开始上课'}) as HTMLButtonElement).disabled));fireEvent.click(screen.getByRole('button',{name:'开始上课'}));
 await waitFor(()=>check(screen.getByRole('button',{name:'结束课堂'})));fireEvent.click(screen.getByRole('button',{name:'结束课堂'}));fireEvent.click(screen.getByRole('button',{name:'结束并保存'}));
 await waitFor(()=>check(screen.getByRole('heading',{name:'这节课已保存'})));assert.equal(endings.length,2);assert.equal(endings[0].eventId,endings[1].eventId);check(!screen.queryByRole('alert'));
});

test('a close that reaches PostgreSQL shortly after the socket is reconciled without reopening media',async()=>{
 const f=fixture(),baseFetch=globalThis.fetch;let disconnected=false,reads=0;
 globalThis.fetch=async(input,init)=>{
  if(disconnected&&String(input)===`/api/v1/classrooms/${snapshot.id}`&&reads++===0)return Response.json({ok:true,classroom:{...snapshot,status:'active',revision:2}});
  return baseFetch(input,init);
 };
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));fireEvent.click(screen.getByRole('button',{name:'检查麦克风'}));await waitFor(()=>check(!(screen.getByRole('button',{name:'开始上课'}) as HTMLButtonElement).disabled));fireEvent.click(screen.getByRole('button',{name:'开始上课'}));
 await waitFor(()=>assert.equal(f.starts,1));disconnected=true;f.disconnect({...snapshot,status:'ended',revision:3,endReason:'time_limit',endedAt:'2026-11-01T00:10:00Z',elapsedSeconds:600},'error');
 await waitFor(()=>check(screen.getByRole('heading',{name:'这节课已保存'})));assert.equal(f.starts,1);assert.equal(reads,2);
});


function microphoneFixture(){
 const previousContext=Object.getOwnPropertyDescriptor(globalThis,'AudioContext'),previousMedia=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');
 const events:string[]=[],requests:MediaStreamConstraints[]=[];let resolveMedia!:(stream:MediaStream)=>void,rejectMedia!:(error:Error)=>void,stopped=0,closed=0,analysers=0;
 const media=new Promise<MediaStream>((resolve,reject)=>{resolveMedia=resolve;rejectMedia=reject;});
 class Context{
  constructor(){events.push('context');}
  async resume(){events.push('resume');}
  async close(){closed++;}
  createAnalyser(){analysers++;return{fftSize:512,getByteTimeDomainData(values:Uint8Array){values.fill(150);}};}
  createMediaStreamSource(){return{connect(){}};}
 }
 Object.defineProperty(globalThis,'AudioContext',{value:Context,configurable:true});
 Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:(constraints:MediaStreamConstraints)=>{events.push('media');requests.push(constraints);return media;}},configurable:true});
 return{events,requests,get stopped(){return stopped;},get closed(){return closed;},get analysers(){return analysers;},resolve(){resolveMedia({getTracks:()=>[{stop(){stopped++;}}]} as unknown as MediaStream);},reject(){rejectMedia(new Error('permission rejected'));},restore(){if(previousContext)Object.defineProperty(globalThis,'AudioContext',previousContext);else Reflect.deleteProperty(globalThis,'AudioContext');if(previousMedia)Object.defineProperty(navigator,'mediaDevices',previousMedia);else Reflect.deleteProperty(navigator,'mediaDevices');}};
}

test('the real microphone check primes WebAudio synchronously before pending permission',async()=>{
 const f=microphoneFixture(),controller=new AbortController();const checked=checkClassroomMicrophone(()=>{},controller.signal);
 try{assert.deepEqual(f.events,['context','resume','media']);assert.equal(f.requests[0].video,false);}
 finally{controller.abort();f.resolve();await checked;f.restore();}
});

test('the real microphone check cleans its primed context when permission is rejected',async()=>{
 const f=microphoneFixture(),controller=new AbortController();
 try{const checked=checkClassroomMicrophone(()=>{},controller.signal);const rejected=assert.rejects(checked,/permission rejected/);f.reject();await rejected;assert.equal(f.closed,1);assert.equal(f.stopped,0);}
 finally{controller.abort();f.restore();}
});

test('aborting a pending microphone permission resolves promptly and stops the late stream',async()=>{
 const f=microphoneFixture(),controller=new AbortController();let timeout:ReturnType<typeof setTimeout>|undefined;
 try{const checked=checkClassroomMicrophone(()=>{},controller.signal);controller.abort();const result=await Promise.race([checked,new Promise<string>(resolve=>{timeout=setTimeout(()=>resolve('still checking'),100);})]);assert.equal(result,false);assert.equal(f.closed,1);f.resolve();await Promise.resolve();await Promise.resolve();assert.equal(f.stopped,1);}
 finally{if(timeout)clearTimeout(timeout);controller.abort();f.resolve();f.restore();}
});

test('aborting an active microphone check releases analysis and microphone tracks',async()=>{
 const f=microphoneFixture(),controller=new AbortController();
 try{const checked=checkClassroomMicrophone(()=>{},controller.signal);f.resolve();await waitFor(()=>assert.equal(f.analysers,1));controller.abort();assert.equal(await checked,false);assert.equal(f.closed,1);assert.equal(f.stopped,1);}
 finally{controller.abort();f.restore();}
});

test('an unanswered microphone permission check times out and cleans any late stream',async t=>{
 const f=microphoneFixture(),controller=new AbortController();t.mock.timers.enable({apis:['setTimeout']});
 try{
  const checked=checkClassroomMicrophone(()=>{},controller.signal),rejected=assert.rejects(checked,/检查超时/);
  t.mock.timers.tick(30000);await rejected;assert.equal(f.closed,1);f.resolve();await Promise.resolve();await Promise.resolve();assert.equal(f.stopped,1);
 }finally{controller.abort();t.mock.timers.reset();f.restore();}
});

test('optional camera requests browser video permission only on click and survives the preflight transition',async()=>{
 const f=fixture();let calls=0,stops=0;
 const track=document.createElement('span') as unknown as MediaStreamTrack;Object.assign(track,{stop(){stops++;}});
 const stream={getTracks:()=>[track],getVideoTracks:()=>[track]} as unknown as MediaStream;
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async(constraints:MediaStreamConstraints)=>{calls++;assert.equal(constraints.audio,false);assert.ok(constraints.video);return stream;}}});
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'开启摄像头'})));assert.equal(calls,0);
 fireEvent.click(screen.getByRole('button',{name:'开启摄像头'}));
 await waitFor(()=>check(screen.getByLabelText('Mia的摄像头预览')));assert.equal(calls,1);assert.equal((screen.getByLabelText('Mia的摄像头预览') as HTMLVideoElement).srcObject,stream);
 await startCameraTestLesson();assert.equal(calls,1);assert.equal(stops,0);check(screen.getByRole('button',{name:'关闭摄像头'}));
 fireEvent.click(screen.getByRole('button',{name:'暂停课堂'}));await waitFor(()=>check(screen.getByRole('heading',{name:'已暂停'})));assert.equal(stops,1);
});

test('denying camera permission leaves microphone and lesson start available',async()=>{
 const f=fixture();Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{throw new DOMException('browser detail','NotAllowedError');}}});
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'开启摄像头'})));fireEvent.click(screen.getByRole('button',{name:'开启摄像头'}));
 await waitFor(()=>check(screen.getByText(/摄像头未获授权/)));await startCameraTestLesson();assert.equal(f.starts,1);check(screen.getByRole('button',{name:'暂停课堂'}));
});

async function startCameraTestLesson(){
 fireEvent.click(screen.getByRole('button',{name:'检查麦克风'}));
 await waitFor(()=>check(!(screen.getByRole('button',{name:'开始上课'}) as HTMLButtonElement).disabled));
 fireEvent.click(screen.getByRole('button',{name:'开始上课'}));
 await waitFor(()=>check(!(screen.getByRole('button',{name:'暂停课堂'}) as HTMLButtonElement).disabled));
}

test('transport failure is explained as a broken connection instead of a voluntary pause',async()=>{
 const f=fixture();render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 f.fail({...snapshot,status:'paused',revision:2,connectionEpoch:1});
 await waitFor(()=>check(screen.getByRole('heading',{name:'课堂连接中断'})));check(screen.getByRole('alert').textContent?.includes('语音服务返回异常'));
 assert.equal(screen.getByRole('alert').getAttribute('data-voice-failure'),'provider_error');
 fireEvent.click(screen.getByRole('button',{name:'继续上课'}));await waitFor(()=>check(screen.getByRole('button',{name:'开始上课'})));assert.equal(f.starts,1);
});


test('camera and microphone switches stay in the child footer, without busy turn text',async()=>{
 const f=fixture();const track=document.createElement('span') as unknown as MediaStreamTrack;Object.assign(track,{stop(){}});
 const stream={getTracks:()=>[track],getVideoTracks:()=>[track]} as unknown as MediaStream;
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>stream}});
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 const camera=screen.getByRole('button',{name:'开启摄像头'}),microphone=screen.getByRole('button',{name:'关闭麦克风'});
 check(camera.closest('.tk-real-child > footer'));check(microphone.closest('.tk-real-child > footer'));
 assert.equal(screen.queryByText('正在听你说'),null);assert.equal(screen.queryByText('可以直接开口'),null);
 fireEvent.click(microphone);await waitFor(()=>check(screen.getByRole('button',{name:'开启麦克风'})));assert.deepEqual(f.muted,[true]);
 fireEvent.click(screen.getByRole('button',{name:'开启麦克风'}));assert.deepEqual(f.muted,[true,false]);
 fireEvent.click(camera);await waitFor(()=>check(screen.getByRole('button',{name:'关闭摄像头'})));
 check(screen.getByRole('button',{name:'关闭摄像头'}).closest('.tk-real-child > footer'));assert.equal(document.querySelector('.tk-real-child-stage .tk-camera-toggle'),null);
});

test('active lesson timer advances between snapshots and stops immediately on disconnection',async()=>{
 const f=fixture({...snapshot,elapsedSeconds:28},{readyFirst:true});render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 assert.equal(screen.getByLabelText('已上课时间').textContent,'0:28');
 await waitFor(()=>assert.equal(screen.getByLabelText('已上课时间').textContent,'0:29'),{timeout:1800});
 f.disconnect({...snapshot,status:'paused',elapsedSeconds:29,revision:4});
 await waitFor(()=>check(screen.getByRole('heading',{name:'已暂停'})));
 const timer=document.querySelector('time')?.textContent;await new Promise(resolve=>setTimeout(resolve,1100));assert.equal(document.querySelector('time')?.textContent,timer);
});


test('pen strokes cross the full textbook in foreground with a contrasting outline',async()=>{
 const f=fixture();render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 const previous=Object.getOwnPropertyDescriptor(window,'PointerEvent');
 class Pointer extends window.MouseEvent{pointerId:number;constructor(type:string,init:MouseEventInit&{pointerId?:number}){super(type,init);this.pointerId=init.pointerId??1;}}
 Object.defineProperty(window,'PointerEvent',{configurable:true,value:Pointer});
 try{
  const layer=screen.getByRole('img',{name:'教材标注区域'});Object.defineProperty(layer,'getBoundingClientRect',{value:()=>({left:100,top:50,width:450,height:360})});
  fireEvent.click(screen.getByRole('button',{name:'画笔'}));
  fireEvent.pointerDown(layer,{clientX:145,clientY:86,pointerId:1});fireEvent.pointerMove(layer,{clientX:235,clientY:212,pointerId:1});fireEvent.pointerMove(layer,{clientX:505,clientY:374,pointerId:1});fireEvent.pointerUp(layer,{clientX:505,clientY:374,pointerId:1});
  const stroke=layer.querySelector('.tk-real-stroke');check(stroke);
  const lines=stroke.querySelectorAll('polyline');assert.equal(lines.length,2);
  assert.equal(lines[0].getAttribute('points'),'90,72 270,324 810,648');assert.equal(lines[0].getAttribute('points'),lines[1].getAttribute('points'));
  check(Number(lines[0].getAttribute('stroke-width'))>Number(lines[1].getAttribute('stroke-width')));
  assert.equal(layer.parentElement?.lastElementChild,layer);
  assert.deepEqual(f.interactions,[{contextKey:`${snapshot.id}:0:0`,action:'draw',strokeCount:1,pointCount:3}]);
  fireEvent.click(screen.getByRole('button',{name:'撤销笔迹'}));assert.equal(layer.querySelector('.tk-real-stroke'),null);assert.deepEqual(f.interactions[1],{contextKey:`${snapshot.id}:0:0`,action:'undo',strokeCount:0,pointCount:3});
  fireEvent.click(screen.getByRole('button',{name:'指针'}));check(layer.classList.contains('is-pointer'));
  fireEvent.click(screen.getByRole('button',{name:'选择 apple'}));await waitFor(()=>assert.equal(f.calls.filter(call=>call.body?.type==='select').length,1));
 }finally{if(previous)Object.defineProperty(window,'PointerEvent',previous);else Reflect.deleteProperty(window,'PointerEvent');}
});

test('changing the preferred provider does not pretend a frozen active classroom has switched services',async()=>{
 const destinations:string[]=[];let starts=0;
 globalThis.fetch=async(input,init)=>{
  const path=String(input);
  if(path.endsWith('/classroom-options'))return Response.json({...options,preferences:{...snapshot.preferences,provider:'qwen'}});
  if(path.endsWith('/classrooms')&&init?.method==='POST'){starts++;return Response.json({ok:true,classroom:snapshot});}
  return Response.json({ok:true,courses:[{...snapshot.course,progress:{stepIndex:1,completed:false}}],activeClassroom:{id:snapshot.id,courseId:'picnic',status:'paused',provider:'openai'}});
 };
 render(<Courses navigate={path=>destinations.push(path)}/>);
 await waitFor(()=>assert(screen.getByText('当前课堂使用 GPT Live；通义将在新课堂生效。')));
 fireEvent.click(screen.getByRole('button',{name:'回到正在上的课'}));assert.deepEqual(destinations,[`/classroom/${snapshot.id}`]);assert.equal(starts,0);
});


test('formal classroom renders a committed current chalk note and acknowledges it without grading',async()=>{
 const f=fixture();const {act}=await import('@testing-library/react');const {captureClassroomToolState}=await import('../lib/classroom-tool-state');
 render(<Classroom classroomId={snapshot.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('button',{name:'检查麦克风'})));await startCameraTestLesson();
 const active={...snapshot,status:'active' as const,revision:1},captured=captureClassroomToolState(active);assert(captured.ok);
 const id='00000001-0000-4000-8000-000000000001',now=Date.now(),writing={type:'chalk.write' as const,id,context:captured.snapshot.context,text:'I like apples.',receivedAtMs:now,expiresAtMs:now+8000};
 await act(async()=>f.chalk(writing));assert.equal(screen.getByRole('note',{name:'Teacher writing'}).textContent,writing.text);assert.deepEqual(f.chalkReceipts,[id]);check(!document.querySelector('.tk-real-fireworks'));assert.equal(f.calls.filter(call=>call.body?.type==='select').length,0);
 await act(async()=>f.emit({...active,status:'paused',revision:2}));assert.equal(screen.queryByRole('note'),null);
 await act(async()=>f.chalk(writing));assert.equal(screen.queryByRole('note'),null);assert.deepEqual(f.chalkReceipts,[id]);
});

test('ended classrooms expose source notes in a keyboard-accessible tab and only fetch when opened',async()=>{
 const ended={...snapshot,status:'ended' as const,endedAt:'2026-11-01T00:01:00Z',endReason:'manual' as const};const f=fixture(ended),readClassroom=globalThis.fetch;let notesReads=0;
 globalThis.fetch=async(input,init)=>{if(String(input).includes('/notes?')){notesReads++;return Response.json({ok:true,classroomId:ended.id,courseVersion:`${ended.course.id}:${ended.course.version}`,entries:[],nextCursor:null,coverage:'retained_sources'});}return readClassroom(input,init);};
 render(<Classroom classroomId={ended.id} voiceFactory={f.voiceFactory} checkMicrophone={f.checkMicrophone}/>);
 await waitFor(()=>check(screen.getByRole('tab',{name:'课堂表达'})));assert.equal(notesReads,0);assert.equal(f.starts,0);
 const summary=screen.getByRole('tab',{name:'本次小结'}),notes=screen.getByRole('tab',{name:'课堂表达'});assert.equal(summary.getAttribute('aria-selected'),'true');fireEvent.click(notes);
 await waitFor(()=>check(screen.getByText('这节课还没有可回看的表达参考。')));assert.equal(notesReads,1);assert.equal(notes.getAttribute('aria-selected'),'true');fireEvent.keyDown(notes,{key:'ArrowLeft'});assert.equal(summary.getAttribute('aria-selected'),'true');assert.equal(document.activeElement,summary);check(screen.getByRole('heading',{name:'本次完成'}));
});
