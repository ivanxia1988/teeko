import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {Pool} from 'pg';
import WebSocket from 'ws';
import {CLASSROOM_VOICE_ERRORS} from '../../lib/classroom-voice-errors';
import {DEFAULT_TEACHER_AGENT,type TeacherAgentInput} from '../../lib/teacher-agent';
import {buildTeacherInstructions} from '../../lib/teacher-instructions';
import {AdminService,initializeTeacherAgents} from '../../lib/server/admin-service';
import {ClassroomService,DEFAULT_CLASSROOM_PREFERENCES} from '../../lib/server/classroom-service';
import {attachClassroomSockets,type VoiceLease} from '../../lib/server/classroom-sockets';
import {publishTrialCourses} from '../../lib/server/course-catalog';
import {refreshClassroom} from '../../lib/server/classroom-events';
import {closeTeachingLiveResources} from './classroom-teaching-live-cleanup';

type FailureCode='configuration_required'|'database_guard'|'fixture_failure'|'audio_fixture_unavailable'|'bounded_deadline'|'connection_closed'|'startup_incomplete'|'native_call_missing'|'native_tool_unconfirmed'|'continuation_missing'|'speech_start_missing'|'asr_missing'|'audio_missing';
type SafeCode=FailureCode|keyof typeof CLASSROOM_VOICE_ERRORS|'none';
type ResultStatus='not_observed'|'confirmed'|'rejected'|'unavailable'|'other';
const resultStatus=(value:unknown):ResultStatus=>value==='confirmed'||value==='rejected'||value==='unavailable'?value:'other';
class ProbeFailure extends Error{constructor(readonly code:FailureCode){super('Synthetic Grok live check failed.');}}
const check=(value:unknown,code:FailureCode):void=>{if(!value)throw new ProbeFailure(code);};
const grokModelId='20000000-0000-4000-8000-000000000006';
const nativeRequest='Please highlight the apple on this page.';
const adultPhrase='I would like apples for our picnic.';
const migrations=['0001_accounts.sql','0002_classrooms.sql','0003_teacher_agents.sql','0004_admin_auth.sql','0005_model_credentials.sql','0006_classroom_journal.sql','0007_classroom_notes.sql','0008_grok_credentials.sql'];
function disposableDatabase(value:string|undefined):string{
 try{
  if(!value)throw new Error();const url=new URL(value);
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^\/[A-Za-z0-9_]*test[A-Za-z0-9_]*$/.test(url.pathname)||url.search||url.hash)throw new Error();
  return value;
 }catch{throw new ProbeFailure('database_guard');}
}
function json(raw:string):Record<string,unknown>|null{
 try{const value:unknown=JSON.parse(raw);return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}catch{return null;}
}

