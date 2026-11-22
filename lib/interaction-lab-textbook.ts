export const LAB_ILLUSTRATION='/course-assets/robot-reading-predict-illustration.svg';
export const LAB_READ_ILLUSTRATION='/course-assets/robot-reading-read-illustration.svg';

type TextBlock={
 id:string;
 kind:'header'|'title'|'passage'|'footer';
 parts:readonly {text:string;id?:string}[];
};
type TextTarget={id:string;text:string;blockId:string};
function block(id:string,kind:TextBlock['kind'],text:string,words:Record<string,string>={}):TextBlock{
 let index=0;
 return {id,kind,parts:text.split(/([a-z]+[a-z’'-]*)/i).filter(Boolean).map(part=>
  /^[a-z]/i.test(part)?{text:part,id:words[part.toLowerCase()]??id+'-word-'+(++index)}:{text:part})};
}

export const LAB_TEXTBOOK:readonly TextBlock[]=[
 block('header','header','TEEKO / ROBOT READING'),
 block('title','title','An unusual machine',{unusual:'title-unusual',machine:'title-machine'}),
 block('passage-first','passage','Look closely at this machine.',{machine:'passage-machine'}),
 block('passage-second','passage','Which parts give you clues about',{clues:'passage-clues'}),
 block('passage-third','passage','what it might do?'),
 block('footer','footer','TEEKO original diagram and activity'),
];
const readingTextbook:readonly TextBlock[]=[
 block('read-header','header','TEEKO / ROBOT READING'),
 block('read-title','title','One sentence, one discovery'),
 block('read-passage','passage','Notice the wings as the robot makes its transition from flying to swimming.',{
  wings:'read-wings',transition:'read-transition',flying:'read-flying',swimming:'read-swimming',
 }),
 block('read-footer','footer','DOGOnews source / TEEKO original lesson and diagram'),
];
const textTargets=(blocks:readonly TextBlock[]):TextTarget[]=>blocks.flatMap(({id,parts})=>[
 {id,text:parts.map(part=>part.text).join(''),blockId:id},
 ...parts.flatMap(part=>part.id?[{id:part.id,text:part.text,blockId:id}]:[]),
]);
export const LAB_TEXT_TARGETS:readonly TextTarget[]=textTargets(LAB_TEXTBOOK);
const readingTargets=textTargets(readingTextbook);
const targets=new Map([...LAB_TEXT_TARGETS,...readingTargets].map(target=>[target.id,target]));
export function labTextbook(pageId:string):readonly TextBlock[]{
 if(pageId==='robot-predict')return LAB_TEXTBOOK;
 return pageId==='robot-read'?readingTextbook:[];
}
export function labTextTarget(id:unknown,pageId?:string):TextTarget|null{
 if(pageId!==undefined){
  const pageTargets=pageId==='robot-predict'?LAB_TEXT_TARGETS:pageId==='robot-read'?readingTargets:[];
  return pageTargets.find(target=>target.id===id)??null;
 }
 return typeof id==='string'?targets.get(id)??null:null;
}
