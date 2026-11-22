'use client';

import React,{useCallback,useEffect,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {ClassroomChalkBoard,type ClassroomChalkWriting} from '../../lib/domain/classroom-chalk';
import {captureClassroomState,type ClassroomStateSnapshot} from '../../lib/domain/classroom-context';
import {ClassroomChalk} from '../product/classroom-chalk';

type Props={current:unknown;canvas:RefObject<HTMLElement|null>};
export function ChalkPreview({current,canvas}:Props){
 const captured=captureClassroomState(current),state=captured.ok?captured.snapshot:null;
 return <ChalkPreviewOwner key={JSON.stringify(state)} current={state} canvas={canvas}/>;
}
function ChalkPreviewOwner({current,canvas}:{current:ClassroomStateSnapshot|null;canvas:Props['canvas']}){
 const board=useRef<ClassroomChalkBoard|null>(null);
 const [writing,setWriting]=useState<ClassroomChalkWriting|null>(null),[target,setTarget]=useState<HTMLElement|null>(null);
 useEffect(()=>{const owner=new ClassroomChalkBoard();board.current=owner;return()=>{owner.close();if(board.current===owner)board.current=null;};},[]);
 const expired=useCallback((id:string)=>{
  const still=board.current?.read(current);if(!still||still.id===id)board.current?.clear();
  setWriting(previous=>previous?.id===id?null:previous);
 },[current]);
 const show=()=>{
  if(!current||current.status!=='active'||!canvas.current)return;
  const now=Date.now();
  const checked=board.current?.write(current,{type:'chalk.write',id:crypto.randomUUID(),context:current.context,receivedAtMs:now,expiresAtMs:now+8000,text:'I am going to the museum.'});
  if(checked?.accepted){setTarget(canvas.current);setWriting(checked.writing);}
 };
 return <><button type="button" onClick={show} disabled={current?.status!=='active'}>板书示例</button><button type="button" onClick={()=>{board.current?.clear();setWriting(null);}}>擦除示例</button>{target&&writing&&createPortal(<ClassroomChalk current={current} writing={writing} onExpire={expired}/>,target)}</>;
}
