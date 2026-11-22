import assert from 'node:assert/strict';
import test from 'node:test';
import {InteractionLabMarkRequest,isCompleteUnlocatedLabMark,labTeacherMark,requestedLabMark} from '../lib/interaction-lab-mark';
import type {LabEventInput} from '../lib/interaction-lab';

test('a bilingual line reference and repeated underline request target the whole first line',()=>{
 const request=new InteractionLabMarkRequest();
 const result=request.accept('你可以给我看到的“look closely”那第一行画一条横线吗？下划线吗？',undefined,11930,'speech');
 assert(result?.state==='applied');
 assert.equal(result.mark.shape,'underline');assert.equal(result.mark.targetId,'passage-first');
 assert.notEqual(request.accept('给“Which parts”那第一行画一条横线',undefined,12200,'speech')?.state,'applied');
});

test('font-color request needs an explicit confirmation before offering the fixed named word highlight',()=>{
 const request=new InteractionLabMarkRequest();
 const fallback=request.accept('你能将look这个单词改成红色吗？',undefined,29480,'speech');
 assert(fallback?.state==='clarify');assert.equal(fallback.reason,'unsupported_style');
 assert.equal(request.accept('好的',undefined,31000,'speech'),null);
 const result=request.accept('那你标出来吧。',undefined,38150,'speech','passage-clues');
 assert(result?.state==='applied');
 assert.equal(result.mark.shape,'highlight');assert.equal(result.mark.targetId,'passage-first-word-1');
 assert.equal(request.accept('那你标出来吧',undefined,38200,'speech'),null);
});

test('a targetless circle waits for a fresh authorized point and confirms shortly afterward',()=>{
 const request=new InteractionLabMarkRequest(),stale='passage-machine',fresh='passage-third-word-4';
 assert.equal(request.accept('你能给我画个圆圈吗？',undefined,65560,'speech',stale,60000)?.state,'clarify');
 assert.equal(request.accept('就这里了。',undefined,70000,'speech',stale,60000)?.state,'clarify');
 const result=request.accept('就这里了。',undefined,88750,'speech',fresh,74820);
 assert(result?.state==='applied');
 assert.equal(result.mark.shape,'circle');assert.equal(result.mark.targetId,fresh);
 assert.equal(request.accept('就这里了。',undefined,89200,'speech',fresh,74820),null);
});

test('explicit Mandarin and English commands resolve to the exact textbook text span',()=>{
 const title=requestedLabMark('能不能帮我把上面的标题圈起来？');
 assert.equal(title?.shape,'circle');assert.equal(title?.targetId,'title');
 const unusual=requestedLabMark('请给 unusual 划一道下划线。');
 assert.equal(unusual?.shape,'underline');assert.equal(unusual?.targetId,'title-unusual');
 assert(title&&unusual&&unusual.box.x>title.box.x&&unusual.box.w<title.box.w);
 assert.equal(requestedLabMark('Could you underline “Look closely at this machine” for me?')?.targetId,'passage-first');
 assert.equal(requestedLabMark('在第一句话下面划条线')?.shape,'underline');
 assert.equal(requestedLabMark('给标题加上下划线')?.targetId,'title');
 assert.equal(requestedLabMark('给我上上面画个圈')?.targetId,'page-top');
});

test('an explicit request to circle the screen center stays within the textbook',()=>{
 const expected={shape:'circle',targetId:'page-center',box:{x:390/900,y:310/720,w:120/900,h:100/720}};
 for(const text of [
  '请你给我在屏幕中间画个圈。',
  '在教材正中央圈一下',
  'Draw a circle in the middle of the page.',
 ])assert.deepEqual(requestedLabMark(text,{x:.72,y:.55}),expected,text);
 assert.deepEqual(new InteractionLabMarkRequest().accept('请你给我在屏幕中间画个圈。',undefined,10_630,'speech'),{state:'applied',mark:expected});
 assert.equal(requestedLabMark('请别在屏幕中间画个圈'),null);
 assert.equal(requestedLabMark('给屏幕中间加下划线'),null);
 assert.equal(requestedLabMark('在中间'),null);
});

test('a verified click precisely locates a circle or a printed span to underline',()=>{
 const region=requestedLabMark('给我在我点的地方画个圈',{x:.72,y:.55});
 assert.equal(region?.targetId,'clicked-region');assert(region&&region.box.x<.72&&region.box.x+region.box.w>.72);
 assert.equal(requestedLabMark('在这里画一个圈。',{x:.99,y:.99})?.targetId,'clicked-region');
 assert.equal(requestedLabMark('underline here',{x:.2,y:.13})?.targetId,'title-unusual');
 assert.equal(requestedLabMark('给这儿划下划线',{x:.98,y:.55}),null);
 assert.equal(requestedLabMark('圈一下这里',{x:NaN,y:.4}),null);
});

test('vague, negated and descriptive phrases cannot cause a mark',()=>{
 for(const words of ['不要把标题圈起来','我已经把标题圈起来了','The teacher circled the title','underline the picture','圈一下旁边','circle here','circle the wings','underline the title and the first sentence']){
  assert.equal(requestedLabMark(words),null,words);
 }
 assert.equal(isCompleteUnlocatedLabMark('把我刚刚点的地方圈起来'),true);
 assert.equal(isCompleteUnlocatedLabMark('给它划一下下划线'),true);
 assert.equal(isCompleteUnlocatedLabMark('不要给它划一下下划线'),false);
});

