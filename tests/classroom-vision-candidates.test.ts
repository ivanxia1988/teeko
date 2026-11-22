import assert from 'node:assert/strict';
import test from 'node:test';
import {createClassroomVisionCandidate,VISION_OBJECT_CATEGORIES} from '../lib/server/classroom-vision-candidates';

const image=Buffer.from([255,216,255,192,0,11,8,0,240,1,64,1,1,17,0,255,217]).toString('base64');
const key='non-production-evaluation';
const distribution=()=>VISION_OBJECT_CATEGORIES.map(value=>({value,probability:value==='toy'?.8:value==='unclear'?.2:0}));
const facts=()=>({scene_clear:.8,person_visible:.9,object_held:.7,held_object:{choice:'toy',confidence:.8,probabilities:distribution()}});
const usage=()=>({input_tokens:100,input_tokens_details:{cached_tokens:10,cache_write_tokens:5},output_tokens:0,output_tokens_details:{reasoning_tokens:0},total_tokens:100});
const native=()=>({model:'gpt-6-luna',answers:[...(['scene_clear','person_visible','object_held'] as const).map(name=>({type:'predicate',name,probability:facts()[name]})),{type:'choice',name:'held_object',...facts().held_object}] as Record<string,unknown>[],usage:usage()});
const response=()=>({model:'gpt-4.1-mini',status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(facts())}]}],usage:usage()});
const qwen=()=>({model:'qwen3-vl-plus',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(facts())}}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}});

