/** Display projection only. PostgreSQL snapshots remain the usage and time-limit authority. */
export class ClassroomElapsedClock {
 private seconds=0;
 private anchor=0;
 private limit=0;
 private running=false;
 read(now:number){return Math.min(this.limit,this.seconds+(this.running?Math.max(0,now-this.anchor)/1000:0));}
 synchronize(seconds:number,maxSeconds:number,now:number,keepProjection=true){
  this.seconds=keepProjection?Math.max(this.read(now),seconds):seconds;this.limit=maxSeconds;this.anchor=now;
 }
 setRunning(running:boolean,now:number){this.seconds=this.read(now);this.anchor=now;this.running=running;}
}
