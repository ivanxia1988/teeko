import type { LessonStep } from '../types';
import {isReadingStep} from '../classroom-reading';

export const normalizeClassroomSpeech=(text:string)=>text.toLowerCase().replace(/[^a-z\u4e00-\u9fff ]/g,' ').replace(/\s+/g,' ').trim();

/** Controls require a complete request; words inside a story cannot move a task. */
export function classroomControl(text:string):'skip'|'pause'|null{
 const input=normalizeClassroomSpeech(text);
 if(/^(?:(?:please|can we|let s) )?(?:stop|pause)(?: please)?$|^(?:暂停|停一下|停止)$/.test(input))return 'pause';
 if(/^(?:please )?(?:skip|next)(?: this| one| question| please)?$|^(?:can we|let s) skip(?: this)?$|^(?:跳过|换一题|不想重复了)$/.test(input))return 'skip';
 return null;
}
/** Reading navigation is opt-in per activity; the existing picture-course controls stay unchanged. */
export function readingNavigation(text:string):'next'|'skip'|null{
 const input=normalizeClassroomSpeech(text);
 if(/^(?:please )?next(?: one| question| page| paragraph| part| section)?(?: please)?$/.test(input)||/^(?:(?:let s|can we|could we) )?(?:read|go to|move to|continue to|continue with) (?:the )?next (?:page|paragraph|part|section)(?: please)?$/.test(input)||/^(?:(?:let s|can we) )?(?:continue reading|read on)(?: please)?$/.test(input)||/^(?:请)?(?:下一段|下一页|下一个|继续读|继续阅读|读下一段|读下一页)(?:吧|好吗|可以吗)?$/.test(input))return 'next';
 return classroomControl(text)==='skip'?'skip':null;
}
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const plural=(word:string)=>word.endsWith('y')?`${escape(word.slice(0,-1))}(?:y|ies)`:`${escape(word)}s?`;

/** These explicit requests need a response, not an automatic reading-task completion. */
export function isReadingSupportRequest(text:string):boolean{
 const input=normalizeClassroomSpeech(text);
 if(/[?？]\s*$/.test(text)||/^(?:(?:can|could|would|will|do|does|did|is|are|was|were|have|has|should|may|might) (?:i|you|he|she|it|we|they|this|that|there|the|a|an)\b|(?:what|why|how|where|when|who|which)\b)/.test(input))return true;
 if(/^(?:i (?:don t|do not|won t|will not|can t|cannot) (?:want to )?(?:read|repeat|say|speak|try)|i (?:don t|do not) (?:know|understand)(?: it|this|that|yet)?$)/.test(input))return true;
 if(/^(?:(?:please )?(?:you (?:read|say)|read (?:it|this)|say (?:it|this))|(?:please )?(?:help(?: me)?|give me (?:a hint|more time)|wait)(?: please)?$|i need (?:help|a hint|more time)$|(?:this|it) is too (?:hard|difficult)$|too (?:hard|difficult)$|a hint(?: please)?$)/.test(input))return true;
 return /^(?:我不想(?:读|念|说|重复)|我(?:不会|没听懂|不懂|不知道)|(?:请)?你(?:来)?读|(?:请)?帮我(?:读|念)|(?:请)?给我(?:一个)?提示|等等|等一下)/.test(input);
}

/** Conservative task evidence, separate from the tutor's unrestricted conversation. */
export function spokenTaskAttempt(step:LessonStep,text:string,words:string[]):'correct'|'retry'|'conversation'{
 if(isReadingStep(step))return 'conversation';
 if(step.kind!=='speak'||!step.expected)return 'conversation';
 const input=normalizeClassroomSpeech(text),alternatives=step.expected.split('|').map(normalizeClassroomSpeech);
 if(!input)return 'conversation';
 const negative=/\b(not|no|never|don t|doesn t|can t|cannot|won t|skip|help|wait|stop|maybe|or)\b|不|没|别|跳过|不会|等等/.test(input);
 if(step.id==='invite-friend'){
  const invitation=/^(?:(?:let s|let us|shall we) (?:have|go on|go for) (?:a|our) picnic|(?:would you like|do you want) to (?:have|go on|go for|join|join us for) (?:a|our|the|my) picnic|come to (?:my|our|the) picnic)(?: (?:in|at|by) (?:the |a |our |my )?[a-z]+(?: [a-z]+){0,3})?$/;
  const polite=input.replace(/^please /,'').replace(/ please$/,'');
  if(!negative&&(alternatives.includes(polite)||invitation.test(polite)))return 'correct';
  return input==='picnic'||/^(?:let s|let us|shall we)\b.*\bpicnic$/.test(input)?'retry':'conversation';
 }
 if(/^(?:can|could|would|will|do|does|did|is|are|what|why|how|where|when|who)\b/.test(input))return 'conversation';
 const fruitPattern=words.map(plural).join('|');
 const fruitCount=words.filter(word=>new RegExp(`\\b${plural(word)}\\b`).test(input)).length;
 const fruit=`(?:an? |the )?(?:(?:red|yellow|green|sweet) )?(?:${fruitPattern})`;
 const naming=new RegExp(`^(?:(?:it is|it s|this is|that is|i found|i see|i can see) )?${fruit}$`);
 const choice=new RegExp(`^(?:i (?:like|love|want|choose|would take|will take)|my (?:favorite|favourite) fruit is) ${fruit}(?: because [a-z ]{1,80})?$`);
 const packing=new RegExp(`^i (?:will bring|ll bring|would bring|d bring|will pack|ll pack|want to bring|am bringing) ${fruit}(?: (?:to|for) (?:our |the |a )?picnic)?$`);
 let answer=false;
 if(step.id==='pack-picnic')answer=packing.test(input)&&fruitCount===1;
 else if(step.id==='my-choice'&&step.expected==='apple|banana|strawberry')answer=choice.test(input)&&fruitCount===1;
 else {
  const target=alternatives.some(word=>new RegExp(`\\b${plural(word)}\\b`).test(input));
  answer=target&&fruitCount===1&&(naming.test(input)||choice.test(input));
 }
 if(answer&&!negative)return 'correct';
 const attempted=fruitCount>0&&(naming.test(input)||choice.test(input)||packing.test(input)||input.split(' ').length<=2||(fruitCount>1&&input.split(' ').length<=5)||/^(?:not|no|maybe|it is|it s|this is|that is|i like|i love|i will bring|i want to bring)\b/.test(input));
 return attempted?'retry':'conversation';
}
