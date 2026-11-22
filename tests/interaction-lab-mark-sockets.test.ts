import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import test,{type TestContext} from 'node:test';
import WebSocket,{WebSocketServer} from 'ws';
import type {ClassroomSnapshot} from '../lib/classroom-contract';
import type {LabEventBatch,LabSession} from '../lib/interaction-lab';
import {labVisualContext} from '../lib/interaction-lab-visual';
import {startInteractionLabServer} from '../scripts/interaction-lab/server';

const configuration={key:'synthetic-lab-mark-key',model:'qwen3.8-omni-flash-realtime',voice:'Tina',region:'cn-beijing',workspaceId:'synthetic-fixture'};
const jpeg=(await readFile(new URL('./fixtures/vision-candidates/dark.jpg',import.meta.url))).toString('base64');
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(description:string,ready:()=>boolean|Promise<boolean>){
 const until=performance.now()+2200;
 while(!await ready()){if(performance.now()>=until)assert.fail(description);await delay(10);}
}

type BrowserMessage={type:string;classroom?:ClassroomSnapshot};
async function fixture(t:TestContext){
 const listener=createServer(),provider=new WebSocketServer({server:listener});
 listener.listen(0,'127.0.0.1');await once(listener,'listening');
 const address=listener.address();assert(address&&typeof address==='object');
 let clock=Date.now();
 const lab=await startInteractionLabServer({port:0,now:()=>clock,configuration:async()=>configuration,connect:(_url,headers)=>new WebSocket('ws://127.0.0.1:'+address.port,{headers})});
 let upstream:WebSocket|undefined,closeBrowser=()=>{},replies=0,applicationReplies=0;
 const received:BrowserMessage[]=[];
 t.after(async()=>{
  closeBrowser();await lab.close();for(const socket of provider.clients)socket.terminate();
  await new Promise<void>(resolve=>provider.close(()=>resolve()));
  listener.closeAllConnections();await new Promise<void>(resolve=>listener.close(()=>resolve()));
 });
 const fromProvider=(event:unknown)=>{assert(upstream&&upstream.readyState===WebSocket.OPEN);upstream.send(JSON.stringify(event));};
 const response=()=>{
  const id='reply-'+(++replies);
  fromProvider({type:'response.created',response:{id}});
  fromProvider({type:'response.done',response:{id,status:'completed'}});
 };
 provider.on('connection',socket=>{
  upstream=socket;fromProvider({type:'session.created',session:{id:'synthetic-lab-mark-session'}});
  socket.on('message',raw=>{
   const event=JSON.parse(raw.toString());
   if(event.type==='session.update')fromProvider({type:'session.updated'});
   if(event.type==='response.create'){applicationReplies++;response();}
  });
 });
 const start=await fetch(lab.origin+'/lab/session',{method:'POST',headers:{Origin:lab.origin}});
 assert.equal(start.status,201);
 const cookie=start.headers.get('set-cookie')?.split(';')[0];assert(cookie);
 const auth={Cookie:cookie};
 const session=await start.json() as LabSession;
 const contextKey=labVisualContext(session.snapshot);
 const browser=new WebSocket(lab.origin.replace(/^http/,'ws')+'/ws/classrooms/'+session.id,{headers:{Origin:lab.origin,...auth}});
 closeBrowser=()=>browser.terminate();
 browser.on('message',raw=>received.push(JSON.parse(raw.toString())));
 await once(browser,'open');
 const send=(event:unknown)=>browser.send(JSON.stringify(event));
 async function trace(){
  const result=await fetch(lab.origin+'/lab/events/'+session.id+'?after=0',{headers:auth});
  assert.equal(result.status,200);return (await result.json() as LabEventBatch).events;
 }
 await waitFor('greeting must finish before an interaction',async()=>received.some(event=>event.type==='ready')&&(await trace()).some(event=>event.data?.event==='response.done'));
 send({type:'audio',audio:Buffer.alloc(3200,0x19).toString('base64')});
 await waitFor('PCM should reach the provider before visual input',async()=>(await trace()).some(event=>event.data?.event==='input_audio_buffer.append'));
 const marks=async()=>(await trace()).filter(event=>event.layer==='server'&&event.kind==='tool'&&event.data?.event==='teacher.mark').map(event=>event.data!);
 return {
  received,trace,marks,applicationReplies:()=>applicationReplies,
  advance(ms:number){clock+=ms;},
  async utter(itemId:string,transcript:string){
   const seen=new Set((await trace()).map(event=>event.id));
   fromProvider({type:'input_audio_buffer.speech_started',item_id:itemId});
   fromProvider({type:'input_audio_buffer.speech_stopped',item_id:itemId});
   fromProvider({type:'conversation.item.input_audio_transcription.completed',item_id:itemId,transcript});
   response();
   await waitFor('voice turn should finish its application check',async()=>(await trace()).some(event=>!seen.has(event.id)&&event.layer==='server'&&event.kind==='tool'&&(event.data?.itemId===itemId||event.data?.tool==='delegate')));
  },
  text(text:string){send({type:'text',text});},
  async stage(point:{x:number;y:number},textId?:string,ready=true){
   const id=randomUUID();send({type:'lab.visual.stage',id,contextKey,kind:'region',point,...(textId?{textId}:{})});
   if(ready)send({type:'lab.visual.ready',id,contextKey,image:jpeg});
   await waitFor('textbook selection should reach the lab',async()=>(await trace()).some(event=>event.data?.visualId===id&&event.data?.state===(ready?'ready':'staged')));
   return id;
  },
  speak(itemId:string){fromProvider({type:'input_audio_buffer.speech_started',item_id:itemId});},
  stop(itemId:string){fromProvider({type:'input_audio_buffer.speech_stopped',item_id:itemId});},
  final(itemId:string,transcript:string){fromProvider({type:'conversation.item.input_audio_transcription.completed',item_id:itemId,transcript});},
  reply:response,
 };
}

