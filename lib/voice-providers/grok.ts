import {jsonEvent,type VoiceCommand,type VoiceEvent,type VoiceProtocol,type VoiceProtocolOptions,type VoiceTool} from './types';

export const GROK_VOICE_MODEL='grok-voice-3.0';
export function grokEndpoint(model=GROK_VOICE_MODEL):string{
 if(model!==GROK_VOICE_MODEL)throw new Error('Grok实时模型配置不受支持。');
 return `wss://api.x.ai/v1/realtime?model=${GROK_VOICE_MODEL}`;
}
const text=(value:unknown,max=6000):value is string=>typeof value==='string'&&value.length<=max;
const audio=(value:unknown):value is string=>text(value,256000)&&value.length>0&&value.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(value);
const failure=():VoiceEvent=>({type:'error',code:'grok_error',message:'Grok实时语音暂时不可用，请重新连接。'});

/** Native Grok Speech to Speech; credentials and optional web tools never enter its payload. */
export function createGrokProtocol(options:VoiceProtocolOptions={}):VoiceProtocol{
 grokEndpoint(options.model);
 const voice=options.voice??'eve';if(!['eve','ara','rex','leo'].includes(voice))throw new Error('Grok声音配置不受支持。');
 let instructions='',responseActive=false;const tools:VoiceTool[]=[];
 const encode=(events:unknown[])=>events.map(event=>JSON.stringify(event));
 const update=(value:string)=>({type:'session.update',session:{instructions:value}});
 const cancel=()=>{if(!responseActive)return[];responseActive=false;return[{type:'response.cancel'}];};
 return{
  id:'grok',inputSampleRate:24000,outputSampleRate:24000,frameMs:100,
  commands(command:VoiceCommand){switch(command.type){
   case'configure':instructions=command.instructions;tools.splice(0,tools.length,...command.tools);return encode([{type:'session.update',session:{voice,instructions,turn_detection:{type:'server_vad'},audio:{input:{format:{type:'audio/pcm',rate:24000},transcription:{model:'grok-transcribe'}},output:{format:{type:'audio/pcm',rate:24000}}},tools:tools.map(tool=>({type:'function',name:tool.name,description:tool.description,parameters:tool.parameters}))}}]);
   case'context':instructions=command.instructions;return encode([update(instructions)]);
   case'speak':return encode([...cancel(),update(`${instructions}\n\nApplication teaching cue: continue briefly using this reference. Do not claim an action succeeded without confirmation.\n${JSON.stringify(command.text)}`),{type:'response.create'}]);
   case'user_text':return encode([...cancel(),update(instructions),{type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:command.text}]}},{type:'response.create'}]);
   case'audio':return audio(command.audio)?encode([{type:'input_audio_buffer.append',audio:command.audio}]):[];
   case'commit':return encode([{type:'input_audio_buffer.commit'},{type:'response.create'}]);
   case'cancel':return encode(cancel());
   case'tool_result':return encode([{type:'conversation.item.create',item:{type:'function_call_output',call_id:command.callId,output:command.output}},{type:'response.create'}]);
   case'close':case'mute':return[];
  }},
  parse(raw:unknown):VoiceEvent[]{
   const event=jsonEvent(raw);if(!event||typeof event.type!=='string')return[];
   const item=()=>text(event.item_id,200)?{itemId:event.item_id}:{};
   switch(event.type){
    case'session.created':return[{type:'session_created',...(text(event.session?.id,200)?{sessionId:event.session.id}:{})}];
    case'session.updated':return[{type:'configured'}];
    case'input_audio_buffer.speech_started':return[{type:'speech_start'}];
    case'input_audio_buffer.speech_stopped':return[{type:'speech_end'}];
    case'response.created':responseActive=true;return[{type:'response_start'}];
    case'response.done':responseActive=false;return event.response?.status==='failed'?[failure(),{type:'response_done'}]:[{type:'response_done'}];
    case'conversation.item.input_audio_transcription.completed':return text(event.transcript)?[{type:'transcript',role:'child',text:event.transcript,final:true,replace:true,...item()}]:[];
    case'response.output_audio_transcript.delta':case'response.audio_transcript.delta':return text(event.delta)?[{type:'transcript',role:'teacher',text:event.delta,final:false,...item()}]:[];
    case'response.output_audio_transcript.done':case'response.audio_transcript.done':return text(event.transcript)?[{type:'transcript',role:'teacher',text:event.transcript,final:true,replace:true,...item()}]:[];
    case'response.output_audio.delta':case'response.audio.delta':return audio(event.delta)?[{type:'audio',audio:event.delta,sampleRate:24000}]:[];
    case'response.function_call_arguments.done':return text(event.call_id,200)&&text(event.name,120)&&text(event.arguments,10000)?[{type:'tool',callId:event.call_id,name:event.name,arguments:event.arguments}]:[];
    case'error':case'conversation.item.input_audio_transcription.failed':return[failure()];
    default:return[];
   }
  },
 };
}
