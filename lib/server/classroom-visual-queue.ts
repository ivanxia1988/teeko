import {z} from 'zod';
import {classroomTaskContextSchema,validateClassroomContext} from '../domain/classroom-context';

const updateSchema=z.object({
 source:z.enum(['camera','board']),generation:z.number().int().positive().max(2_000_000_000),
 context:classroomTaskContextSchema,receivedAtMs:z.number().int().nonnegative().safe(),expiresAtMs:z.number().int().nonnegative().safe(),
 observation:z.object({visible:z.boolean(),description:z.string().min(1).max(300).refine(value=>Boolean(value.trim()))}).strict().readonly(),first:z.boolean(),
}).strict().refine(value=>value.expiresAtMs>value.receivedAtMs&&value.expiresAtMs-value.receivedAtMs<=8000).readonly();
export type ClassroomVisualUpdate=z.infer<typeof updateSchema>;
export type ClassroomVisualReadiness={foregroundIdle:boolean;childQuiet:boolean;playbackQuiet:boolean};

/** Private, transient observations only. Never serialize this queue to journal or PG. */
export class ClassroomVisualQueue{
 private pending=new Map<ClassroomVisualUpdate['source'],ClassroomVisualUpdate>();
 private published=new Map<ClassroomVisualUpdate['source'],string>();
 private closed=false;private lastNow=-Infinity;
 constructor(private readonly now:()=>number=Date.now){}
 get size(){return this.pending.size;}
 private time(){const now=this.now();if(!Number.isSafeInteger(now)||now<0||now<this.lastNow)return null;this.lastNow=now;return now;}
 private signature(value:ClassroomVisualUpdate){return JSON.stringify([value.generation,value.context,value.observation]);}
 offer(current:unknown,input:unknown):boolean{
  if(this.closed)return false;
  const parsed=updateSchema.safeParse(input);if(!parsed.success)return false;
  const value=parsed.data,now=this.time();
  if(now===null||value.receivedAtMs>now||now>=value.expiresAtMs||!validateClassroomContext(current,value.context).accepted)return false;
  if(this.published.get(value.source)===this.signature(value)){this.pending.delete(value.source);return false;}
  const previous=this.pending.get(value.source);
  const first=value.first||Boolean(previous?.first&&previous.generation===value.generation&&JSON.stringify(previous.context)===JSON.stringify(value.context));
  this.pending.set(value.source,Object.freeze({...value,first}));return true;
 }
 take(current:unknown,readiness:ClassroomVisualReadiness):ClassroomVisualUpdate|null{
  const now=this.time();
  if(this.closed||now===null){this.pending.clear();return null;}
  for(const [source,value] of this.pending)if(now>=value.expiresAtMs||!validateClassroomContext(current,value.context).accepted)this.pending.delete(source);
  if(!readiness.foregroundIdle||!readiness.childQuiet||!readiness.playbackQuiet)return null;
  const next=this.pending.values().next().value as ClassroomVisualUpdate|undefined;if(!next)return null;
  this.pending.delete(next.source);this.published.set(next.source,this.signature(next));return next;
 }
 cancel(source:ClassroomVisualUpdate['source']){this.pending.delete(source);this.published.delete(source);}
 close(){this.closed=true;this.pending.clear();this.published.clear();}
}
