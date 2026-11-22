import {pathToFileURL} from 'node:url';
import {createClassroomVisionCandidate,VisionCandidateError,type VisionCandidateKind} from '../lib/server/classroom-vision-candidates';
import {loadVisionEvaluationDataset,evaluateClassroomVision,VisionEvaluationError} from '../lib/server/classroom-vision-evaluation';

const kinds:VisionCandidateKind[]=['decisions','openai-json','qwen-json'];
const usage='node --import tsx scripts/evaluate-classroom-vision.ts --manifest <local.json> --candidate decisions|openai-json|qwen-json [--model <model>] [--region cn-beijing|ap-southeast-1] [--repetitions 1..3] [--live]';
const print=(value:unknown)=>console.log(JSON.stringify(value));

/** Default is validation only; a key on the command line is deliberately unsupported. */
export async function runVisionEvaluationCli(args:string[],env:Record<string,string|undefined>=process.env,write:(value:unknown)=>void=print,signal?:AbortSignal):Promise<number>{
 try{
  if(args.length===0||args.length===1&&args[0]==='--help'){write({usage,default:'dry_run',credentials:'Environment variables only; no secret values in arguments or output.'});return 0;}
  const flags=new Map<string,string>();let live=false;
  for(let index=0;index<args.length;index++){
   const name=args[index];if(name==='--live'){if(live)throw new VisionEvaluationError('invalid_options');live=true;continue;}
   if(!['--manifest','--candidate','--model','--region','--repetitions'].includes(name)||flags.has(name)||!args[index+1]||args[index+1].startsWith('--'))throw new VisionEvaluationError('invalid_options');
   flags.set(name,args[++index]);
  }
  const manifest=flags.get('--manifest'),kind=(flags.get('--candidate')??'decisions') as VisionCandidateKind,repetitions=Number(flags.get('--repetitions')??1);
  if(!manifest||!kinds.includes(kind)||!Number.isSafeInteger(repetitions)||repetitions<1||repetitions>3)throw new VisionEvaluationError('invalid_options');
  const data=await loadVisionEvaluationDataset(manifest);
  const model=flags.get('--model'),region=flags.get('--region');
  if(kind==='qwen-json'&&(!model||!['cn-beijing','ap-southeast-1'].includes(region??''))||kind!=='qwen-json'&&region)throw new VisionEvaluationError('invalid_options');
  const routing=kind==='qwen-json'?{workspaceId:'dry-run-workspace',region:region as 'cn-beijing'|'ap-southeast-1'}:{};
  if(!live){createClassroomVisionCandidate({kind,model,apiKey:'dry-run-placeholder',...routing});write({...await evaluateClassroomVision(data,{repetitions}),candidate:kind});return 0;}
  const names=kind==='qwen-json'?['DASHSCOPE_API_KEY','DASHSCOPE_WORKSPACE_ID']:['OPENAI_API_KEY'];
  const missing=names.filter(name=>!env[name]);if(missing.length){write({status:'unavailable',code:'missing_credentials',missing});return 2;}
  const candidate=createClassroomVisionCandidate({kind,apiKey:env[names[0]]!,model,...(kind==='qwen-json'?{workspaceId:env.DASHSCOPE_WORKSPACE_ID,region:region as 'cn-beijing'|'ap-southeast-1'}:{})});
  const result=await evaluateClassroomVision(data,{live:true,candidate,repetitions,signal});write(result);
  return result.status==='cancelled'?130:result.status!=='dry_run'&&result.failed>0?1:0;
 }catch(caught){write({status:'unavailable',code:caught instanceof VisionEvaluationError||caught instanceof VisionCandidateError?caught.code:'unavailable'});return 2;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const controller=new AbortController(),cancel=()=>controller.abort();process.once('SIGINT',cancel);
 try{process.exitCode=await runVisionEvaluationCli(process.argv.slice(2),process.env,print,controller.signal);}
 finally{process.removeListener('SIGINT',cancel);}
}