function assertBox(mark:Record<string,string|number|boolean>){
 const {x,y,w,h}=mark;
 assert(typeof x==='number'&&typeof y==='number'&&typeof w==='number'&&typeof h==='number');
 assert(x>=0&&y>=0&&w>0&&h>0&&x+w<=1&&y+h<=1);
 assert.match(String(mark.actionId),/^[\da-f-]{36}$/);
}

test('one typed request and one completed spoken request visibly target the printed textbook title',async t=>{
 const f=await fixture(t);
 f.text('Please underline the title.');
 await waitFor('a typed command should emit one visible underline',async()=>(await f.marks()).length===1);
 await waitFor('only the ordinary typed reply should start',()=>f.applicationReplies()===2);
 f.speak('spoken-title');f.stop('spoken-title');f.final('spoken-title','把标题圈起来。');f.reply();
 await waitFor('validated speech should emit its circle',async()=>(await f.marks()).length===2);
 const [underline,circle]=await f.marks();
 assert.equal(underline.shape,'underline');assert.equal(circle.shape,'circle');
 for(const mark of [underline,circle]){assert.equal(mark.targetId,'title');assert.equal(mark.pageId,'robot-predict');assertBox(mark);}
 assert.notEqual(underline.actionId,circle.actionId);
 assert.equal(f.applicationReplies(),2,'mark execution must not add a second native turn');
 assert(!f.received.some(event=>event.type==='error'));
 for(const event of f.received)if(event.classroom){assert.equal(event.classroom.stepIndex,0);assert.deepEqual(event.classroom.outcomes,[]);}
});

test('a deictic circle uses the same spoken-item point once and leaves an unrelated next turn unmarked',async t=>{
 const f=await fixture(t),point={x:.88,y:.91},visual=await f.stage(point);
 f.text('Please circle here.');
 await waitFor('unlocated typed command should yield its normal response',()=>f.applicationReplies()===2);
 assert.deepEqual(await f.marks(),[]);
 f.speak('visual-command');f.stop('visual-command');f.final('visual-command','Please circle here.');f.reply();
 await waitFor('the attached point should yield a circle',async()=>(await f.marks()).length===1);
 const [mark]=await f.marks();
 assert.equal(mark.shape,'circle');assertBox(mark);
 assert(Number(mark.x)<=point.x&&Number(mark.x)+Number(mark.w)>=point.x);
 assert(Number(mark.y)<=point.y&&Number(mark.y)+Number(mark.h)>=point.y);
 f.final('visual-command','Please circle here.');
 f.speak('unlinked-command');f.stop('unlinked-command');f.final('unlinked-command','Please circle here.');f.reply();
 await waitFor('unlinked spoken command should finish its application check',async()=>(await f.trace()).some(event=>event.data?.event==='teacher.mark.unresolved'&&event.data?.itemId==='unlinked-command'));
 const trace=await f.trace();
 assert.equal(trace.find(event=>event.data?.visualId===visual&&event.data?.state==='speech_ended')?.data?.itemId,'visual-command');
 assert(!JSON.stringify(trace).includes(jpeg));
 assert.equal((await f.marks()).length,1);
 assert.equal(f.applicationReplies(),2);
});

