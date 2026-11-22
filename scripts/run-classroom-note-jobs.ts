import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {ClassroomNoteJobs} from '../lib/server/classroom-note-jobs';
type Jobs=Pick<ClassroomNoteJobs,'runOne'>;
export function parseClassroomNoteWorkerArgs(args:string[]):{once:boolean}|null{
 return args.length===0?{once:false}:args.length===1&&args[0]==='--once'?{once:true}:null;
}
function waitForPoll(signal?:AbortSignal):Promise<void>{return new Promise(resolve=>{
 if(signal?.aborted){resolve();return;}
 const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
 const timer=setTimeout(finish,1000);signal?.addEventListener('abort',finish,{once:true});
});}
export async function runClassroomNoteWorker(jobs:Jobs,options:{once:boolean;signal?:AbortSignal;wait?:(signal?:AbortSignal)=>Promise<void>}):Promise<{processed:number;succeeded:number}>{
 let processed=0,succeeded=0;
 while(!options.signal?.aborted){
  const status=await jobs.runOne(options.signal);if(status!=='empty')processed++;if(status==='succeeded')succeeded++;
  if(options.once||options.signal?.aborted)break;await(options.wait??waitForPoll)(options.signal);
 }
 return{processed,succeeded};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const args=parseClassroomNoteWorkerArgs(process.argv.slice(2));
 if(!args){console.error('Usage: node --import tsx scripts/run-classroom-note-jobs.ts [--once]');process.exitCode=1;}
 else if(!process.env.DATABASE_URL){console.error('Classroom note worker configuration is incomplete.');process.exitCode=1;}
 else{
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:5000,query_timeout:5000,statement_timeout:5000});pool.on('error',()=>{});
  const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{const result=await runClassroomNoteWorker(new ClassroomNoteJobs(pool),{...args,signal:controller.signal});console.log(`Classroom note worker stopped. Processed: ${result.processed}; succeeded: ${result.succeeded}.`);}
  catch{console.error('Classroom note worker failed. Check database availability and migrations.');process.exitCode=1;}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await pool.end();}
 }
}
