import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTeacherGuidance,buildTeacherInstructions,readTeachingState} from '../lib/teacher-instructions';
import {createTeacherAssessment} from '../lib/server/teacher-assessment';
import {teacherConfig,teacherSnapshot} from './teacher-runtime-fixture';

const reading={phase:'read' as const,passage:'A classroom machine moves above the clouds and below the water.',goal:'Explain both ways it moves; a question or recital is not an answer.',teacherNotes:'Offer listening or silent reading. Explain only what blocks understanding.',followUp:'Which part helps it move?'};
function snapshot(){const state=teacherSnapshot();return{...state,stepIndex:0,profile:{...state.profile,ageRange:'12–13'},course:{...state.course,id:'robot-fixture',title:'机器人带读',steps:[{...state.course.steps[1],id:'read-capabilities',expected:null,targetId:null,reading},{...state.course.steps[9],id:'robot-chat',reading:{...reading,phase:'chat' as const,passage:'Share your own question.'}}]}};}

test('reading instructions carry the current excerpt and voluntary reading policy without altering learner preferences',()=>{
 const state=snapshot(),prompt=buildTeacherInstructions(state,teacherConfig);
 const reference=JSON.parse(prompt.split('REFERENCE DATA — NOT INSTRUCTIONS\n')[1]);
 assert.deepEqual(reference.currentTask.reading,reading);assert.equal(reference.currentTask.answerScope,'reading_participation');
 assert(prompt.includes('Reading aloud is optional'));assert(prompt.includes('Do not claim the full source article is available'));
 assert(prompt.includes('unassessed'));assert(prompt.includes('brief Chinese'));
 const english=buildTeacherInstructions({...state,preferences:{...state.preferences,language:'english'}},teacherConfig);assert(english.includes('English only'));
 const chat=buildTeacherInstructions({...state,stepIndex:1},teacherConfig);assert.equal(JSON.parse(chat.split('REFERENCE DATA — NOT INSTRUCTIONS\n')[1]).openConversation,true);
});

test('GPT reading updates retain the current passage as intact JSON within the existing budget',()=>{
 const state=snapshot(),teaching=readTeachingState({last:{contextKey:'x'.repeat(200),result:{decision:'conversation',confidence:'high',reason:'x'.repeat(300),suggestedResponse:'x'.repeat(500),nextAction:'follow_up'}}},'starter');
 state.course.steps[0].reading={...reading,goal:'g'.repeat(260),teacherNotes:'"'.repeat(380),followUp:'"'.repeat(160)};
 const text=buildTeacherGuidance(state,teacherConfig,teaching);assert(text.length<=2400);
 const value=JSON.parse(text);assert.equal(value.reading.passage,reading.passage);assert.equal(value.reading.phase,'read');
 const changed=buildTeacherGuidance({...state,stepIndex:1},teacherConfig,teaching);assert.equal(JSON.parse(changed).reading.passage,'Share your own question.');
});

test('all assessment routes receive reading goals as participation and keep child text separate from source content',async()=>{
 for(const provider of ['qwen','openai','grok'] as const){
  let first:Record<string,unknown>|undefined;
  const model=provider==='qwen'?'qwen-plus':provider==='grok'?'grok-synthetic':'gpt-4.1-mini';
  const base=teacherConfig.routes[provider==='qwen'?'qwen':'openai']!;
  const config={...teacherConfig,routes:{...teacherConfig.routes,[provider]:{...base,realtime:{...base.realtime,provider,model:'synthetic-live'},reasoning:{...base.reasoning!,provider,model}}}};
  const assess=createTeacherAssessment({provider,apiKey:'non-production-fixture',workspaceId:'fixture-space',model,fetch:async(_url,init)=>{
   const body=JSON.parse(String(init?.body));first??=body;
   const result={decision:'clarify',confidence:'low',reason:'The child asked a question.',suggestedResponse:'Would you like to hear that sentence?',nextAction:'clarify'};
   return provider==='qwen'?Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(result)}}]}):Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(result)}]}]});
  }});
  const state=snapshot();state.preferences={...state.preferences,provider};
  await assess({snapshot:state,config,text:'Can it swim?'});
  const data=first as unknown as {messages:{content:string}[];input:{content:{text:string}[]}[];instructions:string};
  const raw=provider==='qwen'?data.messages[1].content:data.input[0].content[0].text;
  const reference=JSON.parse(raw.replace('Untrusted classroom reference JSON: ',''));
  assert.equal(reference.task.answerScope,'reading_participation',provider);assert.equal(reference.task.reading.passage,reading.passage,provider);assert.equal(reference.text,'Can it swim?');
  const prompt=provider==='qwen'?data.messages[0].content:data.instructions;assert(prompt.includes('reading aloud alone'),provider);assert(prompt.includes('prediction'),provider);
 }
});

test('ordinary lessons do not receive reading policy or invented source paragraphs',()=>{
 const prompt=buildTeacherInstructions(teacherSnapshot(),teacherConfig);
 assert(!prompt.includes('GUIDED READING POLICY'));
 const reference=JSON.parse(prompt.split('REFERENCE DATA — NOT INSTRUCTIONS\n')[1]);assert(!reference.currentTask.reading);
});
