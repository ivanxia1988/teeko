import React from 'react';
import assert from 'node:assert/strict';
import test,{after,afterEach} from 'node:test';
import {JSDOM} from 'jsdom';
import {ROBOT_READING_COURSE} from '../lib/server/robot-reading-course';
import type {LabEvent,LabEventInput} from '../lib/interaction-lab';
import {labTeacherMark,type LabTeacherMark} from '../lib/interaction-lab-mark';
import {labVisualContext,type LabVisualPrepare,type LabVisualReady} from '../lib/interaction-lab-visual';
import {PcmVoiceAudio} from '../lib/voice-audio';
import {useInteractionLab,type InteractionLabController} from '../components/lab/use-interaction-lab';
import {teacherSnapshot} from './teacher-runtime-fixture';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://127.0.0.1:8084/interaction-lab',pretendToBeVisual:true});
for(const key of ['window','self','document','HTMLElement','HTMLInputElement','Node','Event','MouseEvent','PointerEvent','MutationObserver','navigator'])Object.defineProperty(globalThis,key,{value:(dom.window as unknown as Record<string,unknown>)[key],configurable:true});
const {render,renderHook,screen,fireEvent,act,cleanup}=await import('@testing-library/react');
const {InteractionLabView}=await import('../components/lab/interaction-lab');
afterEach(cleanup);after(()=>dom.window.close());

function fixture(patch:Partial<InteractionLabController>={}){
 const points:string[]=[],observations:LabEventInput[]=[],texts:string[]=[],prepared:LabVisualPrepare[]=[],ready:LabVisualReady[]=[],cleared:{contextKey:string;id?:string}[]=[];
 const controller:InteractionLabController={
  state:'connected',snapshot:teacherSnapshot({course:ROBOT_READING_COURSE,stepIndex:0}),events:[],teacherMarks:[],error:null,teacherLevel:0,childLevel:0,audioPaused:false,resumeOutput(){},
  guided:false,async navigateGuide(){return false;},acknowledgeGuide(){},async start(){},async stop(){},sendPoint(id){points.push(id);return true;},sendText(text){texts.push(text);return true;},
  acknowledgeMark(){},async selectText(){return false;},
  observe(event){observations.push(event);},
  prepareVisual(input){prepared.push(input);return true;},finishVisual(input){ready.push(input);return true;},
  clearVisual(contextKey,id){cleared.push({contextKey,id});return true;},...patch,
 };
 return{controller,points,observations,texts,prepared,ready,cleared};
}

test('opening the lab shows one page and only connects on a user click',async()=>{
 let starts=0;
 const f=fixture({state:'idle',snapshot:null,async start(){starts++;}});
 render(<InteractionLabView controller={f.controller}/>);
 assert.equal(starts,0);
 assert.equal(screen.getByAltText('会飞又会游的机器人教材插图').getAttribute('src'),'/course-assets/robot-reading-predict-illustration.svg');
 assert.match(viewText('h3[data-text-id="title"]'),/^An unusual machine$/);
 assert.match(viewText('[data-text-id="footer"]'),/^TEEKO original diagram and activity$/);
 assert.equal((screen.getByRole('button',{name:'画笔'}) as HTMLButtonElement).disabled,true);
 assert.equal(screen.queryByRole('button',{name:'发送教材画面'}),null);
 fireEvent.click(screen.getByRole('button',{name:'连接并开麦'}));
 assert.equal(starts,1);
});

test('lab can resume a blocked sound output on the same connection with a click',()=>{
 let resumes=0,reconnects=0;
 const f=fixture({state:'connecting',audioPaused:true,resumeOutput(){resumes++;},async start(){reconnects++;}});
 const view=render(<InteractionLabView controller={f.controller}/>);
 fireEvent.click(screen.getByRole('button',{name:'恢复声音'}));
 assert.equal(resumes,1);
 assert.equal(reconnects,0);
 view.rerender(<InteractionLabView controller={{...f.controller,state:'connected',audioPaused:false}}/>);
 assert.equal(screen.queryByRole('button',{name:'恢复声音'}),null);
});

