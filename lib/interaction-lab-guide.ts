export const LAB_GUIDE_PAGE_IDS=['robot-predict','robot-read'] as const;
const openingGuidance='Give a full opening in your own words, about 45 to 60 seconds (105–130 English words). Develop each of these four teaching points in two or three short sentences. Save the only question for after the four points, then listen. If the learner speaks first, respond to them.';

type GuidePageId=typeof LAB_GUIDE_PAGE_IDS[number];
type GuideContent={openingTarget:string;targetIds:readonly string[];notes:string;openingPoints:readonly string[]};

const content:Record<GuidePageId,GuideContent>={
 'robot-predict':{
  openingTarget:'passage-machine',
  targetIds:['title','passage-first','passage-machine','passage-clues','passage-third','wings','body','tail'],
  notes:'This is the picture-prediction page: “An unusual machine.” The first line is “Look closely at this machine.” Explain machine as something people make to do a job. Explain clues as details that help us guess. The diagram shows wings, a body and a tail. Invite a prediction backed by one visible clue. Do not reveal swimming or confirm a guess as a fact here.',
  openingPoints:[],
 },
 'robot-read':{
  openingTarget:'wings',
  targetIds:['robot','wings','water'],
  notes:'This is the short-reading page: “One sentence, one discovery.” The lesson sentence is “Notice the wings as the robot makes its transition from flying to swimming.” Explain transition as a change from one kind of movement to another. Bring attention to the same wings in air and water. Invite the learner to connect a detail to what it can do. Do not invent other capabilities or require reading aloud.',
  openingPoints:[
   'Read the single sentence on this page and describe what it tells us about the highlighted wings.',
   'Explain transition with one familiar everyday example of changing from one activity to another.',
   'Return to the robot and contrast movement through air with movement through water.',
   'Connect the idea of one pair of wings to the two movements. Ask one meaning question the learner can answer in their own words.',
  ],
 },
};

type LessonBeat='machine'|'body'|'invite'|'waiting'|'choice';
type GuideBeat=LessonBeat|'question';
export type GuideDirection={beat:GuideBeat;cue:string;target?:string;clear?:true;resumed?:true};
const predictionMachine='Teach the word machine in the body text. Read the short phrase containing it. In your own simple English, explain that people make machines to do jobs and give one familiar example. Use two or three short sentences. Stop at this word. Do not ask a question or move on yet.';
const predictionBody='Talk only about the robot’s body in the middle of the diagram. The narrow central body joins other parts. Explain in two simple sentences how looking closely helps us start a prediction. Do not name the other parts, ask a question, use a tool or move on yet.';
const predictionInvite='Invite the learner, in one short spoken sentence, to TAP one part in the picture that might give them a clue about how the robot moves. Say the word “tap”. Leave the choice open. Do not suggest, name or mark any part. Then stop speaking and wait for their click.';
const choiceNotes:Record<string,string>={
 wings:'Acknowledge the wings explicitly. Describe how their wide shape could help lift the machine into the air, as a prediction. Use two short conversational sentences in your own words.',
 tail:'Acknowledge the tail explicitly. Describe how it might help the robot steer or balance. Make it a possibility; its exact purpose is not established by the picture. Use two short conversational sentences in your own words.',
 body:'Acknowledge the body explicitly. Mention that its central shape might connect or support the parts that move. Treat it as a prediction.',
};
const pointDirection=(id:string)=>choiceNotes[id]??'Name the part the learner actually tapped and connect a visible detail to a possible movement.';
const instructionsForQuestion='Answer the learner’s most recent question in your own words, using their language for a clarification. Use one or two short sentences. For a vocabulary question, explain the meaning with one easy example. End your answer there: the application will return to the interrupted activity after playback. No tool call, new question, or fresh introduction.';

export class RobotPredictionGuide {
 beat:GuideBeat='machine';
 private bookmark:LessonBeat='machine';
 private chosen:string|undefined;

 private direction(beat:LessonBeat):GuideDirection{
  if(beat==='machine')return {beat,target:'passage-machine',cue:predictionMachine};
  if(beat==='body')return {beat,target:'body',cue:predictionBody};
  if(beat==='choice')return {beat,cue:pointDirection(this.chosen??'')};
  return {beat:'invite',clear:true,cue:predictionInvite};
 }
 opening():GuideDirection{return this.direction('machine');}
 playbackEnded():GuideDirection|undefined{
  if(this.beat==='question'){
   const restored=this.direction(this.bookmark);
   this.beat=restored.beat;
   return {...restored,resumed:true};
  }
  if(this.beat==='machine'||this.beat==='body'){
   const next=this.direction(this.beat==='machine'?'body':'invite');
   this.beat=next.beat;
   return next;
  }
  this.beat='waiting';
 }
 interrupt(){
  if(this.beat!=='question')this.bookmark=this.beat;
  this.beat='question';
 }
 question(text:string):GuideDirection{
  this.interrupt();
  const target=/\bclues?\b|线索/i.test(text)?'passage-clues':/\bmachines?\b|机器这个词/i.test(text)?'passage-machine':undefined;
  const example=target==='passage-clues'?' For the example use a wet umbrella as a clue that it may be raining outside. Skip robot parts and possible movements so the learner can make their own prediction.':'';
  return {beat:'question',target,cue:instructionsForQuestion+example};
 }
 pointed(id:string){
  this.chosen=id;
  this.beat='choice';
  return pointDirection(id)+' Respond to this click directly. Do not grade, reveal the discovery, or ask the learner to repeat the click.';
 }
}

export function labGuidePlan(pageId:string){
 const id=LAB_GUIDE_PAGE_IDS.find(id=>id===pageId);
 if(!id)return null;
 const {openingTarget,targetIds,notes,openingPoints}=content[id];
 return {
  targetIds,
  openingTarget,
  openingGuidance:id==='robot-predict'?predictionMachine:`${openingGuidance} ${openingPoints.map((point,index)=>`${index+1}. ${point}`).join(' ')}`,
  instructions:[
   `Current page teaching plan (${id}). ${notes}`,
   id==='robot-predict'?`For explicit learner marking requests, use the exact current contextKey and one valid target ID: ${targetIds.join(', ')}. The application already performs the planned teaching marks; never request a duplicate or narrate calling a tool. Only describe a mark as visible when the application confirms it.`:`Use highlight_objects with the exact current contextKey and one valid target ID: ${targetIds.join(', ')}. When changing focus, request the highlight before speaking about it and wait for confirmation. If the target is already confirmed, discuss it without repeating the call. On failure, continue without claiming it appeared.`,
   ...(id==='robot-predict'?['Teach only the current short activity. The application will coordinate highlighting, circling, an open click invitation, and listening after playback. Do not anticipate a later activity, reveal the solution or tell the learner which part to choose.']:[]),
   'Teach with clear English, or briefly clarify in Chinese when useful. On first entry give the requested opening explanation. After that keep exchanges short: ask one question, then listen. Respond to the learner’s newest question or observation first and never restart the opening after a follow-up.',
  ].join('\n'),
  openingCue:id==='robot-predict'?predictionMachine:`Begin this page only once. Call highlight_objects for ${openingTarget} before speaking. After the tool confirms it, explain that point in your own words, ask one genuine question and listen.`,
 };
}
