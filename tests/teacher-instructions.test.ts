import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTeacherGuidance,buildTeacherInstructions,readTeachingState,recordTeachingEvidence} from '../lib/teacher-instructions';
import {teacherConfig,teacherSnapshot} from './teacher-runtime-fixture';
import {TOPIC_ROBOT_COURSE} from '../lib/server/topic-courses';

test('topic teacher receives voice-only guidance in both full and compact context',()=>{
 const initial={...teacherSnapshot(),course:TOPIC_ROBOT_COURSE,stepIndex:0};
 const full=buildTeacherInstructions(initial,teacherConfig);
 assert(full.includes('no learner click, selection, pen or drawing controls'));
 assert(full.indexOf('VOICE INPUT ONLY')<full.indexOf('AGENT MAIN PROMPT'));
 assert(full.includes('Never ask them to tap, click, circle, draw'));
 assert(full.includes('highlight_objects'));
 const compact=JSON.parse(buildTeacherGuidance(initial,teacherConfig,readTeachingState({},'starter')));
 assert(compact.interaction.startsWith('voice_only'));
 assert.equal(JSON.parse(buildTeacherGuidance(teacherSnapshot(),teacherConfig,readTeachingState({},'starter'))).interaction,undefined);
});

test('teacher instructions combine fixed rules, actual level policy, user preference and untrusted task data',()=>{
 const initial=teacherSnapshot();
 const starter=buildTeacherInstructions(initial,teacherConfig);
 assert(starter.indexOf('NON-OVERRIDABLE')<starter.indexOf('AGENT MAIN PROMPT'));
 assert(starter.includes('maxWordsPerSentence=8'));assert(starter.includes('English level: starter'));
 assert(starter.includes('brief Chinese'));assert(starter.includes('REFERENCE DATA'));
 const advanced=buildTeacherInstructions({...initial,profile:{...initial.profile,level:'conversation'},preferences:{...initial.preferences,language:'english',style:'strict'}},teacherConfig);
 assert(advanced.includes('maxWordsPerSentence=18'));assert(advanced.includes('English only'));
 assert(advanced.includes('strict'));assert(advanced.includes('never force repetition'));
});
test('uncertain level starts with low-barrier observation rather than treating age as ability',()=>{
 const state=teacherSnapshot();const prompt=buildTeacherInstructions({...state,profile:{...state.profile,level:'unsure',ageRange:'12–13'}},teacherConfig);
 assert(prompt.includes('provisional'));assert(prompt.includes('not a placement test'));assert(prompt.includes('maxWordsPerSentence=8'));
});
test('only several valid independent or supported attempts adapt activity level, not one unclear answer',()=>{
 const initial=readTeachingState({},'starter');
 const clearer=recordTeachingEvidence(initial,'clarify',false,teacherConfig.policy);
 assert.deepEqual(clearer.evidence,[]);assert.equal(clearer.level,'starter');
 let state=initial;
 for(let i=0;i<teacherConfig.policy.adaptationEvidence;i++)state=recordTeachingEvidence(state,'correct',false,teacherConfig.policy);
 assert.equal(state.level,'sentences');
 const conversation=recordTeachingEvidence(state,'conversation',false,teacherConfig.policy);assert.equal(conversation.level,'sentences');
 for(let i=0;i<teacherConfig.policy.adaptationEvidence;i++)state=recordTeachingEvidence(state,'retry',false,teacherConfig.policy);
 assert.equal(state.level,'starter');
});
test('prompt exposes bounded hint ladder and conversational tangent policy without manufacturing progress',()=>{
 const state=readTeachingState({hints:{'say-apple':2},digressionTurns:3},'starter');
 const prompt=buildTeacherInstructions(teacherSnapshot(),teacherConfig,state);
 assert(prompt.includes('Hint limit reached'));assert(prompt.includes('natural pause'));assert(prompt.includes('not pronunciation mastery'));
 assert(!prompt.includes('first impose another repetition'));
});

