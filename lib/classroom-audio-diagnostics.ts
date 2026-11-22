import {z} from 'zod';

const count=z.number().int().nonnegative().safe(),ms=count.max(60000);
export const AUDIO_DIAGNOSTIC_WINDOW_MS=5000;
export const audioContinuityStatsSchema=z.object({
 boundary:z.enum(['upstream','server','browser']),windowMs:ms,chunkCount:count.max(12000),audioMs:count.max(120000),audibleChunkCount:count.max(12000),maxArrivalGapMs:ms,
 playbackGapCount:count.max(12000).optional(),playbackGapMs:ms.optional(),maxPlaybackGapMs:ms.optional(),
 minQueueMs:count.max(12000).optional(),maxQueueMs:count.max(12000).optional(),suspendedMs:ms.optional(),maxScheduleLagMs:ms.optional(),
}).strict().refine(value=>value.audibleChunkCount<=value.chunkCount,'Invalid audible count')
 .refine(value=>value.minQueueMs===undefined||value.maxQueueMs===undefined||value.minQueueMs<=value.maxQueueMs,'Invalid queue range');
export type AudioContinuityStats=z.infer<typeof audioContinuityStatsSchema>;
export const audioContinuityReportSchema=z.object({
 type:z.literal('diagnostic.audio'),contextKey:z.string().max(120).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9]\d{0,8}:\d{1,8}$/i),
 playbackId:count.max(2_000_000_000),sequence:count.positive().max(2_000_000_000),audioStats:audioContinuityStatsSchema,
}).strict().refine(value=>value.audioStats.boundary==='browser','Browser observations only');
export function sanitizeAudioContinuityStats(value:unknown):AudioContinuityStats|undefined{
 const parsed=audioContinuityStatsSchema.safeParse(value);return parsed.success?parsed.data:undefined;
}
export function audioContinuityHasGap(stats:AudioContinuityStats):boolean{
 // Native providers legitimately stop sending between replies; arrival gaps alone are not failures.
 return (stats.maxPlaybackGapMs??0)>=40||(stats.playbackGapMs??0)>=150||(stats.maxScheduleLagMs??0)>=100;
}
export function describeAudioContinuity(stats:AudioContinuityStats):string{
 const prefix=stats.boundary==='browser'?'浏览器':stats.boundary==='upstream'?'语音服务到后台':'后台发送';
 const parts=[`${prefix} · ${stats.windowMs} 毫秒观察窗 · ${stats.chunkCount} 片`, `音频数据 ${stats.audioMs} 毫秒，其中 ${stats.audibleChunkCount} 片达到有声阈值`, `最大片段到达间隔 ${stats.maxArrivalGapMs} 毫秒`];
 if(stats.playbackGapCount)parts.push(`播放片间空档 ${stats.playbackGapCount} 次，累计 ${stats.playbackGapMs??0} 毫秒`);
 if(stats.maxScheduleLagMs)parts.push(`最大发送调度延后 ${stats.maxScheduleLagMs} 毫秒`);
 if(stats.suspendedMs)parts.push(`播放时钟暂停 ${stats.suspendedMs} 毫秒`);
 if(stats.maxQueueMs!==undefined)parts.push(`队列 ${stats.minQueueMs??0}–${stats.maxQueueMs} 毫秒`);
 return parts.join('；');
}
