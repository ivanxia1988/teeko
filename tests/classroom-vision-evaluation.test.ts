import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,symlink,rm,mkdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {runVisionEvaluationCli} from '../scripts/evaluate-classroom-vision';
import {join} from 'node:path';
import {loadVisionEvaluationDataset,evaluateClassroomVision} from '../lib/server/classroom-vision-evaluation';
import {VisionCandidateError,VISION_OBJECT_CATEGORIES,type VisionCandidate,type VisionCandidateRun} from '../lib/server/classroom-vision-candidates';

const jpeg=Buffer.from([255,216,255,192,0,11,8,0,240,1,64,1,1,17,0,255,217]);
const labels={scene_clear:true,person_visible:false,object_held:false,held_object:'none'};
async function dataset(t:{after:(cleanup:()=>Promise<void>)=>void}){
 const directory=await mkdtemp(join(tmpdir(),'teeko-vision-eval-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await writeFile(join(directory,'sample.jpg'),jpeg);const path=join(directory,'manifest.json');
 const manifest={kind:'synthetic_smoke',cases:[{id:'sample',file:'sample.jpg',labels}]};await writeFile(path,JSON.stringify(manifest));
 return {directory,path,manifest,save:()=>writeFile(path,JSON.stringify(manifest))};
}
function run():VisionCandidateRun{return {kind:'decisions',model:'gpt-6-luna',probabilityKind:'native_decision',status:'completed',durationMs:20,facts:{scene_clear:.8,person_visible:.1,object_held:.1,held_object:{choice:'none',confidence:.9,probabilities:VISION_OBJECT_CATEGORIES.map(value=>({value,probability:value==='none'?.9:value==='unclear'?.1:0}))}},usage:{inputTokens:100,outputTokens:0,cachedInputTokens:10,cacheWriteInputTokens:5}};}
function candidate(handler:()=>Promise<VisionCandidateRun>):VisionCandidate{return {kind:'decisions',model:'gpt-6-luna',run:handler};}

test('default evaluation validates samples and produces a dry-run without any network call',async t=>{
 const f=await dataset(t),data=await loadVisionEvaluationDataset(f.path);let calls=0;
 const result=await evaluateClassroomVision(data,{candidate:candidate(async()=>{calls++;return run();})});
 assert.equal(result.status,'dry_run');assert.equal(result.requestCount,1);assert.equal(result.caseCount,1);assert.equal(calls,0);
 assert(!JSON.stringify(result).includes(jpeg.toString('base64')));assert(!JSON.stringify(result).includes(f.directory));
});
test('explicit live evaluation measures usage, Brier error and coverage with no product threshold',async t=>{
 const f=await dataset(t),data=await loadVisionEvaluationDataset(f.path);let calls=0,now=0;
 const result=await evaluateClassroomVision(data,{live:true,repetitions:2,now:()=>now,candidate:candidate(async()=>{calls++;now+=25;return run();})});
 assert.equal(result.status,'measured');
 assert.equal(calls,2);assert.equal(result.probabilityKind,'native_decision');assert.deepEqual(result.resolvedModels,['gpt-6-luna']);assert.equal(result.attempted,2);assert.equal(result.usage.inputTokens,200);assert.equal(result.latencyMs.successful.p95,20);
 assert.equal(result.quality.predicates.scene_clear.labeled,2);assert.equal(result.quality.predicates.scene_clear.answered,2);assert(Math.abs(result.quality.predicates.scene_clear.brierOnAnswered!-.04)<1e-9);
 assert.equal(result.quality.heldObject.correct,2);assert.equal(result.quality.heldObject.coverage,1);assert.equal(result.estimateUsd,null);
 assert.equal(result.quality.scope,'synthetic_workflow_only');
});
test('refusals retain the labeled denominator and are never counted as correct negatives',async t=>{
 const f=await dataset(t),data=await loadVisionEvaluationDataset(f.path),value=run();value.status='refused';value.facts={scene_clear:null,person_visible:null,object_held:null,held_object:null};
 const result=await evaluateClassroomVision(data,{live:true,candidate:candidate(async()=>value)});assert.notEqual(result.status,'dry_run');if(result.status==='dry_run')return;
 assert.equal(result.refused,1);assert.equal(result.quality.predicates.person_visible.labeled,1);assert.equal(result.quality.predicates.person_visible.answered,0);assert.equal(result.quality.predicates.person_visible.brierOnAnswered,null);
 assert.equal(result.quality.heldObject.coverage,0);assert.equal(result.quality.heldObject.accuracyOnAnswered,null);
});
test('failed requests produce safe counts, incomplete usage and no invented cost',async t=>{
 const f=await dataset(t),data=await loadVisionEvaluationDataset(f.path);let calls=0;
 const result=await evaluateClassroomVision(data,{live:true,repetitions:2,candidate:candidate(async()=>{if(++calls===1)return run();throw new Error('PRIVATE_PROVIDER_BODY');})});if(result.status==='dry_run')return;
 assert.equal(result.failed,1);assert.equal(result.completed,1);assert.equal(result.usage.complete,false);assert.equal(result.estimateUsd,null);assert(!JSON.stringify(result).includes('PRIVATE'));
 assert.equal(result.quality.predicates.person_visible.labeled,2);assert.equal(result.quality.predicates.person_visible.answered,1);
});
test('caller cancellation stops further requests and preserves already measured usage',async t=>{
 const f=await dataset(t),data=await loadVisionEvaluationDataset(f.path),controller=new AbortController();let calls=0;
 const result=await evaluateClassroomVision(data,{live:true,repetitions:3,signal:controller.signal,candidate:candidate(async()=>{calls++;controller.abort();return run();})});if(result.status==='dry_run')return;
 assert.equal(result.status,'cancelled');assert.equal(calls,1);assert.equal(result.attempted,1);assert.equal(result.usage.inputTokens,100);assert.equal(result.usage.complete,false);
});
test('price estimates require explicit rates and complete cache usage',async t=>{
 const f=await dataset(t);const pricing={inputPerMillionUsd:.1,outputPerMillionUsd:0,cachedInputPerMillionUsd:.01,cacheWriteInputPerMillionUsd:.2};
 await writeFile(f.path,JSON.stringify({...f.manifest,pricing}));const data=await loadVisionEvaluationDataset(f.path);
 const measured=await evaluateClassroomVision(data,{live:true,candidate:candidate(async()=>run())});if(measured.status==='dry_run')return;
 assert(Math.abs(measured.estimateUsd!-(85*.1+10*.01+5*.2)/1_000_000)<1e-12);
 const value=run();value.usage.cacheWriteInputTokens=null;const partial=await evaluateClassroomVision(data,{live:true,candidate:candidate(async()=>value)});if(partial.status==='dry_run')return;assert.equal(partial.estimateUsd,null);
});
test('manifests reject escaped, remote, public, duplicate and symlink samples before requests',async t=>{
 const f=await dataset(t);await symlink(join(f.directory,'sample.jpg'),join(f.directory,'linked.jpg'));await mkdir(join(f.directory,'public'));await writeFile(join(f.directory,'public','sample.jpg'),jpeg);
 for(const file of ['../sample.jpg','https://example.com/photo.jpg','linked.jpg','public/sample.jpg']){
  f.manifest.cases[0].file=file;await f.save();await assert.rejects(()=>loadVisionEvaluationDataset(f.path));
 }
 f.manifest.cases[0].file='sample.jpg';f.manifest.cases.push({...f.manifest.cases[0],id:'duplicate'});await f.save();await assert.rejects(()=>loadVisionEvaluationDataset(f.path));
});
test('invalid sample data, labels and excessive repetition cannot reach a candidate',async t=>{
 const f=await dataset(t);await writeFile(join(f.directory,'sample.jpg'),'not JPEG');await assert.rejects(()=>loadVisionEvaluationDataset(f.path),{code:'invalid_sample'});
 await writeFile(join(f.directory,'sample.jpg'),jpeg);await writeFile(f.path,JSON.stringify({...f.manifest,cases:[{...f.manifest.cases[0],labels:{...labels,attention:true}}]}));await assert.rejects(()=>loadVisionEvaluationDataset(f.path),{code:'invalid_manifest'});
 await f.save();const data=await loadVisionEvaluationDataset(f.path);let calls=0;
 await assert.rejects(()=>evaluateClassroomVision(data,{live:true,repetitions:100,candidate:candidate(async()=>{calls++;return run();})}),{code:'invalid_options'});assert.equal(calls,0);
 await assert.rejects(()=>evaluateClassroomVision(data,{live:true}),{code:'missing_candidate'});
});
test('known candidate error codes are counted without raw messages',async t=>{
 const f=await dataset(t),data=await loadVisionEvaluationDataset(f.path);const result=await evaluateClassroomVision(data,{live:true,candidate:candidate(async()=>{throw new VisionCandidateError('timeout');})});if(result.status==='dry_run')return;
 assert.equal(result.errors.timeout,1);assert.equal(result.failed,1);
});

test('CLI dry-run does not require credentials or output sample contents',async t=>{
 const f=await dataset(t),output:unknown[]=[];const code=await runVisionEvaluationCli(['--manifest',f.path,'--candidate','decisions'],new Proxy({},{get(){assert.fail('Dry-run must not read credentials.');}}),value=>output.push(value));
 assert.equal(code,0);assert.equal((output[0] as {status:string}).status,'dry_run');assert(!JSON.stringify(output).includes(jpeg.toString('base64')));assert(!JSON.stringify(output).includes(f.directory));
});
test('CLI live preflight names missing environment variables without making a request',async t=>{
 const f=await dataset(t),output:unknown[]=[];const code=await runVisionEvaluationCli(['--manifest',f.path,'--candidate','decisions','--live'],{},value=>output.push(value));
 assert.equal(code,2);assert.deepEqual(output,[{status:'unavailable',code:'missing_credentials',missing:['OPENAI_API_KEY']}]);
});
test('CLI unknown or credential-bearing flags are rejected without echoing their values',async()=>{
 const output:unknown[]=[];const code=await runVisionEvaluationCli(['--api-key','PRIVATE_NEVER_ECHO'],{},value=>output.push(value));
 assert.equal(code,2);assert(!JSON.stringify(output).includes('PRIVATE_NEVER_ECHO'));
});

test('dry-run also rejects incomplete or unsupported candidate parameters',async t=>{
 const f=await dataset(t);
 for(const args of [['--candidate','qwen-json'],['--candidate','decisions','--model','unsupported']]){
  const output:unknown[]=[];assert.equal(await runVisionEvaluationCli(['--manifest',f.path,...args],{},v=>output.push(v)),2);assert.equal((output[0] as {status:string}).status,'unavailable');
 }
});

test('FIFO manifests and samples are rejected without waiting for a writer',async t=>{
 const f=await dataset(t);
 for(const mode of ['manifest','sample'] as const){
  const fifo=join(f.directory,mode==='manifest'?'fifo.json':'fifo.jpg');assert.equal(spawnSync('mkfifo',[fifo]).status,0);
  if(mode==='sample'){f.manifest.cases[0].file='fifo.jpg';await f.save();}
  const pending=loadVisionEvaluationDataset(mode==='manifest'?fifo:f.path).then(()=>({code:'accepted'}),error=>({code:error.code as string}));
  let timer:ReturnType<typeof setTimeout>|undefined;
  const outcome=await Promise.race([pending,new Promise<{code:string}>(resolve=>{timer=setTimeout(()=>resolve({code:'blocked'}),2000);})]);if(timer)clearTimeout(timer);
  // Release an old implementation's blocked open so a red run leaves no live descriptor or test process.
  if(outcome.code==='blocked'){const writer=await open(fifo,constants.O_WRONLY|constants.O_NONBLOCK);await writer.close();await pending;}
  assert.notEqual(outcome.code,'blocked');assert.notEqual(outcome.code,'accepted');
 }
});

test('unsafe aggregate token totals remain unknown and never produce a cost estimate',async t=>{
 const f=await dataset(t);await writeFile(f.path,JSON.stringify({...f.manifest,pricing:{inputPerMillionUsd:.1,outputPerMillionUsd:0,cachedInputPerMillionUsd:0,cacheWriteInputPerMillionUsd:0}}));
 const data=await loadVisionEvaluationDataset(f.path);let calls=0;
 const result=await evaluateClassroomVision(data,{live:true,repetitions:3,candidate:candidate(async()=>{const value=run();value.usage={inputTokens:++calls===1?Number.MAX_SAFE_INTEGER:1,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0};return value;})});
 assert.notEqual(result.status,'dry_run');if(result.status==='dry_run')return;
 assert.equal(result.usage.complete,false);assert.equal(result.usage.inputTokens,null);assert.equal(result.estimateUsd,null);
});

test('unknown cache-write counts only permit a price estimate when their monetary effect cancels exactly',async t=>{
 const f=await dataset(t);await writeFile(f.path,JSON.stringify({...f.manifest,pricing:{inputPerMillionUsd:.1,outputPerMillionUsd:0,cachedInputPerMillionUsd:.01,cacheWriteInputPerMillionUsd:.1}}));
 const data=await loadVisionEvaluationDataset(f.path),value=run();value.usage.cacheWriteInputTokens=null;
 const result=await evaluateClassroomVision(data,{live:true,candidate:candidate(async()=>value)});if(result.status==='dry_run')return;
 assert.equal(result.usage.cacheWriteInputTokens,null);assert(Math.abs(result.estimateUsd!-(90*.1+10*.01)/1_000_000)<1e-12);
});

test('valid free cache groups never produce a negative floating-point fee',async t=>{
 const f=await dataset(t);await writeFile(f.path,JSON.stringify({...f.manifest,pricing:{inputPerMillionUsd:.1,outputPerMillionUsd:0,cachedInputPerMillionUsd:0,cacheWriteInputPerMillionUsd:0}}));
 const data=await loadVisionEvaluationDataset(f.path),value=run();value.usage={inputTokens:9,outputTokens:0,cachedInputTokens:6,cacheWriteInputTokens:3};
 const result=await evaluateClassroomVision(data,{live:true,candidate:candidate(async()=>value)});if(result.status==='dry_run')return;assert.equal(result.estimateUsd,0);
});