test('replays the ambiguous machine word and exact confirmed click from the Chrome trace',()=>{
 const request=new InteractionLabMarkRequest(),point={x:.424,y:.695};
 for(const [at,text,state] of [
  [11290,'你可以帮我圈选一个单词吗？','clarify'],
  [19660,'我想全选machine。','clarify'],
  [29610,'实现。',null],
  [41260,'全选machine。','clarify'],
  [46880,'在中间。',null],
 ] as const)assert.equal(request.accept(text,undefined,at,'speech')?.state??null,state,text);
 assert.equal(request.accept('我点了。',undefined,53250,'speech')?.state,'clarify');
 const accepted=request.accept('我点了。',point,53850,'speech');
 assert.equal(accepted?.state,'applied');
 assert(accepted?.state==='applied');
 assert.equal(accepted.mark.shape,'circle');assert.equal(accepted.mark.targetId,'passage-machine');
 assert.equal(request.accept('我点了。',point,54500,'speech'),null);
});

test('underline continuation honors named words, source and exact span',()=>{
 const request=new InteractionLabMarkRequest(),word={x:.424,y:.695};
 assert.equal(request.accept('请帮我给一个单词加下划线。',undefined,0,'speech')?.state,'clarify');
 assert.equal(request.accept('是 machine。',undefined,900,'speech')?.state,'clarify');
 assert.equal(request.accept('我点了',word,1500,'typed'),null);
 assert.equal(request.accept('我点了',{x:.03,y:.49},1800,'speech')?.state,'clarify');
 const accepted=request.accept('我点了',word,2500,'speech');
 assert(accepted?.state==='applied'&&accepted.mark.shape==='underline'&&accepted.mark.targetId==='passage-machine');
 assert.equal(requestedLabMark('Please circle machine'),null);
 assert.equal(requestedLabMark('Please underline machine in the title')?.targetId,'title-machine');
});

test('spoken underline uses the unique corrected word instead of the previous click',()=>{
 const request=new InteractionLabMarkRequest();
 for(const phrase of ['Can you underline closer closely for me?','Could you underline closely, closely?']){
  const result=request.accept(phrase,undefined,23_020,'speech','passage-clues');
  assert(result?.state==='applied',phrase);
  assert.equal(result.mark.shape,'underline');
  assert.equal(result.mark.targetId,'passage-first-word-2');
 }
});

test('uncertain explicit underline asks for a target and cannot mark a later click',()=>{
 const request=new InteractionLabMarkRequest();
 for(const [phrase,source] of [
  ['Can you underline closer closely for me?','typed'],
  ['Can you underline Look closely for me?','speech'],
  ['Can you underline quicker closely for me?','speech'],
  ['Can you underline closer closely and clues for me?','speech'],
  ['Can you underline machinery machine for me?','speech'],
 ] as const){
  assert.deepEqual(request.accept(phrase,undefined,23_020,source,'passage-clues'),{
   state:'clarify',shape:'underline',reason:'target_unresolved',
  },phrase);
  assert.equal(request.accept('I clicked it',undefined,23_120,'speech','passage-clues'),null);
 }
});

test('the verified HTML word resolves both markup actions without pixel coordinates',()=>{
 const request=new InteractionLabMarkRequest();
 const high=request.accept('请高亮我刚点的这个词',undefined,200,'speech','passage-machine');
 assert(high?.state==='applied');
 assert.equal(high.mark.shape,'highlight');assert.equal(high.mark.targetId,'passage-machine');
 const underline=request.accept('Underline machine.',undefined,500,'typed','passage-machine');
 assert(underline?.state==='applied');
 assert.equal(underline.mark.shape,'underline');assert.equal(underline.mark.targetId,'passage-machine');
 const explicit=request.accept('Please highlight machine in the title.',undefined,800,'typed','passage-machine');
 assert(explicit?.state==='applied');assert.equal(explicit.mark.targetId,'title-machine');
 assert.equal(request.accept('Highlight this word.',undefined,900,'speech','unregistered')?.state,'clarify');
 assert.equal(request.accept('不用高亮了',undefined,1000,'speech'),null);
 assert.equal(request.accept('我点了。',undefined,1100,'speech','passage-machine'),null);
});

test('the follow-up requires live explicit intent and ignores cancellation or stale state',()=>{
 const request=new InteractionLabMarkRequest(),point={x:.424,y:.695};
 assert.equal(request.accept('我想全选machine。',point,0,'speech'),null);
 assert.equal(request.accept('你可以帮我圈选一个单词吗？',undefined,1000,'speech')?.state,'clarify');
 assert.equal(request.accept('全选unusual',undefined,2000,'typed'),null);
 assert.equal(request.accept('不用圈了',undefined,3000,'speech'),null);
 assert.equal(request.accept('我点了',point,3500,'speech'),null);
 request.accept('帮我圈选一个单词',undefined,5000,'speech');
 assert.equal(request.accept('我点了',point,31000,'speech'),null);
});

test('a valid server action decodes geometry while a forged or out-of-page record does not',()=>{
 const actionId='1b15b1f1-c393-4dc5-aa2c-59fa82cb2a45';
 const data={event:'teacher.mark',actionId,pageId:'robot-predict',shape:'circle',targetId:'title',x:.05,y:.09,w:.4,h:.07};
 const event:LabEventInput={layer:'server',kind:'tool',label:'后台已确认教材标注',data};
 assert.deepEqual(labTeacherMark(event),{actionId,pageId:'robot-predict',shape:'circle',targetId:'title',box:{x:.05,y:.09,w:.4,h:.07}});
 assert.equal(labTeacherMark({...event,layer:'browser'}),null);
 assert.equal(labTeacherMark({...event,data:{...data,actionId:'invalid'}}),null);
 assert.equal(labTeacherMark({...event,data:{...data,w:1}}),null);
 assert.equal(labTeacherMark({...event,data:{...data,h:0}}),null);
});
