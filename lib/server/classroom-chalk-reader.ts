import type {ClassroomSnapshot} from '../classroom-contract';
import {captureClassroomToolState} from '../classroom-tool-state';
import {validateClassroomContext} from '../domain/classroom-context';
import type {ClassroomChalkCandidate} from './classroom-chalk-candidate';

type Source=(snapshot:ClassroomSnapshot,signal:AbortSignal)=>Promise<ClassroomChalkCandidate|null>;
/** Optional reads never sit on the required lease-heartbeat path. */
export class ClassroomChalkReader{
 private readonly now:()=>number;
 private readonly budgetMs:number;
 private closed=false;
 private key:string|null=null;
 private pending:{key:string;controller:AbortController;timer:ReturnType<typeof setTimeout>}|undefined;
 private cached:{key:string;at:number;value:ClassroomChalkCandidate|null}|undefined;
 constructor(private readonly source:Source,options:{now?:()=>number;budgetMs?:number}={}){
  this.now=options.now??Date.now;this.budgetMs=options.budgetMs??250;
  if(!Number.isSafeInteger(this.budgetMs)||this.budgetMs<1||this.budgetMs>1000)throw new Error('Invalid optional read budget.');
 }
 peek(snapshot:ClassroomSnapshot):ClassroomChalkCandidate|null{
  if(this.closed)return null;
  const captured=captureClassroomToolState(snapshot),key=captured.ok&&captured.snapshot.status==='active'?JSON.stringify(captured.snapshot.context):null;
  this.key=key;
  if(this.pending&&this.pending.key!==key){clearTimeout(this.pending.timer);this.pending.controller.abort();}
  if(!key){this.cached=undefined;return null;}
  const age=this.cached?this.now()-this.cached.at:Infinity;
  if(this.cached?.key===key&&age>=0&&age<5000)return this.cached.value;
  this.cached=undefined;
  if(!this.pending&&captured.ok){
   const controller=new AbortController(),pending={key,controller,timer:setTimeout(()=>controller.abort(),this.budgetMs)};
   this.pending=pending;
   void Promise.resolve().then(()=>controller.signal.aborted?null:this.source(snapshot,controller.signal)).then(value=>{
    if(!this.closed&&!controller.signal.aborted&&this.key===key)this.cached={key,at:this.now(),value:value&&validateClassroomContext(captured.snapshot,value.context).accepted?value:null};
   }).catch(()=>{}).finally(()=>{clearTimeout(pending.timer);if(this.pending===pending)this.pending=undefined;});
  }
  return null;
 }
 close(){this.closed=true;this.cached=undefined;if(this.pending){clearTimeout(this.pending.timer);this.pending.controller.abort();this.pending=undefined;}}
}
