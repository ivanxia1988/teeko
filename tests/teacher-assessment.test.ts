import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeacherAssessment} from '../lib/server/teacher-assessment';
import {teacherConfig,teacherSnapshot} from './teacher-runtime-fixture';
const result={decision:'correct',confidence:'high',reason:'The learner expressed a valid thing to bring.',suggestedResponse:'Sandwiches sound great. Who would you share them with?',nextAction:'follow_up'};
const openai=(value:unknown)=>Response.json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
test('OpenAI assessment uses only bounded current text, strict JSON schema and no stored response',async()=>{
 let body:Record<string,unknown>|undefined;
 const assess=createTeacherAssessment({provider:'openai',apiKey:'synthetic-fixture',model:'gpt-4.1-mini',fetch:async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/responses');body=JSON.parse(String(init?.body));return openai(result);}});
 const snapshot=teacherSnapshot({stepIndex:8,preferences:{...teacherSnapshot().preferences,provider:'openai'}});
 assert.deepEqual(await assess({snapshot,config:teacherConfig,text:'I will bring sandwiches.'}),result);
 assert.equal(body?.store,false);assert.equal((body?.text as {format:{type:string}}).format.type,'json_schema');
 const sent=JSON.stringify(body);assert(sent.includes('sandwiches'));assert(!sent.includes('Synthetic learner'));assert(!sent.includes('data:image'));assert(!sent.includes('synthetic-fixture'));
 const reference=JSON.parse((body!.input as {content:{text:string}[]}[])[0].content[0].text.replace('Untrusted classroom reference JSON: ',''));
 assert.equal(reference.task.answerScope,'open_expression');assert.equal(reference.task.expected,undefined);assert.equal(reference.knownObjects,undefined);
});
test('Qwen assessment stays in its provider route and uses JSON mode with thinking disabled',async()=>{
 const assess=createTeacherAssessment({provider:'qwen',apiKey:'synthetic-fixture',workspaceId:'fixture-space',region:'cn-beijing',model:'qwen-plus',fetch:async(url,init)=>{assert.equal(url,'https://fixture-space.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');const body=JSON.parse(String(init?.body));assert.equal(body.enable_thinking,false);assert.equal(body.response_format.type,'json_object');const messages=JSON.stringify(body.messages);assert(messages.includes('JSON'));assert(messages.includes('confidence'));assert(messages.includes('high'));assert(messages.includes('low'));assert(messages.includes('maxLength'));assert(messages.includes('additionalProperties'));return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(result)}}]});}});
 assert.deepEqual(await assess({snapshot:teacherSnapshot(),config:teacherConfig,text:'It is an apple.'}),result);
});
test('malformed, refused and overlong model results are unavailable rather than invented grades',async()=>{
 for(const value of [{...result,decision:'mastered'}, {...result,unknown:true},{...result,reason:'x'.repeat(301)}]){
  const assess=createTeacherAssessment({provider:'openai',apiKey:'synthetic-fixture',model:'gpt-4.1-mini',fetch:async()=>openai(value)});
  await assert.rejects(assess({snapshot:teacherSnapshot({preferences:{...teacherSnapshot().preferences,provider:'openai'}}),config:teacherConfig,text:'apple'}),/教学判断/);
 }
});
test('a pre-aborted, hanging and oversized assessment cannot retain an unbounded request',async()=>{
 const input={snapshot:teacherSnapshot({preferences:{...teacherSnapshot().preferences,provider:'openai'}}),config:teacherConfig,text:'apple'};
 const signal=AbortSignal.abort();let called=0;
 const assess=createTeacherAssessment({provider:'openai',apiKey:'synthetic-fixture',model:'gpt-4.1-mini',timeoutMs:10,fetch:async()=>{called++;return new Promise<Response>(()=>{});}});
 await assert.rejects(assess(input,signal));assert.equal(called,0);await assert.rejects(assess(input),/教学判断/);
 const large=createTeacherAssessment({provider:'openai',apiKey:'synthetic-fixture',model:'gpt-4.1-mini',fetch:async()=>new Response('x'.repeat(33000))});await assert.rejects(large(input));
});
test('assessment pacing follows the adapted activity level while retaining the initial profile level',async()=>{
 let reference:Record<string,unknown>|undefined;
 const assess=createTeacherAssessment({provider:'openai',apiKey:'synthetic-fixture',model:'gpt-4.1-mini',fetch:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));reference=JSON.parse(body.input[0].content[0].text.replace('Untrusted classroom reference JSON: ',''));return openai(result);
 }});
 const snapshot=teacherSnapshot({profile:{...teacherSnapshot().profile,level:'conversation'},preferences:{...teacherSnapshot().preferences,provider:'openai'}});
 await assess({snapshot,config:teacherConfig,text:'I will bring sandwiches.',teachingState:{level:'starter',evidence:[],hints:{},digressionTurns:0}});
 assert.equal(reference?.initialLevel,'conversation');assert.equal(reference?.effectiveLevel,'starter');assert.deepEqual(reference?.policy,teacherConfig.policy.levels.starter);
 await assess({snapshot,config:teacherConfig,text:'I will bring sandwiches.'});
 assert.equal(reference?.effectiveLevel,'conversation');assert.deepEqual(reference?.policy,teacherConfig.policy.levels.conversation);
});