test('lab restores its original AudioContext, discards paused speech, and ignores cancelled audio',async t=>{
 const contexts:TestAudioContext[]=[];
 const sockets:TestSocket[]=[];
 let requests=0,allowResume=false;
 const base=teacherSnapshot({course:ROBOT_READING_COURSE});
 const snapshot={...base,preferences:{...base.preferences,provider:'openai' as const}};
 class TestAudioContext extends dom.window.EventTarget{
  state:AudioContextState='suspended';
  resumeCalls=0;
  constructor(){super();contexts.push(this);}
  change(state:AudioContextState){this.state=state;this.dispatchEvent(new dom.window.Event('statechange'));}
  async resume(){this.resumeCalls++;if(allowResume)this.change('running');}
  async close(){this.change('closed');}
 }
 class TestSocket{
  readyState=1;
  bufferedAmount=0;
  onmessage?:(event:{data:string})=>void;
  onclose?:()=>void;
  constructor(){sockets.push(this);}
  receive(event:object){this.onmessage?.({data:JSON.stringify(event)});}
  send(message:string){if(JSON.parse(message).type==='close')this.close();}
  close(){if(this.readyState===1){this.readyState=3;this.onclose?.();}}
 }
 const replace=(target:object,key:string,value:unknown)=>{
  const previous=Object.getOwnPropertyDescriptor(target,key);
  Object.defineProperty(target,key,{value,configurable:true});
  t.after(()=>{if(previous)Object.defineProperty(target,key,previous);else Reflect.deleteProperty(target,key);});
 };
 replace(globalThis,'AudioContext',TestAudioContext);
 replace(globalThis,'WebSocket',TestSocket);
 replace(globalThis,'location',dom.window.location);
 replace(navigator,'mediaDevices',{async getUserMedia(){return{getTracks:()=>[]};}});
 let launch:(response:Response)=>void=()=>assert.fail('Expected session bootstrap request');
 replace(globalThis,'fetch',(input:string,init:RequestInit)=>{
  if(input.startsWith('/lab/events/'))return Promise.resolve(Response.json({cursor:0,events:[]}));
  requests++;
  return new Promise<Response>((resolve,reject)=>{launch=resolve;init.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true});});
 });
 t.mock.method(PcmVoiceAudio.prototype,'startCapture',async()=>{});
 const play=t.mock.method(PcmVoiceAudio.prototype,'playChunk',()=>{});
 const clear=t.mock.method(PcmVoiceAudio.prototype,'cancelPlayback',()=>{});
 const {result,unmount}=renderHook(useInteractionLab);
 try{
  let starting:Promise<void>=Promise.resolve();
  act(()=>{starting=result.current.start('gpt-live');});
  assert.equal(result.current.audioPaused,true);
  assert.equal(contexts[0]?.resumeCalls,1);
  allowResume=true;
  await act(async()=>{result.current.resumeOutput();assert.equal(contexts[0]?.resumeCalls,2);});
  assert.equal(result.current.audioPaused,false);
  assert.equal(contexts.length,1);
  assert.equal(requests,1);
  await act(async()=>{launch(Response.json({id:snapshot.id,snapshot}));});
  const socket=sockets[0];
  assert.ok(socket);
  await act(async()=>{socket.receive({type:'ready',inputSampleRate:24000,outputSampleRate:24000});await starting;});
  const pcm={type:'audio',audio:'AAA=',sampleRate:24000};
  act(()=>socket.receive(pcm));
  assert.equal(play.mock.callCount(),1);
  act(()=>contexts[0]?.change('suspended'));
  assert.equal(result.current.audioPaused,true);
  assert.equal(clear.mock.callCount(),1);
  act(()=>{for(let index=0;index<30;index++)socket.receive(pcm);});
  assert.equal(play.mock.callCount(),1);
  assert.equal(result.current.state,'connected');
  await act(async()=>result.current.resumeOutput());
  act(()=>socket.receive(pcm));
  assert.equal(play.mock.callCount(),2);
  assert.equal(sockets.length,1);
  await act(async()=>{await result.current.stop();});
  assert.equal(result.current.audioPaused,false);
  act(()=>contexts[0]?.change('suspended'));
  assert.equal(result.current.audioPaused,false);
 }finally{unmount();}
});

function viewText(selector:string){return document.querySelector(selector)?.textContent??'';}