test('Decisions uses fixed observable questions and returns typed probabilities with real usage',async()=>{
 let called=0,now=10;
 const candidate=createClassroomVisionCandidate({kind:'decisions',apiKey:key,now:()=>now,fetch:async(url,init)=>{
  called++;assert.equal(url,'https://api.openai.com/v1/decisions');assert.equal(init?.redirect,'error');const body=JSON.parse(String(init?.body));
  assert.equal(body.model,'gpt-6-luna');assert.equal('store' in body,false);assert.deepEqual(body.questions.map((q:{name:string})=>q.name),['scene_clear','person_visible','object_held','held_object']);
  assert(!JSON.stringify(body).match(/attention|grade|identity_score/));assert.equal(body.input.at(-1).content.at(-1).image_url,`data:image/jpeg;base64,${image}`);now=30;return Response.json(native());
 }});
 const result=await candidate.run(image,new AbortController().signal);assert.equal(called,1);assert.deepEqual(result.facts,facts());assert.equal(result.durationMs,20);
 assert.equal(result.probabilityKind,'native_decision');assert.deepEqual(result.usage,{inputTokens:100,outputTokens:0,cachedInputTokens:10,cacheWriteInputTokens:5});assert.equal(result.status,'completed');
});
test('per-question refusals are retained as unknown while other answers remain usable',async()=>{
 const value=native();value.answers[1]={type:'refusal',name:'person_visible'} as typeof value.answers[number];
 const result=await createClassroomVisionCandidate({kind:'decisions',apiKey:key,fetch:async()=>Response.json(value)}).run(image,new AbortController().signal);
 assert.equal(result.status,'partial');assert.equal(result.facts.person_visible,null);assert.equal(result.facts.scene_clear,.8);
});
test('Responses JSON baseline stays separate and labels its probabilities as model reported',async()=>{
 const candidate=createClassroomVisionCandidate({kind:'openai-json',apiKey:key,fetch:async(url,init)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(String(init?.body));assert.equal(body.store,false);assert.equal(body.text.format.strict,true);return Response.json(response());
 }});const result=await candidate.run(image,new AbortController().signal);assert.equal(result.probabilityKind,'model_reported');assert.deepEqual(result.facts,facts());
});
test('Qwen JSON uses only its explicit region/workspace and never falls back to OpenAI',async()=>{
 let called=0;const candidate=createClassroomVisionCandidate({kind:'qwen-json',apiKey:key,model:'qwen3-vl-plus',workspaceId:'test-workspace',region:'cn-beijing',fetch:async(url,init)=>{
  called++;assert.equal(url,'https://test-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');const body=JSON.parse(String(init?.body));
  assert.equal(body.enable_thinking,false);assert.equal(body.response_format.type,'json_object');assert.equal(body.stream,false);return Response.json(qwen());
 }});const result=await candidate.run(image,new AbortController().signal);assert.equal(called,1);assert.deepEqual(result.facts,facts());assert.equal(result.usage.cachedInputTokens,null);
});
test('unknown, duplicate, missing, nonnumeric and authority-bearing answers fail closed',async()=>{
 const values:unknown[]=[];const modelLeak=native();modelLeak.model='gpt-6-luna-\nPRIVATE_PROVIDER_BODY';values.push(modelLeak);
 let bad=native();bad.answers[0]={type:'predicate',name:'attention',probability:.9};values.push(bad);
 bad=native();bad.answers[1]=bad.answers[0];values.push(bad);bad=native();bad.answers.pop();values.push(bad);
 bad=native();(bad.answers[0] as {probability:unknown}).probability='high';values.push(bad);
 bad=native();bad.usage.input_tokens_details.cached_tokens=110;values.push(bad);
 bad=native();bad.answers[3]={...bad.answers[3],score:10} as typeof bad.answers[number];values.push(bad);
 for(const value of values)await assert.rejects(()=>createClassroomVisionCandidate({kind:'decisions',apiKey:key,fetch:async()=>Response.json(value)}).run(image,new AbortController().signal),{code:'invalid_result'});
 const json=response();json.output[0].content[0].text=JSON.stringify({...facts(),grade:100});await assert.rejects(()=>createClassroomVisionCandidate({kind:'openai-json',apiKey:key,fetch:async()=>Response.json(json)}).run(image,new AbortController().signal),{code:'invalid_result'});
});
test('invalid images and already aborted requests make no network request',async()=>{
 let called=0;const candidate=createClassroomVisionCandidate({kind:'decisions',apiKey:key,fetch:async()=>{called++;return Response.json(native());}});
 for(const invalid of ['https://example.com/photo.jpg','bad image','A'.repeat(192004)])await assert.rejects(()=>candidate.run(invalid,new AbortController().signal),{code:'invalid_input'});
 const controller=new AbortController();controller.abort();await assert.rejects(()=>candidate.run(image,controller.signal),{code:'cancelled'});assert.equal(called,0);
});
test('timeout and explicit cancellation settle even if an injected transport ignores abort',async()=>{
 const never=async()=>new Promise<Response>(()=>{});
 await assert.rejects(()=>createClassroomVisionCandidate({kind:'decisions',apiKey:key,timeoutMs:15,fetch:never}).run(image,new AbortController().signal),{code:'timeout'});
 const controller=new AbortController(),pending=createClassroomVisionCandidate({kind:'decisions',apiKey:key,fetch:never}).run(image,controller.signal);controller.abort();await assert.rejects(pending,{code:'cancelled'});
});
test('HTTP failures never expose provider bodies, image data or credentials and never retry',async()=>{
 let called=0;const candidate=createClassroomVisionCandidate({kind:'decisions',apiKey:key,fetch:async()=>{called++;return new Response(`PRIVATE_PROVIDER_BODY ${key} ${image}`,{status:429});}});
 await assert.rejects(()=>candidate.run(image,new AbortController().signal),(error:unknown)=>error instanceof Error&&!error.message.includes(key)&&!error.message.includes('PRIVATE')&&!error.message.includes(image));assert.equal(called,1);
});
test('response bounds and malformed distributions reject before returning candidate facts',async()=>{
 await assert.rejects(()=>createClassroomVisionCandidate({kind:'decisions',apiKey:key,fetch:async()=>new Response('x'.repeat(17000))}).run(image,new AbortController().signal),{code:'response_too_large'});
 const value=native();const choice=value.answers[3] as {probabilities:{value:string;probability:number}[]};choice.probabilities[1].probability=.9;
 await assert.rejects(()=>createClassroomVisionCandidate({kind:'decisions',apiKey:key,fetch:async()=>Response.json(value)}).run(image,new AbortController().signal),{code:'invalid_result'});
});
test('invalid models, credentials and routing are refused without echoing configuration',()=>{
 for(const config of [{kind:'decisions',apiKey:key,model:'other'},{kind:'openai-json',apiKey:key,model:'sk-not-a-model'},{kind:'decisions',apiKey:''},{kind:'qwen-json',apiKey:key,model:'qwen3-vl-plus',workspaceId:'../../private',region:'cn-beijing'}])assert.throws(()=>createClassroomVisionCandidate(config as Parameters<typeof createClassroomVisionCandidate>[0]),{code:'invalid_config'});
});