test('assessment receives the actual conversation policy before proposing a bridge',async()=>{
 let reference:{digression:{mayInviteBridge:boolean;exchanges:number}}|undefined;
 const assess=createTeacherAssessment({provider:'openai',apiKey:'synthetic-fixture',model:'gpt-4.1-mini',fetch:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));reference=JSON.parse(body.input[0].content[0].text.replace('Untrusted classroom reference JSON: ',''));return openai({...result,decision:'conversation',nextAction:'continue_topic'});
 }});
 const snapshot=teacherSnapshot({preferences:{...teacherSnapshot().preferences,provider:'openai'}});
 await assess({snapshot,config:teacherConfig,text:'I like dinosaurs.'});assert.equal(reference?.digression.mayInviteBridge,false);
 await assess({snapshot,config:teacherConfig,text:'I like dinosaurs.',teachingState:{level:'starter',evidence:[],hints:{},digressionTurns:3}});assert.equal(reference?.digression.exchanges,3);assert.equal(reference?.digression.mayInviteBridge,true);
 const config={...teacherConfig,policy:{...teacherConfig.policy,digression:'open' as const}};
 await assess({snapshot,config,text:'I like dinosaurs.',teachingState:{level:'starter',evidence:[],hints:{},digressionTurns:6}});assert.equal(reference?.digression.mayInviteBridge,false);
});

test('both assessment providers receive actionable correction guidance for complete learner utterances',async()=>{
 for(const provider of ['qwen','openai'] as const){
  let prompt='';
  const assessment={...result,decision:'conversation',suggestedResponse:'Your brother likes dinosaurs. Which dinosaur?',nextAction:'follow_up'};
  const assess=createTeacherAssessment({provider,apiKey:'synthetic-fixture',workspaceId:'fixture-space',model:provider==='qwen'?'qwen-plus':'gpt-4.1-mini',fetch:async(_url,init)=>{
   const body=JSON.parse(String(init?.body));prompt=provider==='qwen'?body.messages[0].content:body.instructions;
   return provider==='openai'?openai(assessment):Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(assessment)}}]});
  }});
  const snapshot=teacherSnapshot({preferences:{...teacherSnapshot().preferences,provider}});
  const answer=await assess({snapshot,config:teacherConfig,text:'My brother like dinosaurs.'});
  assert.equal(answer.decision,'conversation');
  assert(prompt.includes('one clear, useful sentence-structure error'),provider);
  assert(prompt.includes('including during conversation'),provider);
  assert(prompt.includes('do not call an otherwise successful message wrong'),provider);
  assert(prompt.includes('Never invent an error from uncertain speech recognition'),provider);
 }
});

test('assessment applies the selected focused correction mode instead of treating the enum as an undefined reference',async()=>{
 let prompt='';
 const assess=createTeacherAssessment({provider:'openai',apiKey:'synthetic-fixture',model:'gpt-4.1-mini',fetch:async(_url,init)=>{prompt=JSON.parse(String(init?.body)).instructions;return openai(result);}});
 await assess({snapshot:teacherSnapshot({preferences:{...teacherSnapshot().preferences,provider:'openai'}}),config:{...teacherConfig,policy:{...teacherConfig.policy,correction:'focused'}},text:'I will brings sandwiches.'});
 assert(prompt.includes('briefly name the one useful change'));
 assert(prompt.includes('Do not demand repetition'));
});

test('assessment correction must repair the learner clause instead of replacing it with generic encouragement',async()=>{
 for(const provider of ['qwen','openai'] as const){
  let prompt='';
  const assess=createTeacherAssessment({provider,apiKey:'synthetic-fixture',workspaceId:'fixture-space',model:provider==='qwen'?'qwen-plus':'gpt-4.1-mini',fetch:async(_url,init)=>{
   const body=JSON.parse(String(init?.body));prompt=provider==='qwen'?body.messages[0].content:body.instructions;
   return provider==='openai'?openai(result):Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(result)}}]});
  }});
  await assess({snapshot:teacherSnapshot({stepIndex:8,preferences:{...teacherSnapshot().preferences,provider}}),config:teacherConfig,text:'I will brings sandwiches.'});
  assert(prompt.includes('I will brings sandwiches'),provider);
  assert(prompt.includes('I will bring sandwiches'),provider);
  assert(prompt.includes('My brother like dinosaurs'),provider);
  assert(prompt.includes('Your brother likes dinosaurs'),provider);
  assert(prompt.includes('Do not replace that repair with a different sentence'),provider);
  assert(prompt.includes('not a grader'),provider);
  assert(prompt.includes('this unrelated interest remains conversation, not a correct picnic answer'),provider);
 }
});

