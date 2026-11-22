import {constants} from 'node:fs';
import {open,realpath,lstat} from 'node:fs/promises';
import {dirname,resolve,relative,isAbsolute,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {decodeClassroomVisionJpeg} from './classroom-vision-session';
import {VISION_OBJECT_CATEGORIES,VisionCandidateError,type VisionCandidate,type VisionCandidateRun} from './classroom-vision-candidates';

export class VisionEvaluationError extends Error{
 constructor(readonly code:'invalid_manifest'|'invalid_sample'|'invalid_options'|'missing_candidate'){super('Vision evaluation could not be prepared.');this.name='VisionEvaluationError';}
}
const labelsSchema=z.object({scene_clear:z.boolean().nullable(),person_visible:z.boolean().nullable(),object_held:z.boolean().nullable(),held_object:z.enum(VISION_OBJECT_CATEGORIES).nullable()}).strict().readonly();
const rate=z.number().finite().min(0).max(1000);
const pricingSchema=z.object({inputPerMillionUsd:rate,outputPerMillionUsd:rate,cachedInputPerMillionUsd:rate,cacheWriteInputPerMillionUsd:rate}).strict().readonly();
const manifestSchema=z.object({kind:z.enum(['synthetic_smoke','authorized_labeled']),cases:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),file:z.string().min(1).max(255),labels:labelsSchema}).strict().readonly()).min(1).max(40).readonly(),pricing:pricingSchema.optional()}).strict().readonly();
export type VisionEvaluationDataset={kind:z.infer<typeof manifestSchema>['kind'];cases:readonly {id:string;image:string;labels:z.infer<typeof labelsSchema>}[];pricing?:z.infer<typeof pricingSchema>};
const unsafePath=(path:string)=>path.replaceAll('\\','/').split('/').some(part=>['public','.private','.git'].includes(part.toLowerCase())||part==='.env'||part.startsWith('.env.'));
async function boundedFile(path:string,limit:number){
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const stat=await handle.stat();if(!stat.isFile()||stat.size<1||stat.size>limit)throw new VisionEvaluationError('invalid_manifest');
  const buffer=Buffer.alloc(limit+1);let offset=0;
  while(offset<=limit){const {bytesRead}=await handle.read(buffer,offset,limit+1-offset,null);if(!bytesRead)break;offset+=bytesRead;}
  if(offset>limit)throw new VisionEvaluationError('invalid_manifest');return buffer.subarray(0,offset);
 }finally{await handle.close();}
}
/** Load all local samples before permitting any experiment request. No URLs or private/public aliases. */
export async function loadVisionEvaluationDataset(manifestPath:string):Promise<VisionEvaluationDataset>{
 try{
  if(extname(manifestPath).toLowerCase()!=='.json'||unsafePath(resolve(manifestPath))||!(await lstat(manifestPath)).isFile())throw new VisionEvaluationError('invalid_manifest');
  const manifestFile=await realpath(manifestPath);if(unsafePath(manifestFile))throw new VisionEvaluationError('invalid_manifest');
  const parsed=manifestSchema.safeParse(JSON.parse((await boundedFile(manifestFile,65536)).toString('utf8')));if(!parsed.success)throw new VisionEvaluationError('invalid_manifest');
  const manifest=parsed.data,root=dirname(manifestFile),ids=new Set<string>(),images=new Set<string>(),cases:VisionEvaluationDataset['cases'][number][]=[];
  for(const sample of manifest.cases){
   if(ids.has(sample.id)||isAbsolute(sample.file)||sample.file.replaceAll('\\','/').split('/').includes('..')||unsafePath(sample.file)||!/^\.jpe?g$/i.test(extname(sample.file)))throw new VisionEvaluationError('invalid_manifest');
   const requested=resolve(root,sample.file);if(!(await lstat(requested)).isFile())throw new VisionEvaluationError('invalid_manifest');
   const actual=await realpath(requested),within=relative(root,actual);if(isAbsolute(within)||within==='..'||within.startsWith('../')||unsafePath(actual))throw new VisionEvaluationError('invalid_manifest');
   const bytes=await boundedFile(actual,144000),image=bytes.toString('base64');if(!decodeClassroomVisionJpeg(image))throw new VisionEvaluationError('invalid_sample');
   const digest=createHash('sha256').update(bytes).digest('hex');if(images.has(digest))throw new VisionEvaluationError('invalid_manifest');
   ids.add(sample.id);images.add(digest);cases.push(Object.freeze({id:sample.id,image,labels:sample.labels}));
  }
  return Object.freeze({kind:manifest.kind,cases:Object.freeze(cases),...(manifest.pricing?{pricing:manifest.pricing}:{})});
 }catch(caught){throw caught instanceof VisionEvaluationError?caught:new VisionEvaluationError('invalid_manifest');}
}
const predicateNames=['scene_clear','person_visible','object_held'] as const;
const quantiles=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);const at=(q:number)=>sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*q)-1)]:null;return {count:values.length,p50:at(.5),p95:at(.95)};};
type Options={candidate?:VisionCandidate;live?:boolean;repetitions?:number;signal?:AbortSignal;now?:()=>number};
/** Aggregate only. Failed/refused samples remain in the denominator; no product decision threshold. */
export async function evaluateClassroomVision(dataset:VisionEvaluationDataset,options:Options={}){
 const repetitions=options.repetitions??1;
 if(!Number.isSafeInteger(repetitions)||repetitions<1||repetitions>3||dataset.cases.length<1||dataset.cases.length>40)throw new VisionEvaluationError('invalid_options');
 const requestCount=dataset.cases.length*repetitions,base={datasetKind:dataset.kind,caseCount:dataset.cases.length,requestCount};
 if(!options.live)return {status:'dry_run' as const,...base,networkRequests:0};
 const candidate=options.candidate;if(!candidate)throw new VisionEvaluationError('missing_candidate');
 const signal=options.signal??new AbortController().signal,now=options.now??(()=>performance.now());
 let attempted=0,completed=0,partial=0,refused=0,failed=0,usageOverflow=false;
 let inputTokens:number|null=0,outputTokens:number|null=0;
 let cachedInputTokens:number|null=0,cacheWriteInputTokens:number|null=0;
 const addTokens=(left:number|null,right:number|null)=>{if(left===null||right===null)return null;const sum=left+right;if(!Number.isSafeInteger(left)||left<0||!Number.isSafeInteger(right)||right<0||!Number.isSafeInteger(sum)){usageOverflow=true;return null;}return sum;};
 const errors:Partial<Record<VisionCandidateError['code'],number>>={},allDurations:number[]=[],successfulDurations:number[]=[];
 const resolvedModels=new Set<string>();
 const predicates=Object.fromEntries(predicateNames.map(name=>[name,{labeled:0,answered:0,squaredError:0}])) as Record<typeof predicateNames[number],{labeled:number;answered:number;squaredError:number}>;
 const held={labeled:0,answered:0,correct:0};
 for(const sample of dataset.cases){for(let iteration=0;iteration<repetitions;iteration++){
  if(signal.aborted)break;attempted++;
  for(const name of predicateNames)if(sample.labels[name]!==null)predicates[name].labeled++;
  if(sample.labels.held_object!==null)held.labeled++;
  const started=now();let result:VisionCandidateRun;
  try{result=await candidate.run(sample.image,signal);}
  catch(caught){failed++;const code=caught instanceof VisionCandidateError?caught.code:'unavailable';errors[code]=(errors[code]??0)+1;const elapsed=now()-started;if(Number.isFinite(elapsed)&&elapsed>=0)allDurations.push(elapsed);continue;}
  const elapsed=now()-started;if(Number.isFinite(elapsed)&&elapsed>=0)allDurations.push(elapsed);successfulDurations.push(result.durationMs);
  resolvedModels.add(result.model);
  if(result.status==='completed')completed++;else if(result.status==='partial')partial++;else refused++;
  inputTokens=addTokens(inputTokens,result.usage.inputTokens);outputTokens=addTokens(outputTokens,result.usage.outputTokens);
  cachedInputTokens=addTokens(cachedInputTokens,result.usage.cachedInputTokens);
  cacheWriteInputTokens=addTokens(cacheWriteInputTokens,result.usage.cacheWriteInputTokens);
  for(const name of predicateNames){const actual=result.facts[name],expected=sample.labels[name];if(expected!==null&&actual!==null){predicates[name].answered++;predicates[name].squaredError+=(actual-Number(expected))**2;}}
  if(sample.labels.held_object!==null&&result.facts.held_object!==null){held.answered++;if(result.facts.held_object.choice===sample.labels.held_object)held.correct++;}
 }if(signal.aborted)break;}
 const complete=!usageOverflow&&failed===0&&attempted===requestCount,pricing=dataset.pricing;
 const cachePriceKnown=cachedInputTokens!==null||pricing?.cachedInputPerMillionUsd===pricing?.inputPerMillionUsd;
 const writePriceKnown=cacheWriteInputTokens!==null||pricing?.cacheWriteInputPerMillionUsd===pricing?.inputPerMillionUsd;
 // An unknown same-price group stays in ordinary input. Usage still remains null.
 const knownCache=cachedInputTokens??0,knownWrites=cacheWriteInputTokens??0;
 const estimateUsd=complete&&pricing&&inputTokens!==null&&outputTokens!==null&&cachePriceKnown&&writePriceKnown?((inputTokens-knownCache-knownWrites)*pricing.inputPerMillionUsd+knownCache*pricing.cachedInputPerMillionUsd+knownWrites*pricing.cacheWriteInputPerMillionUsd+outputTokens*pricing.outputPerMillionUsd)/1_000_000:null;
 return {status:signal.aborted?'cancelled' as const:'measured' as const,...base,candidate:candidate.kind,model:candidate.model,resolvedModels:[...resolvedModels],probabilityKind:candidate.kind==='decisions'?'native_decision' as const:'model_reported' as const,attempted,completed,partial,refused,failed,errors,
  latencyMs:{all:quantiles(allDurations),successful:quantiles(successfulDurations)},usage:{inputTokens,outputTokens,cachedInputTokens,cacheWriteInputTokens,complete,overflow:usageOverflow},estimateUsd,
  quality:{scope:dataset.kind==='synthetic_smoke'?'synthetic_workflow_only' as const:'provided_labels_only' as const,predicates:Object.fromEntries(predicateNames.map(name=>{const value=predicates[name];return [name,{labeled:value.labeled,answered:value.answered,coverage:value.labeled?value.answered/value.labeled:null,brierOnAnswered:value.answered?value.squaredError/value.answered:null}];})) as Record<typeof predicateNames[number],{labeled:number;answered:number;coverage:number|null;brierOnAnswered:number|null}>,heldObject:{...held,coverage:held.labeled?held.answered/held.labeled:null,accuracyOnAnswered:held.answered?held.correct/held.answered:null}},
 };
}