test('guided timeline names the mounted mark and clicked part and keeps raw transport available',()=>{
 const snapshot=teacherSnapshot({course:ROBOT_READING_COURSE,revision:3,teacherObjectIds:['body']});
 const f=fixture({guided:true,snapshot,events:[
  {id:'open',at:100,layer:'provider',kind:'connection',label:'应用向通义请求开始回复',data:{event:'response.create'}},
  {id:'mark',at:200,layer:'display',kind:'tool',label:'页面确认',data:{event:'guide.highlight.displayed',targetIds:'body'}},
  {id:'tap',at:300,layer:'browser',kind:'point',label:'浏览器发出点选',data:{event:'interaction.point',pointId:'point-one',objectId:'tail'}},
  {id:'sent',at:350,layer:'provider',kind:'point',label:'通义回复请求含教材对象参考',data:{event:'response.create',objectId:'tail'}},
  {id:'playing',at:1600,layer:'display',kind:'audio',label:'本次回应开始播放',data:{event:'point.playback_started',stage:'playback_started',pointId:'point-one'}},
 ]});
 render(<InteractionLabView controller={f.controller}/>);
 const trace=screen.getByRole('region',{name:'处理事件明细'});
 assert.match(trace.textContent??'',/页面已圈出机身/);
 assert.match(trace.textContent??'',/你点了尾部/);
 assert.match(trace.textContent??'',/尾部已发给通义/);
 assert.match(trace.textContent??'',/开始播放老师对尾部的回应/);
 assert.doesNotMatch(trace.textContent??'',/应用向通义请求开始回复/);
 const bodyCircle=screen.getByLabelText('老师圈出的机身');
 // The tail of the original SVG widens at y=363. A body pointer must leave it visible as a separate choice.
 const lowerEdge=Number(bodyCircle.getAttribute('cy'))+Number(bodyCircle.getAttribute('ry'));
 assert.ok(lowerEdge>=363&&lowerEdge<380,`body circle ends at ${lowerEdge}`);
 fireEvent.click(screen.getByRole('button',{name:'全部事件'}));
 assert.match(trace.textContent??'',/应用向通义请求开始回复/);
});

test('GPT Live timeline shows why sound was held or paused without opening all events',()=>{
 const base=teacherSnapshot({course:ROBOT_READING_COURSE});
 const snapshot={...base,preferences:{...base.preferences,provider:'openai' as const}};
 const f=fixture({snapshot,guided:true,events:[
  {id:'withheld',at:100,layer:'server',kind:'audio',label:'老师有声音，正在等学生说完',data:{event:'gpt.audio.withheld',reason:'learner_audio'}},
  {id:'paused',at:200,layer:'browser',kind:'error',label:'浏览器暂停了声音，可以点击恢复声音'},
  {id:'resumed',at:300,layer:'browser',kind:'audio',label:'浏览器已恢复声音播放',data:{event:'audio.resumed'}},
 ]});
 render(<InteractionLabView controller={f.controller}/>);
 const trace=screen.getByRole('region',{name:'处理事件明细'});
 assert.match(trace.textContent??'',/正在等学生说完/);
 assert.match(trace.textContent??'',/浏览器暂停了声音/);
 assert.match(trace.textContent??'',/浏览器已恢复声音播放/);
});

test('guided reading is opt-in and opens the live session instead of playing a file',()=>{
 const starts:unknown[][]=[];
 const f=fixture({state:'idle',snapshot:null,async start(...args:unknown[]){starts.push(args);}});
 render(<InteractionLabView controller={f.controller}/>);
 assert.deepEqual(starts,[]);
 fireEvent.click(screen.getByRole('button',{name:'开始实时带读'}));
 assert.deepEqual(starts,[['guided']]);
 assert.equal(document.querySelector('audio'),null);
});

