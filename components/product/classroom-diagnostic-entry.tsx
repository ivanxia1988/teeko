'use client';
import {useEffect,useState} from 'react';

/** Entry discovery grants no log access; the destination requires its own admin session. */
export function useClassroomDiagnosticEntry(classroomId:string){
 const [entry,setEntry]=useState<{classroomId:string;url:string}|null>(null);
 useEffect(()=>{
  const controller=new AbortController();
  void fetch(`/api/v1/diagnostics/entry?classroomId=${encodeURIComponent(classroomId)}`,{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(async response=>{
   if(!response.ok)return;
   const raw:unknown=await response.json();if(!raw||typeof raw!=='object')return;const result=raw as Record<string,unknown>;if(controller.signal.aborted||result.ok!==true||result.enabled!==true||typeof result.url!=='string')return;
   const url=new URL(result.url),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
   if(url.username||url.password||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&local)||url.pathname!=='/admin/diagnostics'||url.searchParams.size!==1||url.searchParams.get('classroomId')!==classroomId)return;
   setEntry({classroomId,url:url.href});
  }).catch(()=>{});
  return()=>controller.abort();
 },[classroomId]);
 return entry?.classroomId===classroomId?entry.url:null;
}
