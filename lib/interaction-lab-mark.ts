import type {LabEventInput} from './interaction-lab';
import type {BookPage,Point} from './types';
import {LAB_TEXT_TARGETS,labTextTarget,labTextbook} from './interaction-lab-textbook';

type Box=Point&{w:number;h:number};
type Mark={shape:'circle'|'underline'|'highlight';targetId:string;box:Box};
export type LabTeacherMark=Mark&{actionId:string;pageId:string;revision?:number};
type Command=Pick<Mark,'shape'>&{target:string;textOnly?:true};
type MarkRegion={id:string;box:Box;aliases:string[];picture?:true};
type MarkTargets={pageId:string;regions:readonly MarkRegion[];byName:ReadonlyMap<string,readonly MarkRegion[]>;structural?:ReadonlyMap<string,string>};
type MarkResolution={state:'applied';mark:Mark}|{state:'clarify';shape:Mark['shape'];reason:'target_unresolved'|'unsupported_style';alternativeTargetId?:string};
type PendingMark={request:Command;until:number;freshAfter?:number}|{alternative:Mark;until:number};
const FOLLOWUP_MS=25_000;

const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[.,!?，。！？“”‘’「」"]/g,' ').replace(/\s+/g,' ').trim();
const compact=(text:string)=>text.replace(/\s+/g,'');
const targetName=(text:string)=>compact(normalize(text).replace(/^(?:the )?(?:words? |text )/,'').replace(/^the /,'').replace(/^(?:单词|词语)\s*(?=[a-z])/,''));
const pixelBox=(x:number,y:number,w:number,h:number):Box=>({x:x/900,y:y/720,w:w/900,h:h/720});
const regions:MarkRegion[]=[
 {id:'title',box:pixelBox(54,73,391,32),aliases:['An unusual machine','title','title above','heading','标题','大标题','上面的标题','最上面的标题','上面的字','上面那行字']},
 {id:'title-phrase',box:pixelBox(118,73,327,32),aliases:['unusual machine']},
 {id:'title-unusual',box:pixelBox(118,73,153,32),aliases:['unusual']},
 {id:'title-machine',box:pixelBox(283,73,162,32),aliases:['machine','machine in the title','标题里的machine','标题中的machine']},
 {id:'passage-first',box:pixelBox(60,485,409,27),aliases:['Look closely at this machine','first sentence','first line of the passage','第一句话','第一句','段落第一行','下面的第一句']},
 {id:'passage-machine',box:pixelBox(339,485,121,27),aliases:['machine','machine in the first sentence','machine in the passage','正文里的machine','正文中的machine','第一句里的machine']},
 {id:'passage-second',box:pixelBox(60,529,470,29),aliases:['Which parts give you clues about','second line of the passage','段落第二行','第二行正文']},
 {id:'passage-clues',box:pixelBox(366,529,75,29),aliases:['clues']},
 {id:'passage-third',box:pixelBox(60,573,242,28),aliases:['what it might do','third line of the passage','段落第三行','第三行正文']},
 {id:'header',box:pixelBox(54,28,267,18),aliases:['Teeko / Robot Reading','section label','页眉','栏目名']},
 {id:'footer',box:pixelBox(54,675,272,19),aliases:['Teeko original diagram and activity','footer','页脚']},
];
function byAliases(elements:readonly MarkRegion[]){
 const names=new Map<string,MarkRegion[]>();
 for(const element of elements)for(const alias of element.aliases){
  const name=targetName(alias),same=names.get(name);
  if(same?.some(match=>match.id===element.id))continue;
  if(same)same.push(element);else names.set(name,[element]);
 }
 return names;
}
const byName=byAliases(regions);
for(const target of LAB_TEXT_TARGETS){
 const name=targetName(target.text),same=byName.get(name);
 if(same?.some(region=>region.id===target.id))continue;
 const block=regions.find(region=>region.id===target.blockId);
 if(!block)continue;
 const region={id:target.id,box:block.box,aliases:[target.text]};
 if(same)same.push(region);else byName.set(name,[region]);
}
const predictionTargets:MarkTargets={pageId:'robot-predict',regions,byName};
const illustrationAliases:Record<string,readonly string[]>={
 tail:['尾巴','机尾'],wings:['两翼','机翼'],body:['机体'],
};

function currentTargets(page:BookPage):MarkTargets{
 const first=page.id===predictionTargets.pageId;
 const base=first?[...regions]:[];
 const names=first?new Map([...byName].map(([key,value])=>[key,[...value]])):new Map<string,MarkRegion[]>();
 const pageTargets=labTextbook(page.id).flatMap(block=>{
  if(first)return [];
  // HTML targets use their actual DOM geometry for drawing. The event box is only a bounded fallback.
  const box={x:.06,y:block.kind==='title'?.09:.67,w:.88,h:.10};
  const aliases=block.kind==='title'?['title','heading','标题']:block.kind==='passage'?['first sentence','the passage','paragraph','正文','第一句','第一段']:[];
  const blockTarget={id:block.id,box,aliases:[block.parts.map(part=>part.text).join(''),...aliases]};
  return [blockTarget,...block.parts.flatMap(part=>part.id?[{id:part.id,box,aliases:[part.text,`${part.text} in the passage`,`正文里的${part.text}`]}]:[])];
 });
 const objects:MarkRegion[]=page.objects.map(({id,label,chinese,box})=>{
  const names=[chinese,...(illustrationAliases[id]??[])];
  const aliases=[label,`${label} in the picture`,`${label} in the diagram`,...names.flatMap(name=>[name,`图中的${name}`,`图里的${name}`,`图上的${name}`,`图片里的${name}`,`插画里的${name}`])];
  return {id,box,picture:true,aliases};
 });
 for(const [alias,matches] of byAliases([...pageTargets,...objects]))names.set(alias,[...(names.get(alias)??[]),...matches]);
 const structural=new Map<string,string>();
 if(first)structural.set('正文第一句','passage-first');
 if(page.id==='robot-read')for(const name of ['sentence','full sentence','whole sentence','reading passage','passage','paragraph','正文','整句','整句正文','正文第一句','整段','第一句','第一段'])structural.set(targetName(name),'read-passage');
 return {pageId:page.id,regions:[...base,...pageTargets,...objects],byName:names,structural};
}
const deictic=/^(?:here|this|that|thistext|thatpart|thisword|thatword|theclickedword|clickedword|wordi(?:just)?clicked|whereipointed|whereijustclicked|whereiclicked|这里|这儿|这边|这个|那个|它|这一块|这块|这段|这段文字|这行|这行字|这个词|这个单词|这几个字|我(?:刚刚|刚才|刚)?(?:点|点到|点击|点选)的(?:(?:位置|地方|区域|文字|词|单词|这个词|这个单词|这里))?)$/;
const unspecified=/^(?:aword|oneword|someword|somewords|一个(?:英语|英文)?(?:单词|词|字)|某个(?:单词|词)|一处|一些(?:词|文字))$/;
const clickConfirmed=/^(?:我(?:已经|刚刚|刚才|刚)?(?:点|点击|点选)(?:过|好)?了|我点的是这里|点了|点好了|就(?:是)?(?:这里|这儿|这个)(?:了|吧)?|i(?:just|already)?(?:clicked|tapped|pointed)(?:it|here|there)?|clicked)$/;
const fallbackConfirmed=/^(?:(?:那|好)?(?:你|请|帮我)*(?:标(?:一下|出来)|高亮(?:一下|它|这个词)?)(?:吧|就好)?|(?:then|please)?(?:highlight|mark)it(?:instead)?(?:please)?)$/;
const cancelled=/^(?:算了|取消(?:标注|圈选|下划线|高亮)?|cancel(?:that)?|nevermind|(?:不用|别|不要|不必).{0,50}(?:圈|下划线|标注|画|高亮|颜色)|(?:don'?t|stop)(?:circle|circling|underline|underlining|highlight|mark|marking).*)/;
const top=/^(?:atthetop|topofthepage|上面|最上面|上方|顶部|页面上方|页面顶部)$/;
const center=/^(?:(?:center|centre|middle)(?:of(?:the|this)(?:screen|page|picture|textbook))?|(?:这页|当前)?(?:屏幕|画面|页面|教材|课本|书页)?的?(?:正?中间|正?中心|正?中央))$/;
const within=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier=/^[a-z0-9-]{1,64}$/;
const chineseRequest=(input:string)=>compact(input).replace(/^(?:嗯|呃)?(?:老师)?(?:请)?(?:我想|我希望)?(?:你)?(?:能不能|可不可以|可以|能)?(?:帮我|给我)?/,'').replace(/(?:一下)?(?:好不好|好吗|可以吗|吗|吧)$/,'');
const lineNames=['first','second','third'] as const;

function chineseLineUnderline(input:string,targets:MarkTargets):Command|null{
 const match=/^(?:给|把|在)?(?:我?(?:看到|看见)的)?(?:([a-z]{3,64})(?:那|的|开头的))?(?:那|正文|段落)?第([一二三123])行(?:的)?(?:下方|下面|底下)?(?:划|画|加)(?:上|一条|一道|条|道)?(?:下划线|横线|线)(?:吗?下划线)?$/.exec(input);
 if(!match)return null;
 const index='一二三'.indexOf(match[2]),row=lineNames[index<0?Number(match[2])-1:index];
 const line=labTextTarget(targets.pageId==='robot-read'&&row==='first'?'read-passage':'passage-'+row,targets.pageId);
 // A quoted cue and a line number must agree before we apply a mark.
 const target=line&&(!match[1]||targetName(line.text).startsWith(match[1]))?targetName(line.text):'';
 return {shape:'underline',target};
}

function requestedTextColor(input:string):string|null{
 const target=/^(?:把|将|给)(.+?)(?:的字色|的颜色)?(?:改|变|调)成(?:红色|绿色|蓝色|黄色|紫色|橙色|黑色|白色)$/.exec(chineseRequest(input))?.[1];
 return target?targetName(target.replace(/(?:这个|那个)?(?:单词|词语|词|字)$/,'')):null;
}

function spokenUnderlineTarget(text:string,targets:MarkTargets):string{
 const {byName}=targets;
 const target=targetName(text);
 const pair=/^([a-z]+) ([a-z]+)$/.exec(text);
 if(!pair||byName.has(target))return target;
 const [,first,last]=pair;
 const matches=byName.get(last);
 const word=matches?.length===1?labTextTarget(matches[0].id,targets.pageId):null;
 if(!word||word.id===word.blockId)return target;
 if(first===last)return last;
 // Treat a near-match only as a restart of this word, never as another valid target.
 const shared=Math.max(4,first.length-2,last.length-2);
 return !byName.has(first)&&first.slice(0,shared)===last.slice(0,shared)?last:target;
}

function command(text:string,source?:'speech'|'typed',targets=predictionTargets):Command|null{
 if(!text||text.length>280)return null;
 const input=normalize(text);
 const suffix=targets===predictionTargets?/(?: please| for me| (?:on|in) the (?:picture|textbook|page))+$/:/(?: please| for me| (?:on|in) the (?:textbook|page))+$/;
 const en=input.replace(/^(?:(?:please|(?:can|could|would) you) )+/,'').replace(suffix,'');
 const named=(shape:Mark['shape'],target:string):Command=>({shape,target:targetName(target),...(/^(?:(?:the )?words? |(?:单词|词语)\s*[a-z])/.test(target)?{textOnly:true}:{})});
 if(/^draw (?:me )?a circle$/.test(en))return{shape:'circle',target:''};
 const circle=/^(?:circle|draw (?:a |the )?circle (?:around|on|in|at)) (.+)$/.exec(en)?.[1];
 if(circle)return named('circle',circle);
 const highlight=/^(?:highlight|mark) (.+)$/.exec(en)?.[1];
 if(highlight)return named('highlight',highlight);
 const line=/^(?:underline|draw (?:a line|an underline) under) (.+)$/.exec(en)?.[1];
 if(line)return {...named('underline',line),target:source==='speech'?spokenUnderlineTarget(line,targets):targetName(line)};
 const zh=chineseRequest(input);
 if(/^画(?:一个|个|一)?(?:圆圈|圈)$/.test(zh))return{shape:'circle',target:''};
 const lineUnderline=chineseLineUnderline(zh,targets);
 if(lineUnderline)return lineUnderline;
 const bright=/^(?:高亮|标亮|突出显示)(?:一下)?(.+)$/.exec(zh)?.[1]??/^(?:把|将)(.+?)(?:高亮|标亮|突出显示)(?:一下)?$/.exec(zh)?.[1];
 if(bright)return named('highlight',bright);
 const under=/^(?:把|给|为)(.+?)(?:划|画|加)(?:上|一下|一条|一道|条|道)?下划线$/.exec(zh)?.[1]
  ??/^(?:在|给)(.+?)(?:的)?(?:下方|下面)(?:划|画|加)(?:一条|一道|条|道)?(?:横线|线|下划线)$/.exec(zh)?.[1]
  ??/^(?:给|在)(.+?)(?:的)?(?:下方|下面)?(?:划|画|加)(?:一条|一道|条|道)?下划线$/.exec(zh)?.[1]
  ??/^(?:给|把)(.+?)划线(?:一下)?$/.exec(zh)?.[1];
 if(under)return named('underline',under);
 const around=/^(?:把|给)(.+?)圈(?:选)?(?:一下|一圈|出来|起来)$/.exec(zh)?.[1]
  ??/^(?:给|在)(.+?)(?:上|周围)?画(?:一个|个|一)?(?:圆圈|圈)$/.exec(zh)?.[1]
  ??/^(上上面|上面|上方|顶部)画(?:一个|个|一)?(?:圆圈|圈)$/.exec(zh)?.[1]?.replace(/^上上面$/,'上面')
  ??/^(?:给|在)(.+?)(?:上(?:面)?)?圈(?:一下|一圈)$/.exec(zh)?.[1]
  ??/^(?:圈选(?:一下)?|圈出|圈一下|圈一圈|圈)(.+)$/.exec(zh)?.[1];
 return around?named('circle',around):null;
}

export function isCompleteUnlocatedLabMark(text:string):boolean{
 const request=command(text);
 return !!request&&(deictic.test(request.target)||unspecified.test(request.target)||(byName.get(request.target)?.length??0)>1);
}

export function requestedLabMark(text:string,point?:Point):Mark|null{
 const request=command(text);
 return request?resolveMark(request,point):null;
}

function resolveMark(request:Command,point?:Point,confirmingClick=false,selectedTextId?:string,targets=predictionTargets):Mark|null{
 const {shape,target}=request;
 const {regions,byName,pageId}=targets;
 const structuralId=!request.textOnly?targets.structural?.get(target):undefined;
 if(structuralId){
  const region=regions.find(region=>region.id===structuralId);
  if(region)return {shape,targetId:region.id,box:region.box};
 }
 const selected=labTextTarget(selectedTextId,pageId);
 if(selected&&(deictic.test(target)||target===targetName(selected.text)||confirmingClick&&unspecified.test(target))){
  const region=regions.find(region=>region.id===selected.id)??regions.find(region=>region.id===selected.blockId);
  if(region)return{shape,targetId:selected.id,box:region.box};
 }
 const named=byName.get(target)?.filter(region=>!(request.textOnly||shape==='underline')||!region.picture);
 const validPoint=point&&within(point.x)&&within(point.y)?point:undefined;
 const covers=({box}:{box:Box})=>validPoint&&validPoint.x>=box.x&&validPoint.x<=box.x+box.w&&validPoint.y>=box.y&&validPoint.y<=box.y+box.h;
 if(named){
  const region=named.length===1&&!confirmingClick?named[0]:named.find(covers);
  return region&&(shape!=='highlight'||region.picture||labTextTarget(region.id,pageId))?{shape,targetId:region.id,box:region.box}:null;
 }
 if(shape==='circle'&&top.test(target))return{shape,targetId:'page-top',box:pixelBox(28,12,440,107)};
 // Spatial commands are bounded to the interactive textbook surface.
 if(shape==='circle'&&center.test(target))return{shape,targetId:'page-center',box:pixelBox(390,310,120,100)};
 if(!validPoint||!deictic.test(target)&&!(confirmingClick&&unspecified.test(target)))return null;
 const matching=regions.filter(covers);
 const span=matching.reduce<(typeof regions)[number]|undefined>((small,region)=>!small||region.box.w<small.box.w?region:small,undefined);
 if(span&&(shape!=='highlight'||span.picture||labTextTarget(span.id,pageId)))return{shape,targetId:span.id,box:span.box};
 if(shape!=='circle')return null;
 const w=.16,h=.12;
 return{shape,targetId:'clicked-region',box:{x:Math.max(0,Math.min(1-w,validPoint.x-w/2)),y:Math.max(0,Math.min(1-h,validPoint.y-h/2)),w,h}};
}

/** One short-lived request per lab lease. A fresh voice-bound click resolves repeats like “machine”. */
export class InteractionLabMarkRequest{
 private pending:PendingMark|null=null;
 private targets=predictionTargets;

 setPage(page:BookPage){this.clear();this.targets=currentTargets(page);}

 clear(){this.pending=null;}
 accept(text:string,point:Point|undefined,now:number,source:'speech'|'typed',selectedTextId?:string,selectedTextAt?:number):MarkResolution|null{
  if(this.pending&&now>=this.pending.until)this.clear();
  if(!text||text.length>280)return null;
  const normalized=normalize(text),input=compact(normalized);
  if(cancelled.test(input)){this.clear();return null;}
  const styleTarget=requestedTextColor(normalized);
  if(styleTarget){
   this.clear();
   const alternative=resolveMark({shape:'highlight',target:styleTarget,textOnly:true},undefined,false,selectedTextId,this.targets);
   if(alternative)this.pending={alternative,until:now+FOLLOWUP_MS};
   return {state:'clarify',shape:'highlight',reason:'unsupported_style',...(alternative?{alternativeTargetId:alternative.targetId}:{})};
  }
  const explicit=command(text,source,this.targets);
  if(explicit){
   this.clear();
   if(explicit.shape==='circle'&&!explicit.target)return this.clarify({...explicit,target:'here'},now,now);
   const mark=resolveMark(explicit,point,false,selectedTextId,this.targets);
   if(mark)return {state:'applied',mark};
   if(deictic.test(explicit.target)||unspecified.test(explicit.target)||this.targets.byName.has(explicit.target))return this.clarify(explicit,now);
   return {state:'clarify',shape:explicit.shape,reason:'target_unresolved'};
  }
  const pending=this.pending;
  if(!pending)return null;
  if('alternative' in pending){
   if(!fallbackConfirmed.test(input))return null;
   this.clear();
   return {state:'applied',mark:pending.alternative};
  }
  if(source==='speech'&&clickConfirmed.test(input)){
   const freshText=pending.freshAfter===undefined||selectedTextAt!==undefined&&selectedTextAt>pending.freshAfter?selectedTextId:undefined;
   const mark=point||freshText?resolveMark(pending.request,point,true,freshText,this.targets):null;
   if(!mark)return {state:'clarify',shape:pending.request.shape,reason:'target_unresolved'};
   this.clear();
   return {state:'applied',mark};
  }
  // ASR has heard “圈选” as “全选”. Accept that spelling only inside an active circle request.
  const repaired=source==='speech'&&pending.request.shape==='circle'?/^(?:我想|请|帮我)?全选(.+)$/.exec(input)?.[1]:undefined;
  const target=targetName(repaired??text.replace(/^(?:是|就(?:是)?|the word )/i,''));
  if(!this.targets.byName.has(target))return null;
  const named:Command={...pending.request,target};
  const mark=resolveMark(named,point,false,selectedTextId,this.targets);
  if(!mark)return this.clarify(named,now);
  this.clear();
  return {state:'applied',mark};
 }

 private clarify(request:Command,now:number,freshAfter?:number):MarkResolution{
  this.pending={request,until:now+FOLLOWUP_MS,...(freshAfter===undefined?{}:{freshAfter})};
  return {state:'clarify',shape:request.shape,reason:'target_unresolved'};
 }
}

export function labTeacherMark(event:LabEventInput):LabTeacherMark|null{
 const data=event.data;
 if(event.layer!=='server'||event.kind!=='tool'||data?.event!=='teacher.mark')return null;
 const {actionId,pageId,shape,targetId,x,y,w,h,revision}=data;
 if(typeof actionId!=='string'||!uuid.test(actionId)||typeof pageId!=='string'||!identifier.test(pageId)||typeof targetId!=='string'||!identifier.test(targetId)||shape!=='circle'&&shape!=='underline'&&shape!=='highlight')return null;
 if(revision!==undefined&&(typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<1))return null;
 if(shape==='highlight'&&revision===undefined&&!labTextTarget(targetId,pageId))return null;
 if(!within(x)||!within(y)||!within(w)||!within(h)||w===0||h===0||x+w>1||y+h>1)return null;
 return{actionId,pageId,shape,targetId,box:{x,y,w,h},...(typeof revision==='number'?{revision}:{})};
}