test('GPT Live lab starts explicitly and its second page mounts named words and acknowledges only visible marks',async()=>{
 const starts:unknown[][]=[];
 const idle=fixture({state:'idle',snapshot:null,async start(...args:unknown[]){starts.push(args);}});
 const view=render(<InteractionLabView controller={idle.controller}/>);
 fireEvent.click(screen.getByRole('button',{name:'开始 GPT Live 标注测试'}));
 assert.deepEqual(starts,[['gpt-live']]);

 const base=teacherSnapshot({course:ROBOT_READING_COURSE,stepIndex:2,revision:4});
 const snapshot={...base,preferences:{...base.preferences,provider:'openai' as const}};
 const ack:string[]=[],selected:string[]=[];
 const marks:LabTeacherMark[]=[
  {actionId:crypto.randomUUID(),pageId:'robot-read',revision:4,shape:'underline',targetId:'read-transition',box:{x:.1,y:.7,w:.45,h:.08}},
  {actionId:crypto.randomUUID(),pageId:'robot-read',revision:2,shape:'highlight',targetId:'read-swimming',box:{x:.1,y:.7,w:.45,h:.08}},
 ];
 const f=fixture({snapshot,guided:true,teacherMarks:marks,async selectText(id:string){selected.push(id);return true;},acknowledgeMark(id:string){
  assert.equal(view.container.querySelector('[data-text-id="read-transition"]')?.getAttribute('data-underline'),'true');ack.push(id);
 }});
 view.rerender(<InteractionLabView controller={f.controller}/>);
 assert.match(screen.getByRole('status').textContent??'',/GPT Live/);
 assert.equal(view.container.querySelector('h3[data-text-id="read-title"]')?.textContent,'One sentence, one discovery');
 assert.match(viewText('[data-text-id="read-passage"]'),/transition from flying to swimming/);
 assert.equal(view.container.querySelector('[data-text-id="read-swimming"]')?.hasAttribute('data-highlight'),false);
 assert.deepEqual(ack,[marks[0].actionId]);
 fireEvent.click(screen.getByRole('button',{name:'transition'}));
 await act(async()=>{});
 assert.deepEqual(selected,['read-transition']);
 assert.equal(f.ready.length,0);
});

test('guided reading acknowledges mounted text and illustration highlights and switches page state',async()=>{
 const displayed:number[]=[],requests:number[]=[];
 const course={...ROBOT_READING_COURSE,pages:ROBOT_READING_COURSE.pages.slice(0,2),steps:[ROBOT_READING_COURSE.steps[0],ROBOT_READING_COURSE.steps[2]]};
 const snapshot=teacherSnapshot({course,stepIndex:0,revision:2,teacherObjectIds:['passage-machine']});
 const f=fixture({snapshot,guided:true,async navigateGuide(stepIndex:number){requests.push(stepIndex);return true;},acknowledgeGuide(revision:number){
  assert(document.querySelector(revision===2?'[data-text-id=passage-machine][data-guide-highlight=true]':'[data-object-id=wings][data-guide-highlight=true]'));
  displayed.push(revision);
 }});
 const view=render(<InteractionLabView controller={f.controller} captureRegion={async()=>'/9j/2Q=='}/>);
 assert.equal((screen.getByRole('button',{name:'上一页'}) as HTMLButtonElement).disabled,true);
 assert.deepEqual(displayed,[2]);
 assert.equal(document.querySelector('[data-text-id=title-machine][data-guide-highlight=true]'),null);
 const paper=view.container.querySelector<HTMLElement>('.tl-paper')!;
 paper.getBoundingClientRect=()=>new dom.window.DOMRect(15,5,200,160);
 fireEvent.click(view.container.querySelector('button[data-text-id="passage-machine"]')!,{detail:1,clientX:100,clientY:117});
 await act(async()=>{});
 assert.equal(view.container.querySelector('.tl-picture')!==null,true);
 fireEvent.click(screen.getByRole('button',{name:'下一页'}));
 await act(async()=>{});
 assert.deepEqual(requests,[1]);
 view.rerender(<InteractionLabView controller={{...f.controller,snapshot:{...snapshot,stepIndex:1,revision:3,teacherObjectIds:[]}}}/>);
 assert.equal(view.container.querySelector('.tl-picture'),null);
 assert.equal(view.container.querySelector('[data-guide-highlight=true]'),null);
 assert.equal(view.container.querySelector('.tl-paper > img')?.getAttribute('src'),'/course-assets/robot-reading-read.svg');
 assert.equal((screen.getByRole('button',{name:'下一页'}) as HTMLButtonElement).disabled,true);
 assert.deepEqual(displayed,[2]);
 view.rerender(<InteractionLabView controller={{...f.controller,snapshot:{...snapshot,stepIndex:1,revision:4,teacherObjectIds:['wings']}}}/>);
 view.rerender(<InteractionLabView controller={{...f.controller,snapshot:{...snapshot,stepIndex:1,revision:4,teacherObjectIds:['wings']}}}/>);
 assert.deepEqual(displayed,[2,4]);
});