test('late transcription from a superseded speech item cannot apply a mark to current speech',async t=>{
 const f=await fixture(t);
 f.speak('old-command');f.stop('old-command');f.reply();
 f.speak('new-command');
 f.final('old-command','Please underline the title.');
 f.stop('new-command');f.final('new-command','Tell me what this robot does.');f.reply();
 await waitFor('transport should report the historical final and the accepted new input',async()=>{
  const trace=await f.trace();
  return trace.some(event=>event.label==='较早的转写已被新输入替换')&&trace.some(event=>event.transcript?.text==='Tell me what this robot does.');
 });
 assert.deepEqual(await f.marks(),[]);
 assert(!f.received.some(event=>event.type==='error'));
});

test('the reported multi-turn circle resumes after a short clarification and the exact current click',async t=>{
 const f=await fixture(t);
 await f.utter('ask-word','你可以帮我圈选一个单词吗？');
 f.advance(8370);
 await f.utter('first-machine','我想全选machine。');
 f.advance(9950);
 await f.utter('stray-fragment','实现。');
 f.advance(11650);
 await f.utter('second-machine','全选machine。');
 f.advance(5620);
 await f.utter('vague-position','在中间。');
 assert.deepEqual(await f.marks(),[]);
 f.advance(4390);
 const visual=await f.stage({x:.424,y:.695});
 f.advance(2580);
 await f.utter('word-click','我点了。');
 const [mark]=await f.marks();
 assert.equal((await f.marks()).length,1);
 assert.equal(mark.shape,'circle');
 assert.equal(mark.targetId,'passage-machine');
 assert.equal(mark.itemId,'word-click');
 assertBox(mark);
 const trace=await f.trace();
 assert.equal(trace.find(e=>e.data?.visualId===visual&&e.data?.state==='speech_ended')?.data?.itemId,mark.itemId);
 for(const itemId of ['ask-word','first-machine','second-machine']){
  assert(trace.some(e=>e.data?.event==='teacher.mark.unresolved'&&e.data?.itemId===itemId));
 }
 f.final('word-click','我点了。');
 await f.utter('repeat-click-no-point','我点了。');
 assert.equal((await f.marks()).length,1);
 assert.equal(f.applicationReplies(),1,'the application must not add a second reply');
});

test('pending underline takes a verified word on the next voice turn, and an expired circle cannot reuse a click',async t=>{
 const f=await fixture(t);
 await f.utter('ask-underline','你可以帮我给一个单词加下划线吗？');
 await f.utter('ambiguous-underline','machine。');
 await f.utter('click-without-image','我点了。');
 const waiting=(await f.trace()).find(e=>e.data?.event==='teacher.mark.unresolved'&&e.data?.itemId==='click-without-image');
 assert.equal(waiting?.data?.shape,'underline');
 assert.equal(waiting?.label,'等待定位要划线的文字');
 assert.deepEqual(await f.marks(),[]);
 const visual=await f.stage({x:.4,y:.13});
 await f.utter('underline-click','我点了。');
 const [mark]=await f.marks();
 assert.equal((await f.marks()).length,1);
 assert.equal(mark.shape,'underline');
 assert.equal(mark.targetId,'title-machine');
 assert.equal(mark.itemId,'underline-click');
 assert.equal((await f.trace()).find(e=>e.data?.visualId===visual&&e.data?.state==='speech_ended')?.data?.itemId,mark.itemId);

 await f.utter('ask-late-circle','你可以帮我圈选一个单词吗？');
 f.advance(61_000);
 await f.stage({x:.4,y:.13});
 await f.utter('stale-click','我点了。');
 assert.equal((await f.marks()).length,1);

 await f.utter('ask-cancelled-circle','你可以帮我圈选一个单词吗？');
 await f.utter('cancel-circle','不用圈了。');
 await f.stage({x:.4,y:.13});
 await f.utter('cancelled-click','我点了。');
 assert.equal((await f.marks()).length,1);
 assert.equal(f.applicationReplies(),1);
});

