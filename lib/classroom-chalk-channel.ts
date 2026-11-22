import {z} from 'zod';
import {ClassroomChalkBoard,validateClassroomChalkWriting,type ClassroomChalkWriting} from './domain/classroom-chalk';
import {classroomTaskContextSchema,validateClassroomContext} from './domain/classroom-context';

const id=z.string().uuid(),milliseconds=z.number().int().positive().safe().max(20000);
const offerSchema=z.object({type:z.literal('chalk.offer'),id,context:classroomTaskContextSchema,text:z.string().min(1).max(120),displayMs:milliseconds.min(2000)}).strict().readonly();
const commitSchema=z.object({type:z.literal('chalk.commit'),id,remainingMs:milliseconds}).strict().readonly();
const clearSchema=z.object({type:z.literal('chalk.clear'),id}).strict().readonly();
const readySchema=z.object({type:z.literal('chalk.ready'),id}).strict().readonly();
const displayedSchema=z.object({type:z.literal('chalk.displayed'),id}).strict().readonly();
type Offer=z.infer<typeof offerSchema>;
type Common={current():unknown;now?:()=>number;send(message:unknown):boolean};
const WAIT_MS=1000;
class Clock{
 private last=-Infinity;
 constructor(private readonly now:()=>number){}
 read(){let value:number;try{value=this.now();}catch{return NaN;}if(!Number.isSafeInteger(value)||value<0||value<this.last)return NaN;this.last=value;return value;}
}
function current(options:Common){try{return options.current();}catch{return null;}}
function send(options:Common,message:unknown){try{return options.send(message);}catch{return false;}}

type Active={writing:ClassroomChalkWriting;phase:'offered'|'committed'|'displayed';waitUntilMs:number;resolve:((value:'displayed'|'unavailable')=>void)|null;wait:ReturnType<typeof setTimeout>;expiry:ReturnType<typeof setTimeout>};
/** Connection-local transport owner. A browser receipt is reported display, never learning evidence. */
export class ClassroomChalkServerChannel{
 private readonly clock:Clock;
 private readonly board:ClassroomChalkBoard;
 private active:Active|null=null;
 private closed=false;
 constructor(private readonly options:Common){this.clock=new Clock(options.now??Date.now);this.board=new ClassroomChalkBoard(()=>this.clock.read());}
 offer(input:unknown):Promise<'displayed'|'unavailable'>{
  if(this.closed)return Promise.resolve('unavailable');
  this.contextChanged();const checked=this.board.write(current(this.options),input);
  if(!checked.accepted)return Promise.resolve('unavailable');
  const now=this.clock.read();if(!Number.isSafeInteger(now)||!validateClassroomChalkWriting(current(this.options),checked.writing,now).accepted){this.cancel();return Promise.resolve('unavailable');}
  this.withdraw(false);
  return new Promise(resolve=>{
   const writing=checked.writing;
   const wait=setTimeout(()=>this.cancel(),WAIT_MS),expiry=setTimeout(()=>this.cancel(),Math.max(0,writing.expiresAtMs-now));
   this.active={writing,phase:'offered',waitUntilMs:now+WAIT_MS,resolve,wait,expiry};
   if(!send(this.options,{type:'chalk.offer',id:writing.id,context:writing.context,text:writing.text,displayMs:writing.expiresAtMs-writing.receivedAtMs}))this.cancel();
  });
 }
 receive(input:unknown):boolean{
  if(this.closed)return false;
  const ready=readySchema.safeParse(input),displayed=displayedSchema.safeParse(input);
  if(!ready.success&&!displayed.success)return false;
  this.contextChanged();const active=this.active,message=ready.success?ready.data:displayed.success?displayed.data:null;
  if(!active||active.writing.id!==message?.id)return false;
  const now=this.clock.read();
  if(!Number.isSafeInteger(now)||active.phase!=='displayed'&&now>=active.waitUntilMs){this.cancel();return false;}
  if(ready.success&&active.phase==='offered'){
   const remainingMs=active.writing.expiresAtMs-now;
   if(!Number.isSafeInteger(remainingMs)||remainingMs<=0){this.cancel();return false;}
   active.phase='committed';active.waitUntilMs=now+WAIT_MS;clearTimeout(active.wait);active.wait=setTimeout(()=>this.cancel(),WAIT_MS);
   if(!send(this.options,{type:'chalk.commit',id:active.writing.id,remainingMs})){this.cancel();return false;}
   return true;
  }
  if(displayed.success&&active.phase==='committed'){
   active.phase='displayed';clearTimeout(active.wait);active.resolve?.('displayed');active.resolve=null;return true;
  }
  return false;
 }
 contextChanged(){if(this.active&&!this.board.read(current(this.options)))this.cancel();}
 private withdraw(clearBoard=true){
  const active=this.active;this.active=null;if(clearBoard)this.board.clear();
  if(!active)return;clearTimeout(active.wait);clearTimeout(active.expiry);active.resolve?.('unavailable');
  send(this.options,{type:'chalk.clear',id:active.writing.id});
 }
 isDisplayed(id:string){this.contextChanged();return this.active?.phase==='displayed'&&this.active.writing.id===id;}
 cancelPending(){if(this.active?.phase!=='displayed')this.cancel();}
 cancel(){this.withdraw();}
 close(){if(this.closed)return;this.cancel();this.closed=true;this.board.close();}
}

