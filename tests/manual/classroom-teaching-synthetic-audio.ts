import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';

/** Fixed adult synthetic fixture only; no caller-supplied text or recordings. */
export async function syntheticTeachingHelpAudio(kind:'native'|'application'='native'):Promise<Buffer>{
 if(!['native','application'].includes(kind))throw new Error('Invalid synthetic speech fixture.');
 if(process.platform!=='darwin')throw new Error('Local synthetic speech fixture unavailable.');
 const directory=await mkdtemp(join(tmpdir(),'teeko-synthetic-help-'));
 try{
  const aiff=join(directory,'help.aiff'),pcm=join(directory,'help.pcm');
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH??'/usr/bin:/bin',NODE_ENV:'test'};
  const phrase=kind==='application'?'I still do not understand. Can you show me a short example?':'I still do not understand. Please write the short example briefly so I can look at it.';
  await promisify(execFile)('/usr/bin/say',['-v','Samantha','-r','160','-o',aiff,phrase],{timeout:15000,env});
  await promisify(execFile)('ffmpeg',['-hide_banner','-loglevel','error','-i',aiff,'-f','s16le','-ac','1','-ar','16000','-y',pcm],{timeout:15000,env});
  const result=await readFile(pcm);if(result.length<3200||result.length>640000||result.length%2)throw new Error('Invalid synthetic speech fixture.');
  return result;
 }catch{throw new Error('Local synthetic speech fixture unavailable.');}
 finally{await rm(directory,{recursive:true,force:true});}
}

export function teachingAudioFrames(audio:Buffer):Buffer[]{
 if(!audio.length||audio.length>640000||audio.length%2)throw new Error('Invalid synthetic speech fixture.');
 const frames:Buffer[]=[];
 for(let offset=0;offset<audio.length;offset+=3200){const frame=Buffer.alloc(3200);audio.copy(frame,0,offset,Math.min(offset+3200,audio.length));frames.push(frame);}
 return frames;
}