test('HTML word IDs distinguish identical spelling across typed and completed voice marks without JPEG',async t=>{
 const f=await fixture(t),pointInTitle={x:.4,y:.13};
 const word=await f.stage(pointInTitle,'passage-machine',false);
 await waitFor('server should confirm the text ID independently of the crop',async()=>(await f.trace()).some(event=>event.data?.event==='text.point.accepted'&&event.data?.visualId===word&&event.data?.textId==='passage-machine'));
 f.speak('highlight-passage');f.stop('highlight-passage');
 await waitFor('voice turn has stopped before the next click',async()=>(await f.trace()).some(event=>event.data?.event==='input_audio_buffer.speech_stopped'));
 await f.stage(pointInTitle,'title-machine',false);
 f.final('highlight-passage','Highlight this word.');f.reply();
 await waitFor('late native final should honor the previous semantic word',async()=>(await f.marks()).length===1);
 f.text('Underline this word.');
 await waitFor('typed command should honor the latest semantic word',async()=>(await f.marks()).length===2);
 const [highlight,underline]=await f.marks();
 assert.equal(highlight.shape,'highlight');assert.equal(highlight.targetId,'passage-machine');
 assert.equal(underline.shape,'underline');assert.equal(underline.targetId,'title-machine');
 assert.notEqual(highlight.actionId,underline.actionId);
 assert.equal(f.applicationReplies(),2,'an existing voice response and typed response should not be duplicated by marking');
});

test('an expired HTML selection or a new plain region cannot become a later text target',async t=>{
 const f=await fixture(t);
 const old=await f.stage({x:.4,y:.69},'passage-machine');
 f.advance(30001);
 await f.utter('expired-word','Underline this word.');
 assert.deepEqual(await f.marks(),[]);
 assert.equal((await f.trace()).find(e=>e.data?.visualId===old&&e.data?.state==='speech_ended')?.data?.textId,'passage-machine');
 await f.stage({x:.4,y:.69},'passage-machine',false);
 await f.stage({x:.88,y:.91},undefined,false);
 await f.utter('new-region','Highlight this word.');
 assert.deepEqual(await f.marks(),[]);
});

test('the reported spoken underline identifies the first passage line from its quoted opening',async t=>{
 const f=await fixture(t);
 await f.utter('first-line','你可以给我看到的“look closely”那第一行画一条横线吗？下划线吗？');
 const marks=await f.marks();
 assert.equal(marks.length,1);
 assert.equal(marks[0].shape,'underline');
 assert.equal(marks[0].targetId,'passage-first');
 assert.equal(marks[0].itemId,'first-line');
 assertBox(marks[0]);
 assert.equal(f.applicationReplies(),1);
});

test('a spoken request to recolor Look offers a highlight, which is applied once only after agreement',async t=>{
 const f=await fixture(t);
 await f.utter('red-look','你能将look这个单词改成红色吗？');
 const offered=(await f.trace()).find(event=>event.data?.event==='teacher.mark.unresolved'&&event.data?.itemId==='red-look');
 assert.equal(offered?.data?.reason,'unsupported_style');
 assert.equal(offered?.label,'更改字色不可用，可确认改为高亮');
 assert.equal(offered?.data?.alternativeTargetId,'passage-first-word-1');
 assert.deepEqual(await f.marks(),[]);
 f.advance(8670);
 await f.utter('accept-look','那你标出来吧。');
 const marks=await f.marks();
 assert.equal(marks.length,1);
 assert.equal(marks[0].shape,'highlight');
 assert.equal(marks[0].targetId,'passage-first-word-1');
 assert.equal(marks[0].itemId,'accept-look');
 assertBox(marks[0]);
 f.advance(12800);
 await f.utter('repeat-agreement','那你标出来吧。');
 assert.equal((await f.marks()).length,1);
 assert.equal(f.applicationReplies(),1);
});

test('the reported targetless circle waits for the HTML do click and applies only on its next spoken instruction',async t=>{
 const f=await fixture(t);
 await f.utter('circle-without-target','你能给我画个圆圈吗？');
 const waiting=(await f.trace()).find(event=>event.data?.event==='teacher.mark.unresolved'&&event.data?.itemId==='circle-without-target');
 assert.equal(waiting?.data?.shape,'circle');
 assert.deepEqual(await f.marks(),[]);
 f.advance(9260);
 const visual=await f.stage({x:.57,y:.84},'passage-third-word-4');
 assert.deepEqual(await f.marks(),[]);
 f.advance(13930);
 await f.utter('circle-do','就这里了。');
 const marks=await f.marks();
 assert.equal(marks.length,1);
 assert.equal(marks[0].shape,'circle');
 assert.equal(marks[0].targetId,'passage-third-word-4');
 assert.equal(marks[0].itemId,'circle-do');
 assertBox(marks[0]);
 const trace=await f.trace();
 assert(trace.some(event=>event.data?.event==='text.point.accepted'&&event.data?.visualId===visual&&event.data?.targetText==='do'));
 assert.equal(trace.find(event=>event.data?.visualId===visual&&event.data?.state==='speech_ended')?.data?.itemId,'circle-do');
 assert.equal(f.applicationReplies(),1);
 assert(!f.received.some(event=>event.type==='error'));
});
