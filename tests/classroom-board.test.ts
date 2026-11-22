import test from 'node:test';
import assert from 'node:assert/strict';
import {captureClassroomBoard,classroomBoardContext} from '../lib/classroom-board';
import {teacherSnapshot} from './teacher-runtime-fixture';

test('board identity changes for revision, task, provider connection and published course changes',()=>{
 const s=teacherSnapshot();const key=classroomBoardContext(s);
 for(const next of [{...s,revision:s.revision+1},{...s,stepIndex:s.stepIndex+1},{...s,connectionEpoch:s.connectionEpoch+1},{...s,course:{...s.course,version:'other'}}])assert.notEqual(classroomBoardContext(next),key);
});
test('board capture composites the actual textbook before foreground pen strokes with bounded JPEG',async()=>{
 const ops:string[]=[];let width=0,height=0;
 const ctx={fillStyle:'',font:'',strokeStyle:'',lineWidth:0,lineCap:'',lineJoin:'',fillRect(){},fillText(){},drawImage(){ops.push('textbook');},beginPath(){},moveTo(x:number,y:number){ops.push(`move:${x}:${y}`);},lineTo(){},stroke(){ops.push('stroke');}};
 const canvas={get width(){return width;},set width(v:number){width=v;},get height(){return height;},set height(v:number){height=v;},getContext:()=>ctx,toBlob:(cb:BlobCallback)=>cb(new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'}))} as unknown as HTMLCanvasElement;
 const image={complete:true,naturalWidth:1200,naturalHeight:960} as HTMLImageElement;
 const jpeg=await captureClassroomBoard(image,[{points:[{x:.2,y:.3},{x:.4,y:.5}]}],canvas);
 assert(width<=640&&height<=480);assert(jpeg.length<=24000);assert.equal(ops[0],'textbook');assert.equal(ops.filter(v=>v==='stroke').length,2);assert.match(ops[1],/^move:/);
});
test('an unloaded textbook cannot be replaced with fabricated image data',async()=>{
 await assert.rejects(captureClassroomBoard({complete:false} as HTMLImageElement,[],{} as HTMLCanvasElement));
});
