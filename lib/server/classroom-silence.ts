/** One optional invitation per completed learner turn; never evidence of ability. */
export class ClassroomSilencePrompt{
 private audioId:number|null=null;
 private quietSince:number|null=null;
 private reminded=false;
 private waiting=false;
 get canProbe(){return this.audioId!==null&&!this.reminded&&!this.waiting;}
 get explicitlyWaiting(){return this.waiting;}
 teacherAudio(playbackId:number){this.audioId=playbackId;this.quietSince=null;}
 confirmPlayback(playbackId:number,now:number,thinkingMs:number){
  if(!this.canProbe||playbackId!==this.audioId||!Number.isFinite(now)||!Number.isFinite(thinkingMs)||thinkingMs<=0)return false;
  if(this.quietSince===null||now<this.quietSince){this.quietSince=now;return false;}
  if(now-this.quietSince<thinkingMs)return false;
  this.reminded=true;return true;
 }
 speechStarted(){this.interrupt();}
 learnerFinal(text:string){
  this.reminded=false;
  this.waiting=/(?:^|[.!?]\s*)(?:please\s+)?wait\b|\b(?:(?:can|could|would)\s+you\s+(?:please\s+)?wait|please\s+wait|hold\s+on|let\s+me\s+think|give\s+me\s+(?:some\s+)?time)\b|等(?:一下|一会|一等|等)|(?:让我|我先|我再).{0,4}想|先别说话|先不要说话/i.test(text.trim());
 }
 drawing(){this.quietSince=null;}
 interrupt(){this.audioId=null;this.quietSince=null;}
 reset(){this.interrupt();this.reminded=false;this.waiting=false;}
}
