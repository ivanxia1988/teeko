import type {PageObject} from './types';

type NamedObject=Pick<PageObject,'id'|'label'|'chinese'>;
const normalize=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[.,!?，。！？]/g,' ').replace(/\s+/g,' ').trim();
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Whole explicit requests only: a story or uncertain reference must not become a canvas action. */
export function requestedClassroomHighlights(text:string,objects:readonly NamedObject[]):string[]|null{
 if(!text||text.length>1000||!objects.length)return null;
 const names=new Map<string,Set<string>>();
 for(const object of objects)for(const label of [object.label,object.chinese]){
  const name=normalize(label);if(!name)continue;const ids=names.get(name)??new Set<string>();ids.add(object.id);names.set(name,ids);
 }
 const aliases=[...names.keys()].sort((a,b)=>b.length-a.length).map(escape).join('|');if(!aliases)return null;
 const target=`(?:(?:the|this|that|an?) )?(?:${aliases})`,list=`${target}(?: and ${target}){0,4}`,chineseList=`(?:${aliases})(?:(?:和|及|、)(?:${aliases})){0,4}`;
 const input=normalize(text);
 const english=new RegExp(`^(?:(?:please )?(?:can|could|would) you )?(?:please )?(?:circle|highlight|mark|(?:click|tap)(?: on)?|point to|select|show me|draw (?:a |the )?circle (?:around|on)) (${list})(?: for me)?(?: (?:on|in) the (?:textbook|picture|page))?(?: please)?$`).exec(input);
 const prefix='(?:请)?(?:你)?(?:能不能|可不可以|可以|能)?(?:帮我)?';
 const chinese=[
  `^${prefix}(?:圈出|圈一下|圈一圈|标出|标注|点|点击|点选|选|选中|选择|指|指向)(?:一下)?(${chineseList})(?:好吗|吗|吧)?$`,
  `^${prefix}(?:把)?(${chineseList})(?:圈出来|圈起来|圈一下|标出来|标注一下)(?:好吗|吗|吧)?$`,
  `^${prefix}在(${chineseList})上画(?:一个|个|一)?(?:圆圈|圈)(?:好吗|吗|吧)?$`,
 ].map(pattern=>new RegExp(pattern).exec(input)).find(Boolean);
 const matched=english?.[1]??chinese?.[1];if(!matched)return null;
 const parts=english?matched.split(' and ').map(value=>value.replace(/^(?:the|this|that|an?) /,'')):matched.split(/和|及|、/);
 const ids=new Set<string>();for(const part of parts){const options=names.get(part);if(!options||options.size!==1)return null;ids.add([...options][0]);}
 return ids.size?objects.filter(object=>ids.has(object.id)).map(object=>object.id):null;
}

const englishCue=/^(?:(?:um|uh|er) ){0,2}(?:(?:please )?(?:can|could|would) you (?:please )?|please )(?:circle|highlight|draw (?:a |the )?circle (?:around|on))$/;
const genericCircleCue=/^(?:please )?(?:draw|make) (?:me )?a circle(?: for me)?$/;
const chineseCue=/^(?:嗯\s*)?(?:请(?:你)?(?:帮我)?|(?:你)?(?:能不能|可不可以|能|可以)(?:帮我)?|帮我)(?:圈出|圈一下|圈一圈|标出|标注)(?:吗|吧)?$/;
const fragment=(text:string)=>normalize(text.replace(/…/g,' '));
/** Only unmistakable incomplete requests can carry an action across a speech boundary. */
export function isIncompleteClassroomHighlight(text:string):boolean{
 if(!text||text.length>120)return false;
 const cue=fragment(text);
 return englishCue.test(cue)||genericCircleCue.test(cue)||chineseCue.test(cue);
}
export function classroomHighlightTargetFragment(text:string,objects:readonly NamedObject[]):string[]|null{
 if(!text||text.length>120)return null;
 const target=fragment(text),english=target.replace(/^(?:the|this|that|an?) /,'').replace(/ (?:for me(?: please)?|please)$/,''),chinese=target.replace(/(?:好吗|吗|吧)$/,'');
 const ids=new Set(objects.filter(object=>english&&normalize(object.label)===english||chinese&&normalize(object.chinese)===chinese).map(object=>object.id));
 return ids.size===1?[...ids]:null;
}
export function requestedClassroomSplitHighlights(cue:string,text:string,objects:readonly NamedObject[]):string[]|null{
 return isIncompleteClassroomHighlight(cue)?classroomHighlightTargetFragment(text,objects):null;
}
export function isExplicitHighlightTargetFragment(text:string):boolean{
 return text.length<=120&&/^(?:(?:the|this|that|an?) )?\p{L}+(?: \p{L}+){0,4} (?:for me|please)$/u.test(fragment(text));
}
