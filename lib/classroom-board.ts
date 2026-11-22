import type {ClassroomSnapshot} from './classroom-contract';
import type {Point} from './types';

export type ClassroomBoardInput={image:string;contextKey:string};
export function classroomBoardContext(snapshot:ClassroomSnapshot):string{
 const task=snapshot.course.steps[snapshot.stepIndex];
 return JSON.stringify([snapshot.id,snapshot.connectionEpoch,snapshot.revision,snapshot.course.version,task?.pageId,task?.id]);
}
export type BoardStroke={points:Point[]};
/** Captures only the published textbook and local pen strokes, never the browser or camera. */
export async function captureClassroomBoard(image:HTMLImageElement,strokes:BoardStroke[],canvas:HTMLCanvasElement=document.createElement('canvas')):Promise<string>{
 if(!image.complete||!image.naturalWidth||!image.naturalHeight)throw new Error('教材画面暂未就绪。');
 const scale=Math.min(1,640/image.naturalWidth,456/image.naturalHeight);
 canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale))+24;
 const context=canvas.getContext('2d');if(!context)throw new Error('教材画面暂时无法发送。');
 context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='#26334a';context.font='12px sans-serif';context.fillText('TEXTBOOK + LEARNER PEN MARKS',6,16);
 context.drawImage(image,0,24,canvas.width,canvas.height-24);
 for(const stroke of strokes.slice(-80)){
  if(stroke.points.length<2)continue;
  context.beginPath();
  stroke.points.slice(0,600).forEach((point,index)=>{const x=Math.max(0,Math.min(1,point.x))*canvas.width,y=24+Math.max(0,Math.min(1,point.y))*(canvas.height-24);if(index)context.lineTo(x,y);else context.moveTo(x,y);});
  context.lineCap='round';context.lineJoin='round';context.strokeStyle='#fffdf6';context.lineWidth=8*scale;context.stroke();context.strokeStyle='#c95739';context.lineWidth=4*scale;context.stroke();
 }
 for(const quality of [.65,.45,.25]){
  const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
  if(!blob||blob.type!=='image/jpeg')throw new Error('教材画面暂时无法发送。');
  if(blob.size>18000)continue;
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  if(bytes[0]!==255||bytes[1]!==216)throw new Error('教材画面暂时无法发送。');
  return btoa(binary);
 }
 throw new Error('教材画面过大，请稍后重试。');
}