test('the two HTML machine words stage their exact text IDs and capture still uses the full reference SVG',async()=>{
 const f=fixture(),captureImages:string[]=[];
 const view=render(<InteractionLabView controller={f.controller} captureRegion={async image=>{
  captureImages.push(image.getAttribute('src')??'');
  assert.equal(image.hidden,true);
  return '/9j/2Q==';
 }}/>);
 const paper=view.container.querySelector<HTMLElement>('.tl-paper')!;
 paper.getBoundingClientRect=()=>new dom.window.DOMRect(15,5,200,160);
 const title=view.container.querySelector<HTMLButtonElement>('button[data-text-id="title-machine"]')!;
 const passage=view.container.querySelector<HTMLButtonElement>('button[data-text-id="passage-machine"]')!;
 assert.equal(title?.textContent,'machine');
 assert.equal(passage?.textContent,'machine');
 fireEvent.click(passage,{detail:1,clientX:100,clientY:117});
 await act(async()=>{});
 assert.equal(passage.getAttribute('aria-pressed'),'true');
 assert.equal(title.getAttribute('aria-pressed'),'false');
 assert.deepEqual(f.prepared[0].point,{x:.425,y:.7});
 title.getBoundingClientRect=()=>new dom.window.DOMRect(74,22,30,12);
 title.focus();
 const userEvent=(await import('@testing-library/user-event')).default;
 await userEvent.setup({document}).keyboard('{Enter}');
 assert.deepEqual(f.prepared.map(frame=>'textId' in frame?frame.textId:undefined),['passage-machine','title-machine']);
 assert.deepEqual(f.prepared[1].point,{x:.37,y:.144});
 assert.equal(title.getAttribute('aria-pressed'),'true');
 assert.equal(passage.getAttribute('aria-pressed'),'false');
 assert.deepEqual(captureImages,['/course-assets/robot-reading-predict.svg','/course-assets/robot-reading-predict.svg']);
 assert.equal(f.ready.length,2);
});

test('HTML highlight and underline only style the matching occurrence and emit render receipts',()=>{
 const f=fixture(),pageId=f.controller.snapshot!.course.steps[0].pageId;
 const marks=[
  {shape:'highlight',targetId:'passage-machine',actionId:crypto.randomUUID()},
  {shape:'underline',targetId:'passage-machine',actionId:crypto.randomUUID()},
 ] as const;
 const confirmed=(mark:Pick<LabTeacherMark,'shape'|'targetId'|'actionId'>)=>labTeacherMark({
  layer:'server',kind:'tool',label:'老师标注已确认',data:{event:'teacher.mark',...mark,pageId,x:.42,y:.67,w:.11,h:.04},
 })!;
 const teacherMarks=marks.map(confirmed);
 const view=render(<InteractionLabView controller={{...f.controller,teacherMarks}}/>);
 const title=view.container.querySelector('button[data-text-id="title-machine"]');
 const passage=view.container.querySelector('button[data-text-id="passage-machine"]');
 assert(passage?.matches('[data-highlight="true"][data-underline="true"]'));
 assert(!title?.matches('[data-highlight="true"],[data-underline="true"]'));
 const receiptIds=()=>f.observations.filter(event=>event.data?.event==='teacher.mark.displayed').map(event=>event.data?.actionId);
 const renderedIds=marks.map(mark=>mark.actionId);
 assert.deepEqual(receiptIds(),renderedIds);

 const late=confirmed({shape:'highlight',targetId:'title-machine',actionId:crypto.randomUUID()});
 view.rerender(<InteractionLabView controller={{...f.controller,state:'error',error:'实验语音已断开',teacherMarks:[...teacherMarks,late]}}/>);
 assert.equal(passage?.matches('[data-highlight="true"][data-underline="true"]'),true);
 assert(!title?.matches('[data-highlight="true"]'));
 assert(passage?.matches(':disabled'));
 assert.deepEqual(receiptIds(),renderedIds);

 view.rerender(<InteractionLabView controller={{...f.controller,state:'connecting',snapshot:null,teacherMarks:[]}}/>);
 view.rerender(<InteractionLabView controller={{...f.controller,snapshot:{...f.controller.snapshot!,id:crypto.randomUUID()},teacherMarks:[]}}/>);
 assert.equal(view.container.querySelector('[data-highlight="true"],[data-underline="true"]'),null);
 assert.deepEqual(receiptIds(),renderedIds);
});