test('real Grok classroom native tools and adult synthetic speech with isolated PG and a simulated audio sink',{skip:process.env.TEEKO_SYNTHETIC_GROK_LIVE!=='true',timeout:90000},async t=>{
 const started=performance.now(),deadline=Date.now()+55000,abort=new AbortController();
 const summary={provider:'grok' as const,input:'fixed_typed_then_local_adult_speech' as const,browserSink:'simulated' as const,applicationFallback:'disabled_for_native_probe' as const,outcome:'failed' as 'passed'|'failed',stage:'configuration' as 'configuration'|'setup'|'migrations'|'catalog'|'accounts'|'publish'|'create_classroom'|'listen'|'greeting'|'native_tools'|'adult_audio',safeErrorCode:'none' as SafeCode,ready:false,audioFrames:0,teacherFinals:0,nativeCalls:0,nativeExecutions:0,nativeResultStatus:'not_observed' as ResultStatus,providerResultStatus:'not_observed' as ResultStatus,confirmedTools:0,otherTools:0,functionOutputs:0,confirmedOutputs:0,continuationRequests:0,continuationResponses:0,continuationAudioFrames:0,speechStarts:0,asrFinals:0,asrMatched:false,adultResponseAudioFrames:0,adultDownstreamAudioFrames:0,transportErrors:0,cleanupComplete:false};
 let directory:string|undefined,schemaRequested=false,closed=false,lastAudioAt=0,playbackEndsAt=0;
 let continuationPending=false,continuationActive=false,adultStarted=false,adultResponseSeen=false,adultResponseActive=false,responseActive=false;
 let administrator:Pool|undefined,pool:Pool|undefined,controller:ReturnType<typeof attachClassroomSockets>|undefined,client:WebSocket|undefined;
 const server=createServer(),upstreams=new Set<WebSocket>(),nativeCallIds=new Set<string>();
 const schema=`grok_voice_test_${randomUUID().replaceAll('-','')}`;
 let timer:ReturnType<typeof setTimeout>;
 const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{abort.abort();client?.terminate();for(const upstream of upstreams)upstream.terminate();reject(new ProbeFailure('bounded_deadline'));},55000);});
 const available=()=>{if(abort.signal.aborted||t.signal.aborted||Date.now()>=deadline)throw new ProbeFailure('bounded_deadline');};
 const sleep=async(milliseconds:number)=>{available();await new Promise<void>(resolve=>setTimeout(resolve,milliseconds));available();};
 const wait=async(predicate:()=>boolean,code:FailureCode,limit=deadline)=>{
  while(!predicate()){available();if(closed)throw new ProbeFailure('connection_closed');if(Date.now()>=Math.min(limit,deadline))throw new ProbeFailure(code);await sleep(20);}
 };
 t.after(async()=>{
  clearTimeout(timer);abort.abort();
  try{
   await closeTeachingLiveResources([
    async()=>{client?.terminate();for(const upstream of upstreams)upstream.terminate();},
    async()=>{await controller?.close();},
    async()=>{if(server.listening){const stopped=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeAllConnections();await stopped;}},
    async()=>{await pool?.end();},async()=>{if(schemaRequested)await administrator?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);},async()=>{await administrator?.end();},
    async()=>{if(directory)await rm(directory,{recursive:true,force:true});},
   ]);summary.cleanupComplete=true;
  }catch{summary.outcome='failed';summary.safeErrorCode='fixture_failure';throw new Error('Synthetic Grok fixture cleanup incomplete.');}
  finally{console.log(`TEEKO_SYNTHETIC_GROK_SUMMARY ${JSON.stringify({...summary,elapsedMs:Math.round(performance.now()-started)})}`);}
 });
 try{
  await Promise.race([(async()=>{
  const database=disposableDatabase(process.env.TEST_DATABASE_URL),key=process.env.XAI_API_KEY;
  check(typeof key==='string'&&key.trim().length>0,'configuration_required');check(process.platform==='darwin','audio_fixture_unavailable');
  summary.stage='setup';directory=await mkdtemp(join(tmpdir(),'teeko-grok-adult-'));
  const aiff=join(directory,'adult.aiff'),environment:NodeJS.ProcessEnv={PATH:process.env.PATH??'/usr/bin:/bin',NODE_ENV:'test'};
  let pcm:Buffer;
  try{
   await promisify(execFile)('/usr/bin/say',['-v','Samantha','-r','160','-o',aiff,adultPhrase],{env:environment,timeout:6000,signal:abort.signal});
   const generated=await promisify(execFile)('ffmpeg',['-hide_banner','-loglevel','error','-i',aiff,'-f','s16le','-ac','1','-ar','24000','pipe:1'],{env:environment,timeout:6000,maxBuffer:480000,encoding:'buffer',signal:abort.signal});
   pcm=generated.stdout;check(pcm.length>=4800&&pcm.length<=480000&&pcm.length%2===0,'audio_fixture_unavailable');
  }catch{throw new ProbeFailure('audio_fixture_unavailable');}
  finally{await rm(directory,{recursive:true,force:true});directory=undefined;}
  available();administrator=new Pool({connectionString:database,max:1,connectionTimeoutMillis:3000,query_timeout:3000});
  pool=new Pool({connectionString:database,options:`-c search_path=${schema},public`,max:4,connectionTimeoutMillis:3000,query_timeout:3000});
  for(const value of [administrator,pool])value.on('error',()=>{summary.safeErrorCode='fixture_failure';});
  summary.stage='migrations';schemaRequested=true;await administrator.query(`CREATE SCHEMA ${schema}`);
  for(const name of migrations){available();await pool.query(await readFile(new URL(`../../db/migrations/${name}`,import.meta.url),'utf8'));}
  summary.stage='catalog';available();await publishTrialCourses(pool);available();await initializeTeacherAgents(pool);available();
  summary.stage='accounts';const owner=randomUUID(),operator=randomUUID();
  for(const id of [owner,operator]){available();await pool.query("INSERT INTO teeko_accounts(id,email,password_hash,consent_version,consented_at,created_at) VALUES($1,$2,'synthetic','fixture',now(),now())",[id,`${id}@example.test`]);}
  available();
  await pool.query("INSERT INTO teeko_profiles(account_id,name,age_range,level,updated_at) VALUES($1,'Synthetic adult','10–11','starter',now())",[owner]);
  available();const settings=new AdminService(pool);await settings.grantAdmin(operator);available();
  summary.stage='publish';const input:TeacherAgentInput={...structuredClone(DEFAULT_TEACHER_AGENT),name:'Synthetic adult Grok voice probe',routes:{qwen:{realtimeModelId:null,reasoningModelId:null},openai:{realtimeModelId:null,reasoningModelId:null,visionModelId:null},grok:{realtimeModelId:grokModelId,reasoningModelId:null}}};
  const agent=await settings.createAgent(operator,input);available();await settings.publishAgent(operator,agent.id,agent.revision);available();
  const service=new ClassroomService(pool,{maxSeconds:80,dailySeconds:160});
  summary.stage='create_classroom';const created=await service.create(owner,'picnic',{...DEFAULT_CLASSROOM_PREFERENCES,provider:'grok',language:'english',soundEffects:false});
  available();controller=attachClassroomSockets(server,{origin:'http://localhost:8080',heartbeatMs:1000,startupMs:12000,connectionProbeMs:60000,connect:(url,headers)=>{
   available();
   check(url==='wss://api.x.ai/v1/realtime?model=grok-voice-3.0','configuration_required');
   const upstream=new WebSocket(url,{headers,maxPayload:512000,handshakeTimeout:10000,perMessageDeflate:false});upstreams.add(upstream);upstream.on('error',()=>{});upstream.on('close',()=>upstreams.delete(upstream));
   const send=upstream.send;
   upstream.send=((...args:unknown[])=>{
    const event=typeof args[0]==='string'?json(args[0]):null,item=event?.item as Record<string,unknown>|undefined;
    if(event?.type==='conversation.item.create'&&item?.type==='function_call_output'&&typeof item.call_id==='string'&&nativeCallIds.has(item.call_id)){
     summary.functionOutputs++;const result=typeof item.output==='string'?json(item.output):null;summary.providerResultStatus=resultStatus(result?.status);
     if(result?.status==='confirmed'){summary.confirmedOutputs++;continuationPending=true;}
    }
    if(event?.type==='response.create'&&continuationPending)summary.continuationRequests++;
    Reflect.apply(send,upstream,args);
   }) as WebSocket['send'];
   upstream.on('message',raw=>{
    const event=json(raw.toString());if(!event)return;
    if(event.type==='response.function_call_arguments.done'&&event.name==='highlight_objects'&&typeof event.call_id==='string'){
     if(event.call_id.length<=200&&nativeCallIds.size<250){nativeCallIds.add(event.call_id);summary.nativeCalls++;}
    }else if(event.type==='response.created'){
     responseActive=true;if(continuationPending&&summary.continuationRequests>0){continuationPending=false;continuationActive=true;summary.continuationResponses++;}
     if(adultStarted&&summary.speechStarts>0){adultResponseSeen=true;adultResponseActive=true;}
    }else if(event.type==='response.done'){responseActive=false;continuationActive=false;adultResponseActive=false;}
    else if(event.type==='input_audio_buffer.speech_started'&&adultStarted)summary.speechStarts++;
    else if(['response.output_audio.delta','response.audio.delta'].includes(String(event.type))){if(continuationActive)summary.continuationAudioFrames++;if(adultResponseActive)summary.adultResponseAudioFrames++;}
   });return upstream;
  },open:async(_request,id)=>{
   check(id===created.id,'fixture_failure');available();const lease=await service.claim(owner,created.id),teacher=await service.teacherRuntime(owner,created.id);available();
   check(teacher.config?.routes.grok?.realtime.model==='grok-voice-3.0','configuration_required');
   const value:VoiceLease={id:created.id,epoch:lease.epoch,provider:'grok',snapshot:lease.snapshot,remainingMs:Math.min(60000,deadline-Date.now()),model:'grok-voice-3.0',voice:'eve',configuration:{key:key!,model:'grok-voice-3.0',voice:'eve'},instructions:buildTeacherInstructions(lease.snapshot,teacher.config,teacher.state),initialCue:'This is an adult synthetic integration check. Say only Hello, then wait quietly for the learner. Do not invoke any tool yet.',
    started:sessionId=>service.providerStarted(owner,created.id,lease.epoch,lease.ownerToken,sessionId),
    heartbeat:async()=>{const snapshot=await service.heartbeat(owner,created.id,lease.epoch,lease.ownerToken);if(!snapshot)return null;const teacher=await service.teacherRuntime(owner,created.id);return{snapshot,instructions:buildTeacherInstructions(snapshot,teacher.config,teacher.state)};},
    // Isolate the native protocol probe: persist actual transcripts without the application fallback executing the same highlight first.
    transcript:async event=>{await service.transcript(owner,created.id,lease.epoch,lease.ownerToken,event);if(event.role==='teacher'&&event.final)summary.teacherFinals++;if(event.role==='child'&&event.source==='speech'&&event.final){summary.asrFinals++;summary.asrMatched=/\bapples?\b.*\bpicnic\b/i.test(event.text);}},
    tool:async(name,args,callId,request)=>{
     if(name!=='highlight_objects'||!callId||!nativeCallIds.has(callId)||request?.source!=='teacher'){summary.otherTools++;throw new ProbeFailure('native_tool_unconfirmed');}
     summary.nativeExecutions++;const result=await service.tool(owner,created.id,lease.epoch,lease.ownerToken,name,args,async()=>true,{actor:'teacher',callId,request});summary.nativeResultStatus=resultStatus(result.output.status);
     if(result.output.status==='confirmed')summary.confirmedTools++;await refreshClassroom(created.id);return result;
    },journal:entry=>service.journal(owner,created.id,lease.epoch,lease.ownerToken,entry).then(()=>{}),closed:()=>service.release(owner,created.id,lease.epoch,lease.ownerToken),
   };return value;
  }});
  summary.stage='listen';server.on('error',()=>{summary.safeErrorCode='fixture_failure';});
  await new Promise<void>((resolve,reject)=>{server.once('error',()=>reject(new ProbeFailure('fixture_failure')));server.listen(0,'127.0.0.1',resolve);});
  available();const address=server.address();if(!address||typeof address==='string')throw new ProbeFailure('fixture_failure');
  client=new WebSocket(`ws://127.0.0.1:${address.port}/ws/classrooms/${created.id}`,{headers:{Origin:'http://localhost:8080',Cookie:`teeko_session=${'t'.repeat(43)}`},handshakeTimeout:10000});
  client.on('error',()=>{summary.transportErrors++;});client.on('close',()=>{closed=true;});
  client.on('message',raw=>{
   const event=json(raw.toString());if(!event)return;
   if(event.type==='ready')summary.ready=true;
   else if(event.type==='audio'&&typeof event.audio==='string'){summary.audioFrames++;if(adultResponseSeen)summary.adultDownstreamAudioFrames++;lastAudioAt=Date.now();playbackEndsAt=Math.max(Date.now(),playbackEndsAt)+Buffer.byteLength(event.audio,'base64')/48;}
   else if(event.type==='interrupt')playbackEndsAt=Date.now();
   else if(event.type==='error'){summary.transportErrors++;summary.safeErrorCode=typeof event.code==='string'&&Object.hasOwn(CLASSROOM_VOICE_ERRORS,event.code)?event.code as keyof typeof CLASSROOM_VOICE_ERRORS:'transport_error';}
  });
  const send=(event:unknown)=>{available();if(client?.readyState!==WebSocket.OPEN)throw new ProbeFailure('connection_closed');client.send(JSON.stringify(event));};
  const quiet=()=>!responseActive&&Date.now()>=playbackEndsAt&&Date.now()-lastAudioAt>=350;
  summary.stage='greeting';await wait(()=>summary.ready&&summary.teacherFinals>0&&summary.audioFrames>0&&quiet(),'startup_incomplete',Date.now()+15000);
  summary.stage='native_tools';send({type:'text',text:nativeRequest});
  await wait(()=>summary.nativeCalls>0,'native_call_missing',Date.now()+15000);
  await wait(()=>summary.confirmedTools>0&&summary.confirmedOutputs>0,'native_tool_unconfirmed',Date.now()+7000);
  await wait(()=>summary.continuationResponses>0&&summary.continuationAudioFrames>0&&quiet(),'continuation_missing',Date.now()+10000);
  const highlighted=await service.get(owner,created.id);check(highlighted.teacherObjectIds.includes('apple'),'native_tool_unconfirmed');check(highlighted.outcomes.length===0,'native_tool_unconfirmed');
  summary.stage='adult_audio';adultStarted=true;
  for(let offset=0;offset<pcm.length;offset+=4800){const frame=Buffer.alloc(4800);pcm.copy(frame,0,offset,Math.min(offset+4800,pcm.length));send({type:'audio',audio:frame.toString('base64')});await sleep(100);}
  for(let index=0;index<14;index++){send({type:'audio',audio:Buffer.alloc(4800).toString('base64')});await sleep(100);}
  await wait(()=>summary.speechStarts>0,'speech_start_missing',Date.now()+7000);
  await wait(()=>summary.asrFinals>0&&summary.asrMatched,'asr_missing',Date.now()+7000);
  await wait(()=>summary.adultResponseAudioFrames>0&&summary.adultDownstreamAudioFrames>0&&quiet(),'audio_missing',Date.now()+10000);
  check(summary.transportErrors===0&&summary.safeErrorCode==='none','connection_closed');summary.outcome='passed';
  })(),timeout]);
 }catch(error){summary.outcome='failed';if(summary.safeErrorCode==='none')summary.safeErrorCode=error instanceof ProbeFailure?error.code:'fixture_failure';throw new Error('Synthetic Grok live check failed; inspect the fixed diagnostic summary.');}
});
