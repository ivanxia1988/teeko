import test from 'node:test';
import assert from 'node:assert/strict';
import {audioContinuityStatsSchema,audioContinuityReportSchema,audioContinuityHasGap} from '../lib/classroom-audio-diagnostics';
import {sanitizeClassroomJournalEntry} from '../lib/classroom-journal';
import type {ClassroomJournalEvent} from '../lib/classroom-journal';
import {projectClassroomDiagnostics,exportClassroomDiagnostics} from '../lib/classroom-diagnostics';
import {buildClassroomTimeline} from '../lib/classroom-timeline';

const stats={boundary:'browser',windowMs:5000,chunkCount:100,audioMs:5000,audibleChunkCount:75,maxArrivalGapMs:120,playbackGapCount:1,playbackGapMs:55,maxPlaybackGapMs:55,minQueueMs:0,maxQueueMs:70};
test('audio continuity accepts bounded numeric observations and preserves them in journal',()=>{
 const value=audioContinuityStatsSchema.parse(stats);
 const entry=sanitizeClassroomJournalEntry({eventKey:'audio:1',kind:'connection',actor:'application',status:'recorded',name:'audio_continuity',details:{audioStats:value}});
 assert.deepEqual(entry.details?.audioStats,value);
});
test('audio continuity rejects raw media, impossible counts and unbounded metrics',()=>{
 for(const bad of [{...stats,audio:'private media'},{...stats,audibleChunkCount:101},{...stats,minQueueMs:100,maxQueueMs:10},{...stats,windowMs:60001},{...stats,maxArrivalGapMs:Infinity},{...stats,playbackGapCount:-1}])assert.equal(audioContinuityStatsSchema.safeParse(bad).success,false);
});
test('browser report has strict bounded scope and cannot claim provider observation',()=>{
 const report={type:'diagnostic.audio',contextKey:'e487b951-9846-4921-8cbe-446430defa8c:1:0',playbackId:3,sequence:1,audioStats:stats};
 assert.equal(audioContinuityReportSchema.safeParse(report).success,true);
 for(const bad of [{...report,audioStats:{...stats,boundary:'upstream'}},{...report,secret:'private'},{...report,sequence:0},{...report,contextKey:'invalid'}])assert.equal(audioContinuityReportSchema.safeParse(bad).success,false);
});
test('audio gaps are readable without turning every healthy numeric window into a timeline card',()=>{
 const event:ClassroomJournalEvent={id:'1',createdAt:'2026-11-22T00:00:00Z',epoch:1,revision:1,stepIndex:0,kind:'connection',actor:'application',status:'recorded',name:'audio_continuity',text:null,correlationId:null,details:{audioStats:audioContinuityStatsSchema.parse(stats)}};
 const rows=buildClassroomTimeline([event]);assert.equal(rows.length,1);assert.match(rows[0].title,/播放片间空档/);assert.match(rows[0].note??'',/不等于/);
 const projection=projectClassroomDiagnostics([event]);assert.deepEqual(exportClassroomDiagnostics(projection).events[0].audioStats,event.details.audioStats);
 const healthy={...event,details:{audioStats:audioContinuityStatsSchema.parse({...stats,playbackGapCount:0,playbackGapMs:0,maxPlaybackGapMs:0,maxArrivalGapMs:50})}};
 assert.equal(buildClassroomTimeline([healthy]).length,0);
 assert.equal(audioContinuityHasGap(audioContinuityStatsSchema.parse({boundary:'upstream',windowMs:10000,chunkCount:2,audioMs:100,audibleChunkCount:2,maxArrivalGapMs:9990})),false);
 assert.equal(audioContinuityHasGap(audioContinuityStatsSchema.parse({...stats,playbackGapMs:8,maxPlaybackGapMs:8})),false);
});
