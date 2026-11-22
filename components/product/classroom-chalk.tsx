'use client';

import React,{useEffect,useRef,useState,type CSSProperties} from 'react';
import {validateClassroomChalkWriting,type ClassroomChalkWriting} from '../../lib/domain/classroom-chalk';

type Props={current:unknown;writing:unknown;now?:()=>number;onExpire?:(id:string)=>void;onDisplayed?:(id:string)=>void};
export function ClassroomChalk({current,writing,now=Date.now,onExpire,onDisplayed}:Props){
 const reportedId=useRef<string|null>(null);
 const [owner,setOwner]=useState<{writing:ClassroomChalkWriting|null;seen:readonly string[]}>({writing:null,seen:[]});
 const checked=validateClassroomChalkWriting(current,writing,now());
 let next=owner;
 if(!checked.accepted){if(owner.writing)next={...owner,writing:null};}
 else if(owner.writing?.id===checked.writing.id){
  if(JSON.stringify(owner.writing)!==JSON.stringify(checked.writing))next={...owner,writing:null};
 }else if(owner.seen.includes(checked.writing.id)||owner.seen.length>=250){
  if(owner.writing)next={...owner,writing:null};
 }else next={writing:checked.writing,seen:[...owner.seen,checked.writing.id]};
 // Retire synchronously with changed props so pause/clear/scope restoration cannot revive text.
 if(next!==owner)setOwner(next);
 const message=next.writing;
 useEffect(()=>{
  if(!message)return;
  const {id,expiresAtMs}=message;
  const timer=setTimeout(()=>{setOwner(previous=>previous.writing?.id===id?{...previous,writing:null}:previous);onExpire?.(id);},Math.max(0,expiresAtMs-now()));
  return()=>clearTimeout(timer);
 },[message,now,onExpire]);
 useEffect(()=>{
  if(message&&onDisplayed&&reportedId.current!==message.id&&validateClassroomChalkWriting(current,message,now()).accepted){reportedId.current=message.id;onDisplayed(message.id);}
 },[message,current,now,onDisplayed]);
 if(!message)return null;
 return <aside className="tk-classroom-chalk" role="note" aria-label="Teacher writing" aria-live="polite" style={{'--tk-chalk-duration':`${message.expiresAtMs-message.receivedAtMs}ms`} as CSSProperties} key={message.id}><span>{message.text}</span></aside>;
}
