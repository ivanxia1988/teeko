import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Pool} from 'pg';
import WebSocket from 'ws';
import {ClassroomChalkReader} from '../../lib/server/classroom-chalk-reader';
import {ClassroomService} from '../../lib/server/classroom-service';
import {publishTrialCourses} from '../../lib/server/course-catalog';
import {attachClassroomSockets,type VoiceLease} from '../../lib/server/classroom-sockets';
import {refreshClassroom} from '../../lib/server/classroom-events';
import {buildTeacherInstructions,buildTeacherGuidance} from '../../lib/teacher-instructions';
import {teacherConfig} from '../teacher-runtime-fixture';
import {syntheticTeachingHelpAudio,teachingAudioFrames} from './classroom-teaching-synthetic-audio';
import {closeTeachingLiveResources} from './classroom-teaching-live-cleanup';

test('real Qwen classroom teaching tools with synthetic sources and a simulated browser sink',{skip:process.env.TEEKO_SYNTHETIC_CLASSROOM_LIVE!=='true',timeout:45000},async t=>{
 const focus=process.env.TEEKO_SYNTHETIC_TEACHING_FOCUS??'all';assert(['all','review','chalk_voice','chalk_application_voice'].includes(focus),'Unsupported synthetic check focus.');
 const applicationChalk=focus==='chalk_application_voice';
 const database=process.env.TEST_DATABASE_URL;if(!database)throw new Error('Disposable test database required.');
 let address:URL;try{address=new URL(database);}catch{throw new Error('Loopback disposable test database required.');}
 if(!['127.0.0.1','localhost','[::1]'].includes(address.hostname)||!/test/.test(address.pathname))throw new Error('Loopback disposable test database required.');
 const key=process.env.DASHSCOPE_API_KEY,workspaceId=process.env.DASHSCOPE_WORKSPACE_ID;if(!key||!workspaceId)throw new Error('Qwen configuration incomplete.');
 const admin=new Pool({connectionString:database,max:1,connectionTimeoutMillis:5000,query_timeout:5000}),schema=`teaching_live_test_${randomUUID().replaceAll('-','')}`;
 const pool=new Pool({connectionString:database,options:`-c search_path=${schema},public`,max:8,connectionTimeoutMillis:5000,query_timeout:5000});let schemaCreated=false;
 const server=createServer(),resources:{client?:WebSocket;controller?:ReturnType<typeof attachClassroomSockets>}={};
 const timers=new Set<ReturnType<typeof setTimeout>>();let silenceTimer:ReturnType<typeof setInterval>|undefined;
 t.after(async()=>{if(silenceTimer)clearInterval(silenceTimer);for(const timer of timers)clearTimeout(timer);await closeTeachingLiveResources([
  async()=>{resources.client?.terminate();},async()=>resources.controller?.close(),
  async()=>{if(server.listening){const stopped=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeAllConnections();await stopped;}},
  ()=>pool.end(),async()=>{if(schemaCreated)await admin.query(`DROP SCHEMA ${schema} CASCADE`);},()=>admin.end(),
 ]);});
 await admin.query(`CREATE SCHEMA ${schema}`);schemaCreated=true;
 for(const name of ['0001_accounts.sql','0002_classrooms.sql','0003_teacher_agents.sql','0006_classroom_journal.sql','0007_classroom_notes.sql'])await pool.query(await readFile(new URL(`../../db/migrations/${name}`,import.meta.url),'utf8'));
 await publishTrialCourses(pool);const owner=randomUUID();
 await pool.query("INSERT INTO teeko_accounts(id,email,password_hash,consent_version,consented_at,created_at) VALUES($1,$2,'synthetic','v1',now(),now())",[owner,`${owner}@example.test`]);await pool.query("INSERT INTO teeko_profiles(account_id,name,age_range,level,updated_at) VALUES($1,'Synthetic learner','10–11','starter',now())",[owner]);
 const service=new ClassroomService(pool,{maxSeconds:90,dailySeconds:180,assess:async()=>({decision:'retry',confidence:'high',reason:'Synthetic fixed assessment',suggestedResponse:'I like apples.',nextAction:'model'})});
 const created=await service.create(owner,'picnic'),first=await service.claim(owner,created.id);await service.action(owner,created.id,{eventId:randomUUID(),expectedRevision:first.snapshot.revision,type:'select',objectIds:['apple']});await pool.query('UPDATE teeko_classrooms SET teacher_config=$2 WHERE id=$1',[created.id,JSON.stringify(teacherConfig)]);
 for(let i=0;i<(applicationChalk?0:2);i++)await service.receiveTranscript(owner,created.id,first.epoch,first.ownerToken,{role:'child',source:'typed',text:'I still need help saying this.',itemId:`synthetic-source-${i}`,final:true,contextKey:`${created.id}:${first.epoch}:1`});
 await service.release(owner,created.id,first.epoch,first.ownerToken);
 const helpAudio=focus==='chalk_voice'||applicationChalk?await syntheticTeachingHelpAudio(applicationChalk?'application':'native'):null;
 const counts={playbackProbes:0,playbackQuietReceipts:0,privateChalkCandidateReturned:false,applicationChalkRequests:0,chalkProposalAudioFrames:0,chalkProposalTextCompleted:false,helpVoiceFinals:0,helpVoiceMatched:false,ready:false,teacherAudioFrames:0,teacherTextSegments:0,secondHelpTurnSent:false,reviewPromptSent:false,functionDoneTotal:0,chalkNativeProposals:0,reviewNativeProposals:0,otherNativeProposals:0,otherFunctionEvents:0,chalkRejectedBeforeExecution:0,chalkDisplayRejections:0,reviewRejectedBeforeExecution:0,chalkRequests:0,chalkApplicationAccepted:0,chalkOffers:0,chalkDisplayed:0,chalkDisplayConfirmed:0,reviewRequests:0,reviewReferences:0,reviewSourcePresent:false,applicationReviewRequests:0,reviewTeacherSourceGenerated:false,reviewAudioFrames:0,safeTransportErrors:0};
 const chalkInvalidations:Record<string,number>={},rejectionCodes:Record<string,number>={},safeCodes=new Set(['stale_tool_request','cancelled_tool_request','invalid_tool_request','invalid_tool_context','expired_tool_request','tool_queue_full','unsupported_tool','chalk_scope_unverified','chalk_oral_reference_missing','chalk_oral_reference_stale','chalk_oral_text_missing','chalk_oral_audio_missing','chalk_playback_or_display_unconfirmed']);
 let proposalAudioFrames=0,proposalTextCompleted=false;
 const startedAt=Date.now(),deadline=startedAt+35000;let currentPlaybackId=0,playbackEndsAt=Date.now(),lastAudioAt=0,closed=false;
 const output=()=>console.log(`TEEKO_SYNTHETIC_SUMMARY ${JSON.stringify({provider:'qwen',focus,input:helpAudio?'synthetic_typed_then_local_adult_speech':'synthetic_typed',browserSink:'simulated',...counts,rejectionCodes,chalkInvalidations,elapsedMs:Date.now()-startedAt})}`);
 t.after(output);
 resources.controller=attachClassroomSockets(server,{origin:'http://localhost:8080',heartbeatMs:1000,startupMs:15000,connectionProbeMs:60000,connect:(url,headers)=>{
  const socket=new WebSocket(url,{headers,maxPayload:512000,handshakeTimeout:15000,perMessageDeflate:false});
  socket.on('message',raw=>{try{const event=JSON.parse(raw.toString());if(event.type==='response.created'){proposalAudioFrames=0;proposalTextCompleted=false;}else if(event.type==='response.audio.delta')proposalAudioFrames++;else if(event.type==='response.audio_transcript.done')proposalTextCompleted=true;if(event.type==='response.function_call_arguments.done'){counts.functionDoneTotal++;if(event.name==='chalk_write'){counts.chalkNativeProposals++;counts.chalkProposalAudioFrames=proposalAudioFrames;counts.chalkProposalTextCompleted=proposalTextCompleted;}else if(event.name==='review_lesson_notes')counts.reviewNativeProposals++;else counts.otherNativeProposals++;}else if(typeof event.type==='string'&&event.type.includes('function_call'))counts.otherFunctionEvents++;}catch{/* Diagnostic counts never change protocol behavior. */}});return socket;
 },open:async()=>{
  const lease=await service.claim(owner,created.id),teacher=await service.teacherRuntime(owner,created.id);
  const chalkReader=new ClassroomChalkReader((snapshot,signal)=>service.readChalkCandidate(owner,created.id,lease.epoch,lease.ownerToken,snapshot,signal));
  const instructions=()=>buildTeacherInstructions(lease.snapshot,teacher.config,teacher.state);
  const value:VoiceLease={id:created.id,epoch:lease.epoch,provider:'qwen',snapshot:lease.snapshot,instructions:instructions(),initialCue:'For this synthetic integration check say only Hello, then wait. Do not invoke tools yet.',remainingMs:80000,voice:teacher.config?.voices.qwen.female,model:teacher.config?.routes.qwen?.realtime.model,
   configuration:{key,workspaceId,model:process.env.QWEN_REALTIME_MODEL||'qwen3.8-omni-flash-realtime',voice:teacher.config?.voices.qwen.female||'Jennifer',region:process.env.DASHSCOPE_REGION||'cn-beijing'},
   started:sessionId=>service.providerStarted(owner,created.id,lease.epoch,lease.ownerToken,sessionId),
   heartbeat:async()=>{const snapshot=await service.heartbeat(owner,created.id,lease.epoch,lease.ownerToken);if(!snapshot)return null;const current=await service.teacherRuntime(owner,created.id);const chalk=applicationChalk?chalkReader.peek(snapshot):null;if(chalk)counts.privateChalkCandidateReturned=true;return{snapshot,instructions:buildTeacherInstructions(snapshot,current.config,current.state),teachingGuidance:buildTeacherGuidance(snapshot,current.config,current.state),...(chalk?{chalk}:{})};},
   transcript:async event=>{if(event.role==='child'&&event.source==='speech'&&event.final){counts.helpVoiceFinals++;if(/(?:still.*understand|write.*example)/iu.test(event.text))counts.helpVoiceMatched=true;}if(event.role==='teacher'){counts.teacherTextSegments++;if(counts.reviewReferences>0&&/\bI like apples\b/i.test(event.text))counts.reviewTeacherSourceGenerated=true;}await service.transcript(owner,created.id,lease.epoch,lease.ownerToken,event);if(event.role==='child'&&event.final)void service.receiveTranscript(owner,created.id,lease.epoch,lease.ownerToken,event).then(()=>refreshClassroom(created.id)).catch(()=>{});},
   tool:async(name,args,callId,request)=>{if(name==='chalk_write'){counts.chalkRequests++;if(request?.source==='application')counts.applicationChalkRequests++;}if(name==='review_lesson_notes')counts.reviewRequests++;if(name==='delegate'&&request?.source==='application')counts.applicationReviewRequests++;const result=await service.tool(owner,created.id,lease.epoch,lease.ownerToken,name,args,async()=>true,{actor:'teacher',callId,request});if(name==='chalk_write'&&result.output.status==='reference')counts.chalkApplicationAccepted++;if((name==='review_lesson_notes'||name==='delegate'&&request?.source==='application')&&result.output.status==='reference'){counts.reviewReferences++;counts.reviewSourcePresent=!!result.output.english?.includes('I like apples.');}await refreshClassroom(created.id);return result;},
   journal:entry=>{if(entry.kind==='tool'&&entry.name==='chalk_write'&&entry.status==='confirmed'&&entry.eventKey.endsWith(':display-result'))counts.chalkDisplayConfirmed++;if(entry.kind==='tool'&&entry.status==='rejected'){if(entry.name==='chalk_write'){if(entry.eventKey.endsWith(':display-result')){counts.chalkDisplayRejections++;const state=entry.details?.state;if(typeof state==='string'&&['response_unbound','response_started','playback_cleared','context_changed','learner_final','learner_audio','closed'].includes(state))chalkInvalidations[state]=(chalkInvalidations[state]??0)+1;}else counts.chalkRejectedBeforeExecution++;}if(entry.name==='review_lesson_notes')counts.reviewRejectedBeforeExecution++;const rawCode=entry.details?.errorCode;if(typeof rawCode==='string'){const code=safeCodes.has(rawCode)?rawCode:'other_safe_code';rejectionCodes[code]=(rejectionCodes[code]??0)+1;}}return service.journal(owner,created.id,lease.epoch,lease.ownerToken,entry).then(()=>{});},closed:()=>{chalkReader.close();return service.release(owner,created.id,lease.epoch,lease.ownerToken);},
  };return value;
 }});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const socketAddress=server.address();assert(socketAddress&&typeof socketAddress!=='string');
 const client=resources.client=new WebSocket(`ws://127.0.0.1:${socketAddress.port}/ws/classrooms/${created.id}`,{headers:{Origin:'http://localhost:8080',Cookie:`teeko_session=${'t'.repeat(43)}`}});client.on('error',()=>{});client.on('close',()=>{closed=true;});
 const send=(message:unknown)=>{if(client?.readyState===WebSocket.OPEN)client.send(JSON.stringify(message));};
 client.on('message',raw=>{const event=JSON.parse(raw.toString()) as Record<string,unknown>;
  if(event.type==='ready')counts.ready=true;
  else if(event.type==='audio'){counts.teacherAudioFrames++;if(counts.reviewReferences>0)counts.reviewAudioFrames++;lastAudioAt=Date.now();currentPlaybackId=Number(event.playbackId);playbackEndsAt=Math.max(Date.now(),playbackEndsAt)+Buffer.byteLength(String(event.audio),'base64')/48;}
  else if(event.type==='interrupt'){playbackEndsAt=Date.now();currentPlaybackId=Number(event.playbackId);}
  else if(event.type==='playback.probe'){counts.playbackProbes++;const id=event.id,delay=Math.max(0,playbackEndsAt-Date.now());const timer=setTimeout(()=>{timers.delete(timer);counts.playbackQuietReceipts++;send({type:'playback.state',probeId:id,playbackId:currentPlaybackId,running:true,audiblePending:false});},delay);timers.add(timer);}
  else if(event.type==='chalk.offer'){counts.chalkOffers++;send({type:'chalk.ready',id:event.id});}
  else if(event.type==='chalk.commit'){counts.chalkDisplayed++;send({type:'chalk.displayed',id:event.id});}
  else if(event.type==='error')counts.safeTransportErrors++;
 });
 const wait=async(predicate:()=>boolean,limit=deadline)=>{while(!predicate()){if(closed||Date.now()>=Math.min(deadline,limit))throw new Error('Synthetic classroom check did not complete within its bound.');await new Promise(resolve=>setTimeout(resolve,20));}};
 const quiet=()=>Date.now()>=playbackEndsAt&&Date.now()-lastAudioAt>300;
 await once(client,'open');await wait(()=>counts.ready&&counts.teacherTextSegments>0&&quiet());const before=counts.teacherTextSegments;
 if(focus!=='review'){
 send({type:'text',text:'Please explain briefly how to say I like apples.'});await wait(()=>counts.teacherTextSegments>before&&quiet());
 counts.secondHelpTurnSent=true;
 if(helpAudio){for(const frame of teachingAudioFrames(helpAudio)){send({type:'audio',audio:frame.toString('base64')});await new Promise(resolve=>setTimeout(resolve,100));}for(let i=0;i<14;i++){send({type:'audio',audio:Buffer.alloc(3200).toString('base64')});await new Promise(resolve=>setTimeout(resolve,100));}}
 else send({type:'text',text:'I still do not understand. Please write the short example briefly so I can look at it.'});
 if(applicationChalk)silenceTimer=setInterval(()=>send({type:'audio',audio:Buffer.alloc(3200).toString('base64')}),100);
 if(focus==='chalk_voice'||applicationChalk){await wait(()=>counts.chalkDisplayConfirmed>0||counts.safeTransportErrors>0,Date.now()+(applicationChalk?16000:10000));assert(counts.helpVoiceMatched);if(applicationChalk){assert(counts.privateChalkCandidateReturned);assert(counts.applicationChalkRequests>0);}else assert(counts.chalkNativeProposals>0);assert(counts.chalkApplicationAccepted>0);assert(counts.chalkDisplayed>0);assert(counts.chalkDisplayConfirmed>0);assert.equal(counts.safeTransportErrors,0);return;}
 await wait(()=>counts.chalkRequests>0||counts.safeTransportErrors>0,Date.now()+10000).catch(()=>{});await wait(quiet,Date.now()+4000).catch(()=>{});
 }
 counts.reviewPromptSent=true;send({type:'text',text:'Can we review this lesson?'});await wait(()=>counts.reviewReferences>0||counts.safeTransportErrors>0,Date.now()+10000);
 if(focus==='all'){assert(counts.chalkApplicationAccepted>0);assert(counts.chalkDisplayed>0);}
 else await wait(()=>counts.reviewTeacherSourceGenerated&&counts.reviewAudioFrames>0,Date.now()+10000);
 assert(counts.reviewSourcePresent);assert.equal(counts.safeTransportErrors,0);
});
