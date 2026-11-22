'use client';

import React,{useCallback,useEffect,useState} from 'react';
import {classroomNotesPageSchema,type ClassroomNotesPage} from '../../lib/classroom-notes';
import {accountRequest,errorMessage} from './account-request';

type Props={classroomId:string;courseVersion:string};
export function ClassroomNotes(props:Props){return <NotesOwner key={`${props.classroomId}:${props.courseVersion}`} {...props}/>;}
function NotesOwner(props:Props){
 const [history,setHistory]=useState<(string|null)[]>([null]),[index,setIndex]=useState(0),[attempt,setAttempt]=useState(0),[next,setNext]=useState<string|null>(null),[loading,setLoading]=useState(true);
 const settled=useCallback((cursor:string|null)=>{setNext(cursor);setLoading(false);},[]);
 const previous=()=>{if(loading||index===0)return;setLoading(true);setNext(null);setIndex(value=>value-1);};
 const following=()=>{if(loading||!next)return;setHistory(value=>[...value.slice(0,index+1),next]);setIndex(value=>value+1);setNext(null);setLoading(true);};
 const retry=()=>{setLoading(true);setNext(null);setAttempt(value=>value+1);};
 const cursor=history[index];
 return <div className="tk-classroom-notes">
  <p className="tk-classroom-notes-caption">识别文字可能有误；表达参考可能与老师当时的说法不同。</p>
  <NotesPage key={`${cursor??'start'}:${attempt}`} {...props} cursor={cursor} onSettled={settled} onRetry={retry}/>
  <nav className="tk-classroom-notes-pagination" aria-label="课堂表达分页"><button type="button" aria-disabled={loading||index===0} onClick={previous}>上一页</button><span>第{index+1}页</span><button type="button" aria-disabled={loading||!next} onClick={following}>下一页</button></nav>
 </div>;
}
function NotesPage({classroomId,courseVersion,cursor,onSettled,onRetry}:Props&{cursor:string|null;onSettled:(next:string|null)=>void;onRetry:()=>void}){
 const [result,setResult]=useState<{kind:'loading'}|{kind:'error';message:string}|{kind:'ready';page:ClassroomNotesPage}>({kind:'loading'});
 useEffect(()=>{
  const controller=new AbortController();
  const params=new URLSearchParams({pageSize:'1'});if(cursor)params.set('cursor',cursor);
  void accountRequest(`/classrooms/${encodeURIComponent(classroomId)}/notes?${params}`,classroomNotesPageSchema,{signal:controller.signal}).then(page=>{
   if(controller.signal.aborted)return;
   if(page.classroomId!==classroomId||page.courseVersion!==courseVersion||page.entries.length>1||page.nextCursor&&page.nextCursor===cursor)throw new Error('课堂表达响应无效，请重新读取。');
   setResult({kind:'ready',page});onSettled(page.nextCursor);
  }).catch(error=>{if(!controller.signal.aborted){setResult({kind:'error',message:errorMessage(error)});onSettled(null);}});
  return()=>controller.abort();
 },[classroomId,courseVersion,cursor,onSettled]);
 if(result.kind==='loading')return <div className="tk-classroom-notes-body"><p role="status">正在读取课堂表达…</p></div>;
 if(result.kind==='error')return <div className="tk-classroom-notes-body"><p role="alert">{result.message}</p><button type="button" className="tk-classroom-notes-retry" onClick={onRetry}>重新读取</button></div>;
 const {preparation,coverage}=result.page;
 const scope=coverage==='limited_sources'?'部分来源不可用，记录可能不完整。':coverage==='retained_sources'?'只显示当前保留的来源，记录可能不完整。':'';
 const status=preparation==='pending'?'本课记录正在整理。':preparation==='ready'?'本课表达参考已整理。':preparation==='unavailable'?'整理暂不可用，仍可查看已保存来源。':'';
 const sourceStatus=<>{(status||coverage!=='captured_sources')&&<p className="tk-classroom-notes-caption" role="status">{status}{scope}</p>}{preparation&&preparation!=='ready'&&<button type="button" className="tk-classroom-notes-retry" onClick={onRetry}>重新读取</button>}</>;
 const note=result.page.entries[0];
 if(!note)return <div className="tk-classroom-notes-body">{sourceStatus}<p>{cursor||result.page.nextCursor?'这页没有可展示的表达记录。':'这节课还没有可回看的表达参考。'}</p></div>;
 const recordedAt=new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(note.original.recordedAt));
 return <article className="tk-classroom-notes-body" aria-label="课堂表达记录" tabIndex={0}>{sourceStatus}<h2>{note.step.label}</h2><dl><div><dt>{note.original.source==='typed'?'你输入的文字':'课堂识别文字'}{note.original.excerpt?'（节选）':''}</dt><dd><blockquote>{note.original.text}{note.original.excerpt?'…':''}</blockquote><time dateTime={note.original.recordedAt}>{recordedAt}</time></dd></div><div><dt>当时的表达参考</dt><dd><p>{note.reference.text}</p></dd></div></dl></article>;
}