test('known hotspots keep object recognition; a click on the text stages then sends only its local crop',async()=>{
 const f=fixture();let release!:(value:string)=>void;
 const view=render(<InteractionLabView controller={f.controller} captureRegion={(_image,point,canvas)=>{
  assert.deepEqual(point,{x:.1,y:.85});assert(canvas);canvas.width=468;canvas.height=312;
  return new Promise(resolve=>{release=resolve;});
 }}/>);
 const target=screen.getByRole('button',{name:'点选翅膀'}),paper=view.container.querySelector<HTMLElement>('.tl-paper')!;
 paper.getBoundingClientRect=()=>new dom.window.DOMRect(20,20,100,100);
 fireEvent.click(target,{detail:1,clientX:45,clientY:54});
 assert.deepEqual(f.points,['wings']);
 assert.equal(target.getAttribute('aria-pressed'),'true');
 assert.deepEqual(f.observations[0].data,{objectId:'wings',label:'wings',geometrySent:false,screenshotSent:false,localX:.25,localY:.34});
 assert.deepEqual(f.prepared,[]);
 fireEvent.click(paper,{detail:1,clientX:30,clientY:105});
 assert.deepEqual(f.points,['wings']);assert.equal(f.prepared.length,1);
 const [{contextKey,id,kind,point}]=f.prepared;
 assert.equal(contextKey,labVisualContext(f.controller.snapshot!));assert.equal(kind,'region');assert.deepEqual(point,{x:.1,y:.85});
 assert.equal(f.ready.length,0);
 assert(view.container.querySelector('[data-region-pointer]'));
 await act(async()=>release('/9j/2Q=='));
 assert.deepEqual(f.ready,[{contextKey,id,image:'/9j/2Q=='}]);
 assert.match(screen.getByText(/准备的教材局部/).textContent??'',/468 × 312/);
 view.rerender(<InteractionLabView controller={{...f.controller,events:[
  {id:'server-unrelated',at:100,layer:'provider',kind:'image',label:'已向通义转发本轮教材图',data:{visualId:'other-visual',state:'provider_sent'}},
 ]}}/>);
 assert(screen.getByText(/局部图已准备好/));
 view.rerender(<InteractionLabView controller={{...f.controller,events:[
  {id:'provider-matching',at:150,layer:'provider',kind:'image',label:'已向通义转发本轮教材图',data:{visualId:id,state:'provider_sent'}},
 ]}}/>);
 assert(screen.getByText('教材图已随本轮语音发给通义。'));
 view.rerender(<InteractionLabView controller={{...f.controller,events:[
  {id:'server-late',at:175,layer:'server',kind:'image',label:'待用教材图已取消',data:{visualId:id,state:'speech_ended_before_send'}},
 ]}}/>);
 assert(screen.getByText('这张教材图没有随语音发送。'));
 view.rerender(<InteractionLabView controller={{...f.controller,events:[
  {id:'server-matching',at:200,layer:'server',kind:'image',label:'已关联到本轮语音',data:{visualId:id,state:'speech_ended'}},
 ]}}/>);
 assert(screen.getByText('教材图已关联到你刚才的语音。'));
});

