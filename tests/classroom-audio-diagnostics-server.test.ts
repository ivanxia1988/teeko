import test from 'node:test';
import assert from 'node:assert/strict';
import {ClassroomAudioDiagnostics} from '../lib/server/classroom-audio-diagnostics';
import type {ClassroomJournalEntry} from '../lib/classroom-journal';
const key='e487b951-9846-4921-8cbe-446430defa8c:1:0';
function setup(){let now=0,contextKey=key,playbackId=10;const entries:ClassroomJournalEntry[]=[];const d=new ClassroomAudioDiagnostics({current:()=>({contextKey,playbackId}),emit:e=>entries.push(e),now:()=>now});return {d,entries,at:(ms:number)=>now=ms,scope:(s:string)=>contextKey=s,playback:(n:number)=>playbackId=n};}
const pcm=Buffer.alloc(2400);
test('server aggregates bounded numeric transport windows without media',()=>{
 const h=setup();h.d.upstream(pcm);h.at(50);h.d.upstream(pcm);h.at(5000);h.d.upstream(pcm);
 assert.equal(h.entries.length,1);const s=h.entries[0].details?.audioStats;assert.equal(s?.chunkCount,3);assert.equal(s?.audioMs,150);assert.equal(s?.maxArrivalGapMs,4950);
 assert.equal(JSON.stringify(h.entries).includes(pcm.toString('base64')),false);
});
test('new scope and reset cannot bridge an intentional playback gap',()=>{
 const h=setup();h.d.sent(pcm);h.at(100);h.d.reset();h.at(2000);h.d.sent(pcm);h.at(2100);h.scope(key.replace(':1:0',':1:1'));h.d.sent(pcm);h.d.close();
 assert.equal(h.entries.length,3);for(const e of h.entries)assert.equal(e.details?.audioStats?.maxArrivalGapMs,0);
 assert.equal(h.entries[1].details?.contextKey,key);assert.equal(h.entries[2].details?.contextKey,key.replace(':1:0',':1:1'));
});
test('browser reports require current scope, sent playback, increasing sequence and rate',()=>{
 const h=setup();const stats={boundary:'browser',windowMs:5000,chunkCount:1,audioMs:50,audibleChunkCount:0,maxArrivalGapMs:0};
 const r={type:'diagnostic.audio',contextKey:key,playbackId:10,sequence:1,audioStats:stats};
 assert.equal(h.d.browser({...r,playbackId:11}),false);assert.equal(h.d.browser({...r,contextKey:key.replace(':1:0',':2:0')}),false);
 assert.equal(h.d.browser(r),true);assert.equal(h.d.browser(r),false);assert.equal(h.d.browser({...r,sequence:2}),false);
 h.at(600);assert.equal(h.d.browser({...r,sequence:2}),true);h.d.reset();h.at(1200);assert.equal(h.d.browser({...r,sequence:3,playbackId:9}),false);
 h.d.close();assert.equal(h.d.browser({...r,sequence:4}),false);
});
test('optional diagnostic callback failures never break audio',()=>{
 const d=new ClassroomAudioDiagnostics({current:()=>({contextKey:key,playbackId:1}),emit:()=>{throw Error('fixture');}});
 assert.doesNotThrow(()=>{d.upstream(pcm);d.sent(pcm);d.close();});
});
test('one known interruption window may arrive late without admitting arbitrary obsolete playback',()=>{
 const h=setup(),stats={boundary:'browser',windowMs:250,chunkCount:2,audioMs:100,audibleChunkCount:2,maxArrivalGapMs:50};
 const r={type:'diagnostic.audio',contextKey:key,playbackId:10,sequence:1,audioStats:stats};
 assert.equal(h.d.browser(r),true);h.at(100);h.playback(11);h.d.reset(10);
 assert.equal(h.d.browser({...r,playbackId:9,sequence:2}),false);
 assert.equal(h.d.browser({...r,sequence:2}),true);assert.equal(h.d.browser({...r,sequence:3}),false);
 h.at(2000);h.playback(12);h.d.reset(11);h.at(3600);assert.equal(h.d.browser({...r,playbackId:11,sequence:4}),false);
});
