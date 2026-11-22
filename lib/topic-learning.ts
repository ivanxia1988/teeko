import {z} from 'zod';

export const topicCardSchema=z.object({
 id:z.enum(['topic-robot','topic-picnic']),title:z.string(),subtitle:z.string(),description:z.string(),
 category:z.enum(['science','life']),categoryLabel:z.string(),difficulty:z.enum(['starter','intermediate']),difficultyLabel:z.string(),
 durationMinutes:z.number().positive(),coverImage:z.string(),objectives:z.array(z.string()),words:z.array(z.string()),
 preview:z.object({image:z.string(),width:z.number().positive(),height:z.number().positive(),passage:z.string(),heading:z.string().optional()}),
 source:z.object({title:z.string(),url:z.string().url()}).nullable(),
});
export type TopicCard=z.infer<typeof topicCardSchema>;
export type TopicDefinition=TopicCard;
export const TOPIC_CATALOG:TopicCard[]=[
 {
  id:'topic-robot',title:'会飞又会游的机器人',subtitle:'A robot that can fly and swim',
  description:'从翅膀找到设计线索，读一句新闻，再聊聊你会给机器人安排什么任务。',
  category:'science',categoryLabel:'科技',difficulty:'intermediate',difficultyLabel:'进阶表达',durationMinutes:20,
  coverImage:'/course-assets/robot-reading-predict.svg',
  objectives:['看懂机器人在空中和水中的运动','用自己的话说出图文线索','提出一个机器人任务或问题'],
  words:['machine','wings','fly','swim','mission'],
  preview:{image:'/course-assets/robot-reading-predict.svg',width:900,height:720,heading:'An unusual machine',passage:'Look closely at this machine. Which parts give you clues about what it might do?'},
  source:{title:'Robot Inspired By Diving Birds Can Fly And Swim',url:'https://www.dogonews.com/2026/11/5/robot-inspired-by-diving-birds-can-fly-and-swim'},
 },
 {
  id:'topic-picnic',title:'一起准备一次野餐',subtitle:"Let's plan a picnic",
  description:'聊聊喜欢的水果，邀请 Teeko 一起野餐，再说说你想带什么。',
  category:'life',categoryLabel:'生活',difficulty:'starter',difficultyLabel:'基础开口',durationMinutes:15,
  coverImage:'/course-assets/picnic-v1.svg',objectives:['说出自己喜欢的水果','邀请朋友一起野餐','用短句介绍自己的野餐计划'],
  words:['apple','banana','strawberry','like','bring'],
  preview:{image:'/course-assets/picnic-v1.svg',width:900,height:720,heading:"Let's have a picnic!",passage:'I like apples. What would you bring to our picnic?'},source:null,
 },
];
const topicIds=new Set<string>(TOPIC_CATALOG.map(topic=>topic.id));
export const isTopicCourseId=(id:string):boolean=>topicIds.has(id);
export const getTopic=(id:string):TopicCard|undefined=>TOPIC_CATALOG.find(topic=>topic.id===id);
export const topicCatalogResponseSchema=z.object({ok:z.literal(true),topics:z.array(topicCardSchema)});
const cursorSchema=z.object({endedAt:z.string().datetime(),id:z.string().uuid()}).strict();
export type TopicHistoryCursor=z.infer<typeof cursorSchema>;
export function encodeTopicHistoryCursor(input:TopicHistoryCursor):string{
 return btoa(JSON.stringify(cursorSchema.parse(input))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
}
export function decodeTopicHistoryCursor(value:string):TopicHistoryCursor|null{
 try{
  if(!/^[A-Za-z0-9_-]{1,512}$/.test(value))return null;
  const base64=value.replaceAll('-','+').replaceAll('_','/');
  const parsed=cursorSchema.safeParse(JSON.parse(atob(base64.padEnd(Math.ceil(base64.length/4)*4,'='))));
  return parsed.success&&encodeTopicHistoryCursor(parsed.data)===value?parsed.data:null;
 }catch{return null;}
}
const historyQuerySchema=z.object({pageSize:z.coerce.number().int().min(1).max(20).default(6),cursor:z.string().max(512).optional()}).strict();
export function parseTopicHistoryQuery(input:unknown):{ok:true;query:{pageSize:number;cursor:TopicHistoryCursor|null}}|{ok:false}{
 const parsed=historyQuerySchema.safeParse(input);if(!parsed.success)return{ok:false};
 const cursor=parsed.data.cursor===undefined?null:decodeTopicHistoryCursor(parsed.data.cursor);
 if(parsed.data.cursor!==undefined&&!cursor)return{ok:false};
 return{ok:true,query:{pageSize:parsed.data.pageSize,cursor}};
}
export const topicHistoryRecordSchema=z.object({
 id:z.string().uuid(),courseId:topicCardSchema.shape.id,courseTitle:z.string(),startedAt:z.string().datetime(),endedAt:z.string().datetime(),
 endReason:z.enum(['manual','content_completed','time_limit','daily_limit']),elapsedSeconds:z.number().nonnegative(),
 adviceStatus:z.enum(['pending','ready','unavailable']),noteCount:z.number().int().nonnegative(),
});
export const topicHistoryResponseSchema=z.object({
 ok:z.literal(true),records:z.array(topicHistoryRecordSchema).max(20),
 nextCursor:z.string().refine(value=>decodeTopicHistoryCursor(value)!==null).nullable(),
 activeClassroom:z.object({id:z.string().uuid(),courseId:z.string(),status:z.enum(['preflight','active','paused']),provider:z.enum(['qwen','openai','grok'])}).nullable(),
});
export type TopicHistoryResponse=z.infer<typeof topicHistoryResponseSchema>;
export type TopicHistoryRecord=z.infer<typeof topicHistoryRecordSchema>;