test('a finished stroke automatically prepares a matching JPEG for the next question; the last undo clears it',async()=>{
 const f=fixture();let captured=0,release!:(value:string)=>void;
 const view=render(<InteractionLabView controller={f.controller} capture={async(_image,marks,canvas)=>{
  captured++;assert.equal(marks.length,1);assert.deepEqual(marks[0].points,[{x:.1,y:.1},{x:.3,y:.4},{x:.5,y:.6}]);
  assert(canvas);canvas.width=500;canvas.height=400;return new Promise(resolve=>{release=resolve;});
 }}/>);
 const drawing=screen.getByRole('img',{name:'老师圈选与本地笔迹'});
 drawing.getBoundingClientRect=()=>new dom.window.DOMRect(0,0,100,100);
 fireEvent.click(screen.getByRole('button',{name:'画笔'}));
 fireEvent.pointerDown(drawing,{pointerId:1,clientX:10,clientY:10,button:0});
 fireEvent.pointerMove(drawing,{pointerId:1,clientX:30,clientY:40,button:0});
 fireEvent.pointerUp(drawing,{pointerId:1,clientX:50,clientY:60,button:0});
 assert.equal(view.container.querySelectorAll('polyline').length,2);
 assert.equal(captured,1);assert.equal(f.prepared.length,1);assert.equal(f.prepared[0].kind,'board');assert.equal(f.ready.length,0);
 await act(async()=>release('/9j/2Q=='));
 const {id,contextKey}=f.prepared[0];assert.deepEqual(f.ready,[{id,contextKey,image:'/9j/2Q=='}]);
 const preview=screen.getByText(/准备的笔迹图/);assert.match(preview.textContent??'',/500 × 400/);
 assert(screen.getByText(/最新笔迹已准备好/));
 assert(f.observations.some(event=>event.data?.bytes===4&&event.data?.strokes===1));
 fireEvent.click(screen.getByRole('button',{name:'撤销'}));
 assert.equal(view.container.querySelectorAll('polyline').length,0);
 assert.deepEqual(f.cleared,[{id,contextKey}]);assert.equal(f.ready.length,1);
});

test('new strokes and undo replace the queued image with the latest set of marks',async()=>{
 const f=fixture(),pending:{count:number;resolve:(frame:string)=>void}[]=[];
 render(<InteractionLabView controller={f.controller} capture={(_image,marks)=>new Promise(resolve=>pending.push({count:marks.length,resolve}))}/>);
 const drawing=screen.getByRole('img',{name:'老师圈选与本地笔迹'});
 drawing.getBoundingClientRect=()=>new dom.window.DOMRect(0,0,100,100);
 fireEvent.click(screen.getByRole('button',{name:'画笔'}));
 for(const i of [1,2]){
  fireEvent.pointerDown(drawing,{pointerId:i,clientX:i*10,clientY:10,button:0});
  fireEvent.pointerUp(drawing,{pointerId:i,clientX:i*10+10,clientY:30,button:0});
 }
 fireEvent.click(screen.getByRole('button',{name:'撤销'}));
 assert.deepEqual(pending.map(item=>item.count),[1,2,1]);
 assert.equal(new Set(f.prepared.map(frame=>frame.id)).size,3);
 await act(async()=>{pending[1].resolve('/9j/2Q==');pending[0].resolve('/9j/2Q==');});
 assert.equal(f.ready.length,0);
 await act(async()=>pending[2].resolve('/9j/2Q=='));
 assert.equal(f.ready.length,1);assert.equal(f.ready[0].id,f.prepared[2].id);
});

test('a superseded visual completion never resurrects; a disconnect discards the new in-flight crop',async()=>{
 const f=fixture(),pending:((frame:string)=>void)[]=[];
 const captureRegion=()=>new Promise<string>(resolve=>pending.push(resolve));
 const view=render(<InteractionLabView controller={f.controller} captureRegion={captureRegion}/>);
 const paper=view.container.querySelector<HTMLElement>('.tl-paper')!;
 paper.getBoundingClientRect=()=>new dom.window.DOMRect(0,0,100,100);
 fireEvent.click(paper,{clientX:20,clientY:70});
 fireEvent.click(paper,{clientX:60,clientY:80});
 assert.equal(f.prepared.length,2);
 await act(async()=>pending[0]('/9j/2Q=='));assert.deepEqual(f.ready,[]);
 view.rerender(<InteractionLabView controller={{...f.controller,state:'closed'}} captureRegion={captureRegion}/>);
 await act(async()=>pending[1]('/9j/2Q=='));assert.deepEqual(f.ready,[]);
});

