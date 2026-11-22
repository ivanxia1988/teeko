import type {PublishedCourse} from '../classroom-contract';
import type {LessonStep,ReadingActivity} from '../types';
import {TOPIC_CATALOG} from '../topic-learning';
import {ROBOT_READING_COURSE} from './robot-reading-course';

const voiceNotes=(notes:string)=>`Voice only. Never ask the learner to click or draw. Use highlight_objects to point while explaining. ${notes}`;
function step(id:string,pageId:string,phase:ReadingActivity['phase'],english:string,chinese:string,passage:string,goal:string,notes:string,followUp:string):LessonStep{
 return{id,kind:phase==='chat'?'listen':'speak',pageId,targetId:null,expected:null,english,chinese,hint:followUp,
  reading:{phase,passage,goal,teacherNotes:voiceNotes(notes),followUp}};
}
const robot=TOPIC_CATALOG[0],picnic=TOPIC_CATALOG[1];
const robotPassage=ROBOT_READING_COURSE.steps[2].reading!.passage;
export const TOPIC_ROBOT_COURSE:PublishedCourse={
 id:robot.id,version:'1',title:robot.title,subtitle:robot.subtitle,description:robot.description,durationMinutes:robot.durationMinutes,sessionLimitSeconds:1200,
 objectives:robot.objectives,words:robot.words,reading:ROBOT_READING_COURSE.reading,
 pages:structuredClone(ROBOT_READING_COURSE.pages.slice(0,2)),
 steps:[
  step('robot-welcome','robot-predict','predict','Hi! How are you today? Let us meet an unusual machine. What do you notice about it?','认识这台机器',robot.preview.passage,'Greet briefly, describe one visible feature, then invite a spoken observation.','Begin with a brief greeting. Describe the machine and visibly point to wings. Accept a short observation; do not quiz for one fixed answer.','What do its wings remind you of?'),
  step('robot-clues','robot-predict','predict','Look at its wings and tail. What might this machine be able to do?','聊聊翅膀和尾巴的线索',robot.preview.passage,'Use a visible feature to make a plausible prediction.','Explain wings with a short example and mark them. Accept guesses; after one exchange invite the next page rather than drilling.','What makes you think that?'),
  step('robot-discovery','robot-read','read','Here is one sentence about the robot. Shall I read it for you? This robot can fly and swim. What surprises you?','读一句教材，发现两种运动',robotPassage,'Understand that the same robot flies and swims.','Offer tutor reading or silent reading. Explain transition as change. Mark wings and water as mentioned. Read the supplied lesson sentence.','Where would you like to see it go?'),
  step('robot-mission','robot-read','design','If this robot were yours, what job would you give it?','给机器人安排一个任务',robotPassage,'Express one imagined mission or question in the learner’s own words.','Follow the learner idea. A camera, rescue or ocean job is their proposal, not a proven feature. Model one useful expression without demanding repetition.','You can start with: I would use it to…'),
  step('robot-chat','robot-read','chat','What else would you like to explore about this robot or nature?','继续聊聊你的想法',robotPassage,'Continue conversation until the learner chooses to finish.','Stay curious and answer follow-ups. Do not end automatically or repeat a recap. Offer one useful expression based on what the learner actually said.','What would you like to find out next?'),
 ],
};
export const TOPIC_PICNIC_COURSE:PublishedCourse={
 id:picnic.id,version:'1',title:picnic.title,subtitle:picnic.subtitle,description:picnic.description,durationMinutes:picnic.durationMinutes,sessionLimitSeconds:900,
 objectives:picnic.objectives,words:picnic.words,
 pages:[{id:'picnic-table',image:'/course-assets/picnic-v1.svg',width:900,height:720,objects:[
  {id:'apple',label:'apple',chinese:'苹果',box:{x:.15,y:.32,w:.22,h:.34}},
  {id:'banana',label:'banana',chinese:'香蕉',box:{x:.40,y:.32,w:.23,h:.34}},
  {id:'strawberry',label:'strawberry',chinese:'草莓',box:{x:.68,y:.32,w:.21,h:.34}},
 ]}],
 steps:[
  step('picnic-welcome','picnic-table','predict','Hi! How are you today? Let us plan a picnic. Which fruit do you like?','聊聊喜欢的水果',picnic.preview.passage,'Greet and invite one personal fruit choice.','Greet briefly, name one fruit and visibly mark it. Accept a word or gesture described in speech. Offer a short sentence if helpful.','You can say: I like apples.'),
  step('picnic-choice','picnic-table','explain','I like apples. What would you bring to our picnic?','说说野餐想带什么',picnic.preview.passage,'Express a personal choice in a short phrase or sentence.','Use the picture to name fruit. Model I will bring… and ask one genuine follow-up. Other food choices are welcome.','Why would you bring that?'),
  step('picnic-invite','picnic-table','design','Imagine I am your friend. How would you invite me to your picnic?','邀请朋友一起野餐',"Let's have a picnic!",'Try a friendly invitation.','Give one example naturally, then invite a personal version. No exact recitation required; respect refusal and continue the plan.','You could say: Would you like to have a picnic?'),
  step('picnic-plan','picnic-table','retell','Where shall we go for our picnic, and what would you like to do there?','一起完成野餐计划',picnic.preview.passage,'Share one plan or question about the picnic.','Follow their place and activity. One idea is enough. Model one clear useful sentence repair without assessing pronunciation.','You can start with: I would like to…'),
  step('picnic-chat','picnic-table','chat','What else would you like to tell me about your picnic?','继续聊聊你的计划',picnic.preview.passage,'Enjoy learner-led conversation.','Keep listening and follow curiosity. Do not end automatically, count answers or require repetition. Offer a concrete expression based on their words.','What would make it a fun day?'),
 ],
};
export const TOPIC_COURSES:PublishedCourse[]=[TOPIC_ROBOT_COURSE,TOPIC_PICNIC_COURSE];
