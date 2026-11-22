import test from 'node:test';
import assert from 'node:assert/strict';
import {createGrokProtocol,grokEndpoint} from '../lib/voice-providers/grok';
const decode=(value:ReturnType<ReturnType<typeof createGrokProtocol>['commands']>)=>value.map(raw=>JSON.parse(String(raw)));
test('Grok uses its own fixed-version endpoint and explicit PCM and transcription configuration',()=>{
 assert.equal(grokEndpoint(),'wss://api.x.ai/v1/realtime?model=grok-voice-3.0');assert.throws(()=>grokEndpoint('grok-voice-latest'));
 const p=createGrokProtocol({voice:'ara'}),[configure]=decode(p.commands({type:'configure',instructions:'Synthetic classroom rules.',tools:[]}));assert.equal(p.id,'grok');assert.equal(p.inputSampleRate,24000);assert.equal(p.outputSampleRate,24000);assert.equal(configure.session.voice,'ara');assert.deepEqual(configure.session.audio.input,{format:{type:'audio/pcm',rate:24000},transcription:{model:'grok-transcribe'}});assert.deepEqual(configure.session.turn_detection,{type:'server_vad'});assert(!JSON.stringify(configure).includes('apiKey'));
});
test('Grok text is an actual user item and its tools remain flat native functions',()=>{
 const p=createGrokProtocol();const [configure]=decode(p.commands({type:'configure',instructions:'Current task.',tools:[{type:'function',name:'inspect_current_page',description:'Read known page',parameters:{type:'object'}}]}));assert.equal(configure.session.tools[0].name,'inspect_current_page');assert.equal(configure.session.tools[0].function,undefined);
 const typed=decode(p.commands({type:'user_text',text:'Hello teacher.'}));assert.deepEqual(typed.map(e=>e.type),['session.update','conversation.item.create','response.create']);assert.equal(typed[1].item.role,'user');assert.equal(typed[1].item.content[0].text,'Hello teacher.');
 const cue=decode(p.commands({type:'speak',text:'A brief useful example.'}));assert.deepEqual(cue.map(e=>e.type),['session.update','response.create']);assert.match(cue[0].session.instructions,/Current task/);
 const result=decode(p.commands({type:'tool_result',callId:'native-call',output:'{"status":"unavailable"}'}));assert.equal(result[0].item.call_id,'native-call');assert.equal(result[0].item.type,'function_call_output');
});
test('Grok accepts current and compatibility audio/transcript names without treating generated text as playback',()=>{
 const p=createGrokProtocol();for(const type of ['response.output_audio.delta','response.audio.delta'])assert.deepEqual(p.parse({type,delta:'AAAAAA=='}),[{type:'audio',audio:'AAAAAA==',sampleRate:24000}]);
 assert.deepEqual(p.parse({type:'conversation.item.input_audio_transcription.completed',item_id:'child-1',transcript:'An apple.'}),[{type:'transcript',role:'child',text:'An apple.',final:true,replace:true,itemId:'child-1'}]);assert.equal(p.parse({type:'response.output_audio_transcript.done',item_id:'teacher-1',transcript:'Try your own example.'})[0]?.type,'transcript');assert.deepEqual(p.parse({type:'response.output_text.delta',delta:'not an audio transcript'}),[]);
 for(const delta of ['','invalid--base64',1])assert.deepEqual(p.parse({type:'response.output_audio.delta',delta}),[]);
});
test('Grok cancellation and terminal errors are bounded and never expose provider details',()=>{
 const p=createGrokProtocol();assert.deepEqual(p.commands({type:'cancel'}),[]);p.parse({type:'response.created',response:{id:'reply-1'}});assert.deepEqual(decode(p.commands({type:'cancel'})),[{type:'response.cancel'}]);assert.deepEqual(p.commands({type:'cancel'}),[]);assert.deepEqual(p.parse({type:'response.done',response:{status:'cancelled'}}),[{type:'response_done'}]);
 const failure=p.parse({type:'response.done',response:{status:'failed',status_details:{error:{message:'PRIVATE_RAW_DETAIL'}}}});assert.equal(failure[0].type,'error');assert(!JSON.stringify(failure).includes('PRIVATE_RAW_DETAIL'));assert(!JSON.stringify(p.parse({type:'error',error:{message:'PRIVATE_RAW_DETAIL'}})).includes('PRIVATE_RAW_DETAIL'));
});
