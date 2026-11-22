import assert from 'node:assert/strict';
import test from 'node:test';
import {projectClassroomLatency} from '../lib/classroom-latency-view';
import type {ClassroomJournalEvent} from '../lib/classroom-journal';
const measurementId='10000000-0000-4000-8000-000000000001',inputId='20000000-0000-4000-8000-000000000001';
const stage=(id:number,latencyStage:string,elapsedMs:number,extra:Record<string,unknown>={}):ClassroomJournalEvent=>({id:String(id),createdAt:'2026-11-15T09:00:00.000Z',epoch:1,revision:1,stepIndex:0,kind:'connection',actor:'application',status:'recorded',name:'latency_stage',text:null,correlationId:null,details:{measurementId,latencyInputId:inputId,latencyStage,latencyBasis:'provider_turn',clock:'server',elapsedMs,...extra}} as unknown as ClassroomJournalEvent);

test('latency keeps browser total separate from same-origin server stages',()=>{
 const [row]=projectClassroomLatency([stage(1,'input_received',0),stage(2,'speech_stopped',1000),stage(3,'input_final',1800),stage(4,'response_requested',2100),stage(5,'audio_first_received',4200),stage(6,'audio_first_sent',4300),stage(7,'playback_started',0,{clock:'client',waitMs:3500,playbackMs:80})]);
 assert.equal(row.waitMs,3500);assert.equal(row.status,'played');
 assert.deepEqual(row.segments.map(s=>[s.id,s.ms]),[['recognition',800],['application',300],['reply',2100],['send',100],['playback',80]]);
 assert.match(row.summary,/等待 3.5 秒/);assert.match(row.summary,/回复等待 2.1 秒/);
});
test('latency never substitutes server elapsed or wall timestamps for missing browser wait',()=>{
 const [row]=projectClassroomLatency([stage(1,'speech_stopped',1000),stage(2,'audio_first_received',6000),stage(3,'audio_first_sent',6100)]);
 assert.equal(row.waitMs,null);assert.equal(row.status,'waiting');assert.match(row.summary,/等待播放确认/);assert.match(row.detail,/等待浏览器/);assert.doesNotMatch(row.detail,/未测完整/);
});
test('native reply can measure response wait from the explicit stopped stage',()=>{
 const [row]=projectClassroomLatency([stage(1,'speech_stopped',1000),stage(2,'input_final',1700),stage(3,'audio_first_received',2500)]);
 assert.equal(row.segments.find(s=>s.id==='reply')?.ms,1500);
});
test('overlapping or reversed server phases do not become negative or summed durations',()=>{
 const [row]=projectClassroomLatency([stage(1,'speech_stopped',2000),stage(2,'response_requested',2100),stage(3,'input_final',2200),stage(4,'audio_first_received',1900),stage(5,'playback_started',0,{clock:'client',waitMs:500})]);
 assert.equal(row.segments.find(s=>s.id==='application'),undefined);assert.equal(row.segments.find(s=>s.id==='reply'),undefined);assert.equal(row.waitMs,500);
 assert.match(row.detail,/重叠|未拆分/);
});
test('client elapsed cannot create server stage durations and unknown total is not zero',()=>{
 const [row]=projectClassroomLatency([stage(1,'speech_stopped',1000,{clock:'client'}),stage(2,'input_final',1800)]);
 assert.deepEqual(row.segments,[]);assert.equal(row.waitMs,null);assert(!row.summary.includes('0 秒'));
});
test('same measurement IDs remain separate across connection epochs',()=>{
 const rows=projectClassroomLatency([stage(1,'speech_stopped',100),stage(2,'playback_started',0,{clock:'client',waitMs:500}),{...stage(3,'speech_stopped',100),epoch:2}]);
 assert.equal(rows.length,2);assert.equal(rows[1].waitMs,null);
});
test('conflicting input identities cannot produce a measured round',()=>{
 const [row]=projectClassroomLatency([stage(1,'speech_stopped',100),stage(2,'playback_started',0,{clock:'client',waitMs:500,latencyInputId:'30000000-0000-4000-8000-000000000001'})]);
 assert.equal(row.status,'unmeasured');assert.equal(row.waitMs,null);assert.match(row.detail,/关联/);
});
test('cancellation before playback prevents a late total, while a later interruption does not erase a completed wait',()=>{
 const [cancelled]=projectClassroomLatency([stage(1,'cancelled',100),stage(2,'playback_started',0,{clock:'client',waitMs:500})]);
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.waitMs,null);
 const [played]=projectClassroomLatency([stage(1,'playback_started',0,{clock:'client',waitMs:500}),stage(2,'cancelled',100)]);
 assert.equal(played.status,'played');assert.equal(played.waitMs,500);
});
test('GPT application window is explicitly labelled and never implies an official final event',()=>{
 const [row]=projectClassroomLatency([stage(1,'speech_stopped',100,{latencyBasis:'application_window'}),stage(2,'playback_started',0,{latencyBasis:'application_window',clock:'client',waitMs:1200})]);
 assert.equal(row.basisLabel,'应用话轮');assert.match(row.detail,/应用话轮/);
});
test('unsafe or malformed durations stay unmeasured and bigint IDs remain exact',()=>{
 const row=projectClassroomLatency([{...stage(1,'playback_started',0,{clock:'client',waitMs:120001}),id:'9007199254740993'}])[0];
 assert.equal(row.waitMs,null);assert.equal(row.status,'unmeasured');assert.equal(row.eventIds[0],'9007199254740993');
});
test('checked activity transition preserves an explicit measurement while ambiguous repeated stages are not combined',()=>{
 const [row]=projectClassroomLatency([
  stage(1,'input_received',0,{contextKey:'activity-before'}),stage(2,'speech_stopped',1000,{contextKey:'activity-before'}),stage(3,'input_final',1600,{contextKey:'activity-before'}),
  stage(4,'response_requested',1700,{contextKey:'activity-before'}),stage(5,'response_requested',2500,{contextKey:'activity-after'}),stage(6,'audio_first_received',4000,{contextKey:'activity-after'}),
  stage(7,'playback_started',0,{contextKey:'activity-after',clock:'client',waitMs:3200})
 ]);
 assert.equal(row.status,'played');assert.equal(row.waitMs,3200);
 assert.equal(row.segments.find(segment=>segment.id==='application'),undefined);
 assert.equal(row.segments.find(segment=>segment.id==='reply'),undefined);
 assert.equal(row.segments.find(segment=>segment.id==='recognition')?.ms,600);
});
test('measurement without a known basis cannot claim a complete browser wait',()=>{
 const [row]=projectClassroomLatency([stage(1,'speech_stopped',100,{latencyBasis:undefined}),stage(2,'playback_started',0,{latencyBasis:undefined,clock:'client',waitMs:500})]);
 assert.equal(row.waitMs,null);assert.equal(row.status,'unmeasured');
});
test('a new audio episode remains waiting before a provider basis is bound',()=>{
 const [row]=projectClassroomLatency([stage(1,'input_received',0,{latencyBasis:undefined}),stage(2,'speech_stopped',1000,{latencyBasis:undefined})]);
 assert.equal(row.status,'waiting');assert.match(row.summary,/等待识别/);assert.equal(row.waitMs,null);
});
test('duplicate snapshot events do not multiply a measurement or its segments',()=>{
 const stop=stage(1,'speech_stopped',100),playback=stage(2,'playback_started',0,{clock:'client',waitMs:500});
 const rows=projectClassroomLatency([stop,playback,stop,playback]);
 assert.equal(rows.length,1);assert.deepEqual(rows[0].eventIds,['1','2']);
});
test('known capture and cancellation reasons remain readable without exposing raw states',()=>{
 for(const [state,label] of [['capture_gap','采集出现间断'],['new_voice','新的说话信号'],['stop_unconfirmed','停声边界未确认']]){
  const [row]=projectClassroomLatency([stage(1,'unmeasured',100,{state})]);assert.match(row.detail,new RegExp(label));
 }
});
test('pending rounds show only the most recently recorded same-clock server waiting duration',()=>{
 const [row]=projectClassroomLatency([stage(1,'speech_stopped',1000),stage(2,'response_requested',1200),stage(3,'wait_update',3400,{state:'waiting_audio'})]);
 assert.match(row.summary,/等待中 · 服务端最近记录已等 2.4 秒 · 等待老师语音/);assert.equal(row.waitMs,null);
 assert.match(row.detail,/截至最近服务端记录/);assert.match(row.detail,/不是本机停声到播放的总等待/);
 assert.equal(row.segments.some(segment=>segment.ms===2400),false);
});
test('pending heartbeat never invents a zero or a stopped boundary from client early-stop alone',()=>{
 const [row]=projectClassroomLatency([stage(1,'input_received',0,{latencyBasis:undefined}),stage(2,'wait_update',3400,{latencyBasis:undefined,state:'waiting_reply'})]);
 assert.match(row.summary,/等待老师回复/);assert.doesNotMatch(row.summary,/已等|0.0 秒/);
 const [stopped]=projectClassroomLatency([stage(1,'speech_stopped',1000),stage(2,'wait_update',1000,{state:'waiting_reply'})]);assert.doesNotMatch(stopped.summary,/0.0 秒/);
});
test('unknown heartbeat states and snapshots after a terminal cannot replace observed progress',()=>{
 const [pending]=projectClassroomLatency([stage(1,'speech_stopped',1000),stage(2,'wait_update',5000,{state:'waiting_unknown'})]);
 assert.match(pending.summary,/等待识别/);assert.equal(pending.progressEventId,'1');assert.doesNotMatch(pending.summary,/4.0 秒/);
 const [played]=projectClassroomLatency([stage(1,'speech_stopped',1000),stage(2,'playback_started',0,{clock:'client',waitMs:2300}),stage(3,'wait_update',5000,{state:'waiting_audio'})]);
 assert.equal(played.waitMs,2300);assert.equal(played.progressEventId,'2');assert.doesNotMatch(played.summary,/等待中/);
});
test('the longest measured stage can be browser playback wait without combining endpoint clocks',()=>{
 const [row]=projectClassroomLatency([stage(1,'speech_stopped',1000),stage(2,'response_requested',1400),stage(3,'audio_first_received',1600),stage(4,'playback_started',0,{clock:'client',waitMs:1500,playbackMs:900})]);
 assert.match(row.summary,/较长的已测阶段：到浏览器后等待播放 0.9 秒/);
 assert.equal(row.segments.find(segment=>segment.id==='reply')?.ms,200);assert.equal(row.waitMs,1500);
});
test('playback and activity-advance measurement failures have specific safe explanations',()=>{
 for(const [state,label] of [['playback_clock','播放时钟'],['playback_unbound','声音无法唯一关联'],['advance_timeout','活动推进确认超时'],['advance_unverified','活动推进结果未通过确认']]){
  const [row]=projectClassroomLatency([stage(1,'unmeasured',100,{state})]);assert.match(row.detail,new RegExp(label));
 }
});