/** Clock conversion deducts the complete local ready/commit round trip; it never renews a late message. */
export class ClassroomChalkClientChannel{
 private readonly clock:Clock;
 private readonly board:ClassroomChalkBoard;
 private readonly seen=new Set<string>();
 private pending:{offer:Offer;readyAt:number}|null=null;
 private visibleId:string|null=null;
 private acknowledged=false;
 private closed=false;
 constructor(private readonly options:Common&{onWriting(writing:ClassroomChalkWriting|null):void}){this.clock=new Clock(options.now??Date.now);this.board=new ClassroomChalkBoard(()=>this.clock.read());}
 receive(input:unknown):boolean{
  if(this.closed)return false;
  this.contextChanged();
  const offer=offerSchema.safeParse(input);
  if(offer.success){
   const value=offer.data,now=this.clock.read();
   const checked=validateClassroomChalkWriting(current(this.options),{type:'chalk.write',id:value.id,context:value.context,text:value.text,receivedAtMs:now,expiresAtMs:now+value.displayMs},now);
   if(!checked.accepted||this.seen.has(value.id)||this.seen.size>=250)return false;
   this.cancel();this.seen.add(value.id);this.pending={offer:value,readyAt:now};
   if(!send(this.options,{type:'chalk.ready',id:value.id})){this.cancel();return false;}return true;
  }
  const clear=clearSchema.safeParse(input);
  if(clear.success){if(clear.data.id!==this.pending?.offer.id&&clear.data.id!==this.visibleId)return false;this.cancel();return true;}
  const commit=commitSchema.safeParse(input),pending=this.pending;
  if(!commit.success||!pending||pending.offer.id!==commit.data.id)return false;
  this.pending=null;const now=this.clock.read(),elapsed=now-pending.readyAt;
  if(!Number.isSafeInteger(elapsed)||elapsed<0||elapsed>=WAIT_MS||commit.data.remainingMs>pending.offer.displayMs)return false;
  const expiresAtMs=pending.readyAt+commit.data.remainingMs;
  const checked=this.board.write(current(this.options),{type:'chalk.write',id:pending.offer.id,context:pending.offer.context,text:pending.offer.text,receivedAtMs:expiresAtMs-pending.offer.displayMs,expiresAtMs});
  if(!checked.accepted)return false;
  this.visibleId=checked.writing.id;this.acknowledged=false;
  try{this.options.onWriting(checked.writing);}catch{this.cancel();return false;}return true;
 }
 displayed(id:string):boolean{
  if(this.closed||this.acknowledged||id!==this.visibleId)return false;
  const writing=this.board.read(current(this.options));if(!writing||writing.id!==id){this.cancel();return false;}
  this.acknowledged=true;if(!send(this.options,{type:'chalk.displayed',id})){this.cancel();return false;}return true;
 }
 contextChanged(){
  if(this.closed)return;
  const now=this.clock.read();
  if(!Number.isSafeInteger(now)){this.cancel();return;}
  if(this.pending&&(!validateClassroomContext(current(this.options),this.pending.offer.context).accepted||now-this.pending.readyAt>=WAIT_MS))this.pending=null;
  if(this.visibleId&&!this.board.read(current(this.options)))this.cancel();
 }
 expired(id:string){if(id===this.visibleId)this.cancel();}
 cancel(){this.pending=null;this.board.clear();if(this.visibleId){this.visibleId=null;this.acknowledged=false;try{this.options.onWriting(null);}catch{/* A failed view callback cannot retain an active transport proposal. */}}}
 close(){if(this.closed)return;this.cancel();this.closed=true;this.seen.clear();this.board.close();}
}