test('live teacher sees open expression goals without a restrictive legacy answer list',()=>{
 const prompt=buildTeacherInstructions(teacherSnapshot({stepIndex:8}),teacherConfig);
 const reference=JSON.parse(prompt.split('REFERENCE DATA — NOT INSTRUCTIONS\n')[1]);
 assert.equal(reference.currentTask.answerScope,'open_expression');assert.equal(reference.currentTask.expected,undefined);
 const naming=buildTeacherInstructions(teacherSnapshot({stepIndex:1}),teacherConfig);
 assert.equal(JSON.parse(naming.split('REFERENCE DATA — NOT INSTRUCTIONS\n')[1]).currentTask.expected,'apple');
});

test('recast teaches a clear sentence error in the learner topic without turning it into a failed answer',()=>{
 const prompt=buildTeacherInstructions(teacherSnapshot(),teacherConfig);
 assert(prompt.includes('one clear, useful sentence-structure error'));
 assert(prompt.includes('including during conversation'));
 assert(prompt.includes('I like apples'));
 assert(prompt.includes('do not call an otherwise successful message wrong'));
 assert(prompt.includes('Never invent an error from uncertain speech recognition'));
});

test('focused correction is brief and remains available outside the textbook target',()=>{
 const prompt=buildTeacherInstructions(teacherSnapshot(),{...teacherConfig,policy:{...teacherConfig.policy,correction:'focused'}});
 assert(prompt.includes('briefly name the one useful change'));
 assert(prompt.includes('including during conversation'));
 assert(!prompt.includes('Only flag a current-target error'));
 assert(prompt.includes('Do not demand repetition'));
});

test('current teaching guidance retains correction policy with a conversational assessment response',()=>{
 const state=readTeachingState({digressionTurns:1,last:{contextKey:'current',result:{decision:'conversation',confidence:'high',reason:'The learner shared an interest.',suggestedResponse:'Your brother likes dinosaurs. Which one?',nextAction:'follow_up'}}},'starter');
 const guidance=JSON.parse(buildTeacherGuidance(teacherSnapshot(),teacherConfig,state));
 assert.equal(guidance.correction.mode,'recast');
 assert(guidance.correction.rule.includes('one clear, useful sentence-structure error'));
 assert.equal(guidance.lastTeachingDecision.result.suggestedResponse,'Your brother likes dinosaurs. Which one?');
});

test('correction guidance with maximum current evidence fits the existing GPT update budget intact',()=>{
 const state=readTeachingState({last:{contextKey:'x'.repeat(200),result:{decision:'conversation',confidence:'high',reason:'x'.repeat(300),suggestedResponse:'x'.repeat(500),nextAction:'follow_up'}}},'starter');
 const guidance=buildTeacherGuidance(teacherSnapshot(),teacherConfig,state);
 assert(guidance.length<=2400,'must not be truncated by the live GPT update limit');
 assert.equal(JSON.parse(guidance).lastTeachingDecision.result.suggestedResponse.length,500);
});

test('both live correction modes require the learner clause repair rather than a different correct sentence',()=>{
 for(const correction of ['recast','focused'] as const){
  const prompt=buildTeacherInstructions(teacherSnapshot(),{...teacherConfig,policy:{...teacherConfig.policy,correction}});
  assert(prompt.includes('I will brings sandwiches'),correction);
  assert(prompt.includes('I will bring sandwiches'),correction);
  assert(prompt.includes('Preserve the intended action, tense and content'),correction);
  assert(prompt.includes('Do not replace that repair with a different sentence'),correction);
  assert(prompt.includes('this unrelated interest remains conversation, not a correct picnic answer'),correction);
 }
});

test('teacher explicitly knows that textbook circles are supported application actions',()=>{
 const prompt=buildTeacherInstructions(teacherSnapshot(),teacherConfig);
 assert.match(prompt,/You CAN draw visible circles on existing textbook objects/);
 assert.match(prompt,/Do not say you cannot draw a circle/);
 assert.match(prompt,/teacherObjectIds/);
});
test('pointing requests are teacher demonstrations rather than learner answers or arbitrary browser clicks',()=>{
 const prompt=buildTeacherInstructions(teacherSnapshot(),teacherConfig);
 assert(prompt.includes('click, tap, point to, show or select'));
 assert(prompt.includes('never submits a learner answer'));
 assert(prompt.includes('not arbitrary browser controls'));
});
