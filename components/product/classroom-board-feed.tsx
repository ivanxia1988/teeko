'use client';
import {useEffect,type RefObject} from 'react';
import type {ClassroomSnapshot} from '../../lib/classroom-contract';
import {captureClassroomBoard,classroomBoardContext,type BoardStroke,type ClassroomBoardInput} from '../../lib/classroom-board';

type Props={snapshot:ClassroomSnapshot;enabled:boolean;image:RefObject<HTMLImageElement|null>;marks:(BoardStroke&{pageId:string})[];client:RefObject<{stopBoard?():void;sendBoard?(input:ClassroomBoardInput):boolean}|null>;onError(message:string):void;capture?:typeof captureClassroomBoard};
/** Lifecycle follows the authenticated voice connection, independently of optional camera permission. */
export function ClassroomBoardFeed({snapshot,enabled,image,marks,client,onError,capture=captureClassroomBoard}:Props){
 const key=classroomBoardContext(snapshot),pageId=snapshot.course.steps[snapshot.stepIndex]?.pageId;
 useEffect(()=>{
  const connection=client.current;
  if(!enabled||!connection?.sendBoard)return;
  let cancelled=false,busy=false,reported=false;
  const run=async()=>{
   if(cancelled||busy||!image.current||document.visibilityState==='hidden')return;
   busy=true;
   try{const frame=await capture(image.current,marks.filter(mark=>mark.pageId===pageId));if(!cancelled)connection.sendBoard?.({contextKey:key,image:frame});}
   catch{if(!cancelled&&!reported){reported=true;onError('教材笔迹暂时无法发送给老师；语音课堂可以继续。');}}
   finally{busy=false;}
  };
  const first=setTimeout(()=>{void run();},450),every=setInterval(()=>{void run();},3500);
  return()=>{cancelled=true;connection.stopBoard?.();clearTimeout(first);clearInterval(every);};
 },[key,pageId,enabled,image,marks,client,onError,capture]);
 return null;
}