test('a structured sentence repair is actually spoken without promoting an unrelated topic to success',async()=>{
 const assess=createTeacherAssessment({provider:'openai',apiKey:'synthetic-fixture',model:'gpt-4.1-mini',fetch:async(_url,init)=>openai(JSON.parse(String(init?.body)).text.format.name==='sentence_repair'?{needed:true,model:'Your brother likes dinosaurs.'}:{...result,decision:'conversation',suggestedResponse:'Dinosaurs are interesting!'})});
 const value=await assess({snapshot:teacherSnapshot({stepIndex:6,preferences:{...teacherSnapshot().preferences,provider:'openai'}}),config:teacherConfig,text:'My brother like dinosaurs.'});
 assert.equal(value.decision,'conversation');assert.equal(value.suggestedResponse,'Your brother likes dinosaurs.');assert.equal(value.nextAction,'model');assert(!('sentenceRepair' in value));
});

test('optional form timeout preserves the independently confirmed meaning within the original deadline',async()=>{
 let calls=0,aborted=false;const assess=createTeacherAssessment({provider:'openai',apiKey:'synthetic-fixture',model:'gpt-4.1-mini',timeoutMs:450,fetch:async(_url,init)=>{calls++;if(calls===1)return openai(result);init?.signal?.addEventListener('abort',()=>{aborted=true;},{once:true});return new Promise<Response>(()=>{});}});
 const value=await assess({snapshot:teacherSnapshot({preferences:{...teacherSnapshot().preferences,provider:'openai'}}),config:teacherConfig,text:'I will bring sandwiches.'});
 assert.deepEqual(value,result);assert.equal(calls,2);assert.equal(aborted,true);
});
test('external cancellation during a form request cannot return a stale semantic answer',async()=>{
 const controller=new AbortController();let calls=0;
 const assess=createTeacherAssessment({provider:'openai',apiKey:'synthetic-fixture',model:'gpt-4.1-mini',fetch:async()=>{if(++calls===1)return openai(result);controller.abort();return new Promise<Response>(()=>{});}});
 await assert.rejects(assess({snapshot:teacherSnapshot({preferences:{...teacherSnapshot().preferences,provider:'openai'}}),config:teacherConfig,text:'I will bring sandwiches.'},controller.signal));assert.equal(calls,2);
});
test('uncertain recognition avoids a second request and unsafe form output cannot replace safe feedback',async()=>{
 for(const unsafe of [null,{needed:true,model:'https://example.test'},{needed:true,model:'synthetic-secret-key'},{needed:true,model:'I like apples.',decision:'correct'}]){
  let calls=0;const expected=unsafe===null?{...result,confidence:'low'}:result;
  const assess=createTeacherAssessment({provider:'openai',apiKey:'synthetic-secret-key',model:'gpt-4.1-mini',fetch:async()=>openai(++calls===1?expected:unsafe)});
  const value=await assess({snapshot:teacherSnapshot({preferences:{...teacherSnapshot().preferences,provider:'openai'}}),config:teacherConfig,text:'apples'});
  assert.deepEqual(value,expected);assert.equal(calls,unsafe===null?1:2);
 }
});

test('both routes use separate schemas and a form response cannot rewrite the semantic decision',async()=>{
 for(const provider of ['qwen','openai'] as const){
  const requests:{body:{text?:{format:{name:string}};messages?:{content:string}[]};authorization:string|null}[]=[];
  const assess=createTeacherAssessment({provider,apiKey:'synthetic-key',model:provider==='qwen'?'qwen-plus':'gpt-4.1-mini',workspaceId:'fixture-space',fetch:async(_url,init)=>{
   requests.push({body:JSON.parse(String(init?.body)),authorization:new Headers(init?.headers).get('authorization')});
   const value=requests.length===1?{...result,decision:'conversation'}:{needed:true,model:'Your brother likes dinosaurs.'};
   return provider==='openai'?openai(value):Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(value)}}]});
  }});
  const value=await assess({snapshot:teacherSnapshot({stepIndex:6,preferences:{...teacherSnapshot().preferences,provider}}),config:teacherConfig,text:'My brother like dinosaurs.'});
  assert.equal(value.decision,'conversation');assert.equal(value.suggestedResponse,'Your brother likes dinosaurs.');assert.equal(requests.length,2);assert(requests.every(r=>r.authorization==='Bearer synthetic-key'));
  if(provider==='openai'){assert.equal(requests[0].body.text!.format.name,'teaching_assessment');assert.equal(requests[1].body.text!.format.name,'sentence_repair');}
  else{assert.match(requests[0].body.messages![0].content,/communicative meaning/);assert.match(requests[1].body.messages![0].content,/not a grader/);}
 }
});
