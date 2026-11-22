import {classroomPointDiagnosticEventSchema,type ClassroomPointDiagnosticEvent} from './classroom-point-diagnostics';

export type ClassroomPointObservation=Omit<ClassroomPointDiagnosticEvent,'id'|'context'>&{context?:ClassroomPointDiagnosticEvent['context']};
type Reference=Pick<ClassroomPointDiagnosticEvent,'context'|'objectId'>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Optional, bounded client observations; delivery never owns media or classroom state. */
export class ClassroomPointDiagnosticsClient{
 private readonly request:typeof fetch;
 private readonly timeoutMs:number;
 private readonly queue:ClassroomPointDiagnosticEvent[]=[];
 private readonly references=new Map<string,Reference>();
 private timer:ReturnType<typeof setTimeout>|null=null;
 private running:Promise<void>|null=null;
 private closed=false;
 constructor(private readonly classroomId:string,options:{fetch?:typeof fetch;timeoutMs?:number}={}){
  this.request=options.fetch??globalThis.fetch.bind(globalThis);this.timeoutMs=options.timeoutMs??2500;
 }
 record(input:ClassroomPointObservation):boolean{
  if(this.closed||!uuid.test(this.classroomId))return false;
  try{
   const reference=this.references.get(input.pointId);
   const parsed=classroomPointDiagnosticEventSchema.safeParse({id:globalThis.crypto.randomUUID(),...input,context:input.context??reference?.context,objectId:input.objectId??reference?.objectId});
   if(!parsed.success||parsed.data.context.logicalSessionId!==this.classroomId)return false;
   const event=parsed.data;
   this.references.set(event.pointId,{context:event.context,objectId:event.objectId});
   if(this.references.size>64)this.references.delete(this.references.keys().next().value!);
   if(this.queue.length>=40)this.queue.shift();this.queue.push(event);
   if(!this.timer&&!this.running)this.timer=setTimeout(()=>{this.timer=null;void this.flush();},100);
   return true;
  }catch{return false;}
 }
 flush():Promise<void>{
  if(this.timer){clearTimeout(this.timer);this.timer=null;}
  if(this.running)return this.running;
  this.running=this.drain().finally(()=>{this.running=null;if(this.queue.length)void this.flush();});
  return this.running;
 }
 close():void{
  this.closed=true;this.references.clear();void this.flush();
 }
 private async drain():Promise<void>{
  while(this.queue.length){
   const events=this.queue.splice(0,10),controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   try{
    const timeout=new Promise<void>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve();},this.timeoutMs);});
    await Promise.race([this.request('/api/v1/classrooms/'+this.classroomId+'/diagnostics',{method:'POST',credentials:'same-origin',cache:'no-store',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({events}),signal:controller.signal}).then(()=>{}),timeout]);
   }catch{ /* Drop this optional batch. Never retry or report a reporting failure. */ }
   finally{if(timer)clearTimeout(timer);}
  }
 }
}

const clients=new Map<string,ClassroomPointDiagnosticsClient>();
export function reportClassroomPointObservation(classroomId:string,event:ClassroomPointObservation):boolean{
 try{
  if(!uuid.test(classroomId))return false;
  let client=clients.get(classroomId);
  if(!client){client=new ClassroomPointDiagnosticsClient(classroomId);clients.set(classroomId,client);if(clients.size>8){const first=clients.keys().next().value!;clients.get(first)?.close();clients.delete(first);}}
  return client.record(event);
 }catch{return false;}
}
export function flushClassroomPointObservations(classroomId:string):void{void clients.get(classroomId)?.flush();}
export function closeClassroomPointObservations(classroomId:string):void{const client=clients.get(classroomId);clients.delete(classroomId);client?.close();}