test('a confirmed teacher highlight describes a rendered DOM result',()=>{
 const f=fixture(),snapshot=f.controller.snapshot!;
 const view=render(<InteractionLabView controller={f.controller}/>);
 view.rerender(<InteractionLabView controller={{...f.controller,snapshot:{...snapshot,teacherObjectIds:['tail']}}}/>);
 assert.equal(view.container.querySelector('ellipse')?.getAttribute('data-object-id'),'tail');
 assert.equal(f.observations.filter(event=>event.layer==='display'&&event.kind==='tool').length,1);
});

test('approved teacher circles and underlines draw on the current textbook and acknowledge each action once',()=>{
 const f=fixture(),pageId=f.controller.snapshot!.course.steps[0].pageId;
 const action=(shape:'circle'|'underline',targetId:string,at:number):LabEvent=>({id:`server-${at}`,at,layer:'server',kind:'tool',label:'老师标注已确认',data:{event:'teacher.mark',actionId:crypto.randomUUID(),shape,targetId,pageId,x:.06,y:.09,w:.46,h:.064}});
 const circle=action('circle','page-center',10),underline=action('underline','opening',20);
 const stale=action('circle','tail',30);stale.data!.pageId='other-page';
 const proposed={...action('underline','body',40),layer:'provider'} as const;
 const invalid=action('underline','wings',50);invalid.data!.w=1;
 const actions=[circle,underline,stale,proposed,invalid];
 const teacherMarks=actions.map(labTeacherMark).filter((mark):mark is LabTeacherMark=>mark!==null);
 const view=render(<InteractionLabView controller={{...f.controller,events:actions,teacherMarks}}/>);
 const mark=(event:LabEvent)=>view.container.querySelector(`[data-action-id="${event.data?.actionId}"]`);
 const shape=mark(circle);assert.equal(shape?.localName,'ellipse');assert(Math.abs(Number(shape?.getAttribute('cx'))-261)<.01);
 const line=mark(underline);assert.equal(line?.localName,'line');
 assert.equal(Number(line?.getAttribute('x1')),54);assert.equal(Number(line?.getAttribute('x2')),468);
 assert(Number(line?.getAttribute('y1'))>(.09+.064)*720);
 for(const event of [stale,proposed,invalid])assert.equal(mark(event),null);
 const receipts=()=>f.observations.filter(event=>event.layer==='display'&&event.kind==='tool');
 assert.deepEqual(receipts().map(event=>event.data?.actionId),[circle.data?.actionId,underline.data?.actionId]);
 view.rerender(<InteractionLabView controller={{...f.controller,events:[],teacherMarks:[...teacherMarks]}}/>);
 assert.equal(view.container.querySelectorAll('[data-action-id]').length,2);
 assert.equal(receipts().length,2);
 view.rerender(<InteractionLabView controller={{...f.controller,state:'closed',events:actions,teacherMarks}}/>);
 assert.equal(view.container.querySelectorAll('[data-action-id]').length,2);
 assert.equal(receipts().length,2);
});

test('transcripts and transport facts render separately, and typed examples require explicit sending',()=>{
 const f=fixture({events:[
  {id:'browser-1',at:100,layer:'browser',kind:'point',label:'浏览器发出点选',data:{event:'interaction.point',objectId:'wings',coordinatesSent:false}},
  {id:'server-1',at:250,layer:'provider',kind:'speech',label:'老师语音转写',transcript:{role:'teacher',text:'Let us look at the wings.'}},
 ]});
 render(<InteractionLabView controller={f.controller}/>);
 const transcript=screen.getByRole('list',{name:'最近对话'});assert.match(transcript.textContent??'',/Let us look at the wings/);
 const events=screen.getByRole('region',{name:'处理事件明细'});
 assert.match(events.textContent??'',/浏览器发出点选/);assert.match(events.textContent??'',/coordinatesSent/);assert.match(events.textContent??'',/\+0.15 s/);
 fireEvent.click(screen.getByRole('button',{name:'Please circle the wings.'}));assert.deepEqual(f.texts,[]);
 fireEvent.click(screen.getByRole('button',{name:'发送'}));assert.deepEqual(f.texts,['Please circle the wings.']);
 fireEvent.click(screen.getByRole('button',{name:'Please underline the title.'}));assert.equal(f.texts.length,1);
 fireEvent.click(screen.getByRole('button',{name:'发送'}));assert.equal(f.texts.at(-1),'Please underline the title.');
});
