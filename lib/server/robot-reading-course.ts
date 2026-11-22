import type {PublishedCourse} from '../classroom-contract';
import type {LessonStep} from '../types';

const passages={
 predict:'Look closely at this machine. Which parts give you clues about what it might do?',
 read:'Notice the wings as the robot makes its transition from flying to swimming.',
 design:'A flexible material can bend. Imagine moving your hand through air and water. What might change?',
 mission:'Choose a mission for your robot. What would you add, and what would you test?',
 retell:'Tell a friend what the robot can do. Share one design idea or one question of your own.',
};
const reference=(phase:NonNullable<LessonStep['reading']>['phase'],passage:string,goal:string,teacherNotes:string,followUp:string):NonNullable<LessonStep['reading']>=>({phase,passage,goal,teacherNotes,followUp});

/** Original teaching copy, diagrams and activities, with a linked news source. */
export const ROBOT_READING_COURSE:PublishedCourse={
 id:'robot-reading',version:'1',title:'会飞又会游的机器人',subtitle:'A robot that flies and swims',
 description:'读一句改写的英语教材，找找翅膀的设计线索，再提出自己的机器人任务。',durationMinutes:20,sessionLimitSeconds:1200,
 words:['robot','wings','transition','flexible','mission'],objectives:['读懂机器人在空中和水中的运动','从图文中寻找设计线索','表达自己的机器人任务或问题'],
 reading:{sourceTitle:'Robot Inspired By Diving Birds Can Fly And Swim',sourceUrl:'https://www.dogonews.com/2026/11/5/robot-inspired-by-diving-birds-can-fly-and-swim',attribution:'Original Teeko teaching text, diagrams and activities. Inspired by DOGOnews reporting.'},
 pages:[
  {id:'robot-predict',image:'/course-assets/robot-reading-predict.svg',width:900,height:720,objects:[
   {id:'body',label:'body',chinese:'机身',box:{x:.42,y:.23,w:.16,h:.34}},
   {id:'wings',label:'wings',chinese:'翅膀',box:{x:.10,y:.22,w:.80,h:.25}},
   {id:'tail',label:'tail',chinese:'尾部',box:{x:.43,y:.50,w:.14,h:.10}},
  ]},
  {id:'robot-read',image:'/course-assets/robot-reading-read.svg',width:900,height:720,objects:[
   {id:'robot',label:'robot',chinese:'机器人',box:{x:.20,y:.20,w:.60,h:.37}},
   {id:'wings',label:'wings',chinese:'翅膀',box:{x:.15,y:.23,w:.70,h:.19}},
   {id:'water',label:'water',chinese:'水',box:{x:.07,y:.43,w:.86,h:.15}},
  ]},
  {id:'robot-design',image:'/course-assets/robot-reading-design.svg',width:900,height:720,objects:[
   {id:'air-wing',label:'wing in air',chinese:'空中的翅膀',box:{x:.10,y:.28,w:.32,h:.19}},
   {id:'water-wing',label:'wing in water',chinese:'水中的翅膀',box:{x:.57,y:.27,w:.31,h:.28}},
   {id:'water',label:'water',chinese:'水',box:{x:.53,y:.21,w:.40,h:.37}},
  ]},
  {id:'robot-mission',image:'/course-assets/robot-reading-mission.svg',width:900,height:720,objects:[
   {id:'robot',label:'robot',chinese:'机器人',box:{x:.08,y:.24,w:.58,h:.30}},
   {id:'mission',label:'mission idea',chinese:'任务想法',box:{x:.70,y:.20,w:.21,h:.31}},
   {id:'water',label:'water',chinese:'水',box:{x:.07,y:.48,w:.58,h:.09}},
  ]},
  {id:'robot-retell',image:'/course-assets/robot-reading-retell.svg',width:900,height:720,objects:[
   {id:'capabilities',label:'what it can do',chinese:'它能做什么',box:{x:.07,y:.22,w:.26,h:.35}},
   {id:'design',label:'design clue',chinese:'设计线索',box:{x:.37,y:.22,w:.26,h:.35}},
   {id:'idea',label:'my idea',chinese:'我的想法',box:{x:.67,y:.22,w:.26,h:.35}},
  ]},
 ],
 steps:[
  {id:'predict',kind:'speak',pageId:'robot-predict',targetId:null,expected:null,english:'Take a look at this machine. What do you think it can do?',chinese:'看图猜猜它能做什么',hint:'Notice one part of the machine. A word or a short idea is enough.',reading:reference('predict',passages.predict,'Make one plausible prediction from the picture.','Ask about the picture before reading. Accept a guess, word or short idea without marking it right or wrong. Do not reveal swimming yet. Respect silent observation; no oral reading is required. Follow the saved language preference.','What makes you think that?')},
  {id:'prediction-clue',kind:'speak',pageId:'robot-predict',targetId:null,expected:null,english:'Which part of the picture gave you that idea?',chinese:'说说你找到的线索',hint:'You might notice a wing, the body, or another part. Choose your own clue.',reading:reference('predict',passages.predict,'Name or explain one visual clue for the learner’s prediction.','Follow the learner’s actual prediction and ask for one clue. No single object name is required. If they need help, point to one visible feature and offer a choice. A plausible guess is participation, not mastery.','What does that part remind you of?')},
  {id:'read-capabilities',kind:'speak',pageId:'robot-read',targetId:null,expected:null,english:'Would you like to read this sentence, or shall I read it? Then let us find what else the robot can do.',chinese:'读一句，找一个新发现',hint:'You can listen or read silently. Look for the two ways the robot moves.',reading:reference('read',passages.read,'Identify the robot’s two ways of moving from the lesson sentence.','Offer silent reading or tutor reading. Read the supplied lesson sentence. Explain transition as change if needed. Reciting the passage alone does not show understanding. Ask one meaning question after reading; respect a refusal to read aloud.','You guessed one way it moves. What else can it do?')},
  {id:'read-wings',kind:'speak',pageId:'robot-read',targetId:null,expected:null,english:'Which part of the robot helps it move in both places?',chinese:'找到同一对翅膀的线索',hint:'Look at the picture and the sentence. Which part does the robot use?',reading:reference('read',passages.read,'Find the wings as the design clue in the sentence and picture.','Invite the learner to locate a clue in the lesson sentence. A word or their own explanation is fine. Questions, uncertainty and repeating the sentence are not proof of comprehension. Show a known object only with a confirmed classroom tool.','Which part of the sentence helped you work that out?')},
  {id:'flexible-design',kind:'speak',pageId:'robot-design',targetId:null,expected:null,english:'Imagine moving your hand through air and water. What might feel different?',chinese:'想一想，翅膀为什么要能弯曲',hint:'Flexible means it can bend. Think about what water does when you move through it.',reading:reference('explain',passages.design,'Connect flexible wings with the challenge of moving through air and water.','This is a Teeko activity. First accept the learner’s experience, then explain flexible as able to bend. Wings need to bend in water and remain firm enough for flight; softer is not always better. Accept a partial idea and one clarification, without forcing repetition.','Why might a wing that can bend help in water?')},
  {id:'robot-mission',kind:'speak',pageId:'robot-mission',targetId:null,expected:null,english:'If you could give this robot one job, what would you choose?',chinese:'给机器人设计一个任务',hint:'You can start with: I would use it to… Choose a job you find interesting.',reading:reference('design',passages.mission,'Propose a mission, addition or test of the learner’s own.','Follow any age-appropriate mission, such as watching sharks or looking for treasure. Add one genuine follow-up. A camera or rescue equipment is the learner’s proposal, not a demonstrated feature. Ocean research is a possible future use; do not claim deployment or AI autonomy.','What would you add, or what would you test first?')},
  {id:'robot-retell',kind:'speak',pageId:'robot-retell',targetId:null,expected:null,english:'Your friend has not read about this robot. What would you tell them?',chinese:'用自己的话介绍它',hint:'Choose one starting point: It can… Its wings… I would use it to…',reading:reference('retell',passages.retell,'Share a brief explanation, design idea or question in the learner’s own words.','Invite one or two sentences, with starters only if needed. One idea is enough; do not require all three or a memorized script. Naturally recast one clear grammar issue while preserving the meaning. Repeating the lesson sentence is not a comprehension result.','What is the one thing you want your friend to remember?')},
  {id:'robot-chat',kind:'listen',pageId:'robot-retell',targetId:null,expected:null,english:'What else would you like to explore about robots or nature?',chinese:'继续聊聊你的好奇',hint:'Ask a question, explore your idea, or choose to finish when you are ready.',reading:reference('chat',passages.retell,'Continue learner-led conversation without a required answer.','Stay with the learner’s curiosity. Admit when the article does not answer a question. No answer is required and this conversation does not prove mastery. Do not end the classroom or loop a recap; only the learner’s finish action or application limits end it.','What would you like to find out next?')},
 ],
};
