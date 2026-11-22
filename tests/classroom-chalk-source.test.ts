import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ClassroomChalkReader} from '../lib/server/classroom-chalk-reader';
import type {Pool,PoolClient} from 'pg';
import {ClassroomService} from '../lib/server/classroom-service';
import {teacherSnapshot} from './teacher-runtime-fixture';
const drain=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('an optional chalk read cancelled during pool acquisition releases its late client without querying',async()=>{
 const snapshot=teacherSnapshot(),controller=new AbortController(),releases:boolean[]=[];let queries=0,acquire:((client:PoolClient)=>void)|undefined;
 const client=Object.assign(new EventEmitter(),{query:async()=>{queries++;return{rows:[]};},release:(destroy=false)=>{releases.push(destroy);}}) as unknown as PoolClient;
 const pool={connect:()=>new Promise<PoolClient>(resolve=>{acquire=resolve;})} as unknown as Pool;
 const service=new ClassroomService(pool),reading=service.readChalkCandidate('owner',snapshot.id,snapshot.connectionEpoch,'token',snapshot,controller.signal);
 controller.abort();acquire!(client);assert.equal(await reading,null);assert.equal(queries,0);assert.deepEqual(releases,[false]);
});
test('cancelling an active optional chalk query destroys its exclusive client exactly once',async()=>{
 const snapshot=teacherSnapshot(),controller=new AbortController(),releases:boolean[]=[];let rejectQuery:((error:Error)=>void)|undefined;
 const client=Object.assign(new EventEmitter(),{query:()=>new Promise((_resolve,reject)=>{rejectQuery=reject;}),release:(destroy=false)=>{releases.push(destroy);if(destroy)rejectQuery?.(new Error('PRIVATE_QUERY_DETAIL'));}}) as unknown as PoolClient;
 const service=new ClassroomService({connect:async()=>client} as unknown as Pool),reading=service.readChalkCandidate('owner',snapshot.id,snapshot.connectionEpoch,'token',snapshot,controller.signal);
 await drain();controller.abort();assert.equal(await reading,null);assert.deepEqual(releases,[true]);controller.abort();assert.deepEqual(releases,[true]);
});
test('a completed optional chalk query removes its abort listener and releases only once',async()=>{
 const snapshot=teacherSnapshot(),controller=new AbortController(),releases:boolean[]=[];
 const client=Object.assign(new EventEmitter(),{query:async()=>({rows:[]}),release:(destroy=false)=>releases.push(destroy)}) as unknown as PoolClient;
 const service=new ClassroomService({connect:async()=>client} as unknown as Pool);
 assert.equal(await service.readChalkCandidate('owner',snapshot.id,snapshot.connectionEpoch,'token',snapshot,controller.signal),null);controller.abort();assert.deepEqual(releases,[false]);
});

test('an optional database connection error is contained and destroys only its exclusive client',async()=>{
 const snapshot=teacherSnapshot(),releases:boolean[]=[];let rejectQuery:((error:Error)=>void)|undefined;
 const client=Object.assign(new EventEmitter(),{query:()=>new Promise((_resolve,reject)=>{rejectQuery=reject;}),release:(destroy=false)=>{releases.push(destroy);if(destroy)rejectQuery?.(new Error('Synthetic connection failure.'));}}) as unknown as PoolClient;
 const service=new ClassroomService({connect:async()=>client} as unknown as Pool),reader=new ClassroomChalkReader((state,signal)=>service.readChalkCandidate('owner',state.id,state.connectionEpoch,'token',state,signal),{budgetMs:100});
 try{assert.equal(reader.peek(snapshot),null);await drain();assert.doesNotThrow(()=>client.emit('error',new Error('Synthetic connection failure.')));await drain();assert.deepEqual(releases,[true]);assert.equal(client.listenerCount('error'),0);}finally{reader.close();}
});
