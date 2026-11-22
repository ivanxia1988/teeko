import type {Point} from './types';
import {LAB_VISUAL_MAX_BYTES} from './interaction-lab-visual';

const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const HEADER_HEIGHT=24;

export function labRegionCrop(width:number,height:number,point:Point){
 const x=clamp(point.x,0,1),y=clamp(point.y,0,1);
 const w=Math.max(1,Math.round(width*.52)),h=Math.max(1,Math.round(height*.40));
 const left=clamp(Math.round(x*width-w/2),0,width-w),top=clamp(Math.round(y*height-h/2),0,height-h);
 return {left,top,w,h,x:clamp((x*width-left)/w,0,1),y:clamp((y*height-top)/h,0,1)};
}

/** Only draws pixels from the current textbook image. Neither the browser nor the camera is captured. */
export async function captureLabRegion(image:HTMLImageElement,point:Point,canvas:HTMLCanvasElement=document.createElement('canvas')):Promise<string>{
 if(!image.complete||!image.naturalWidth||!image.naturalHeight||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw Error('教材局部暂未就绪。');
 const crop=labRegionCrop(image.naturalWidth,image.naturalHeight,point),scale=Math.min(1,480/crop.w,400/crop.h);
 canvas.width=Math.max(1,Math.round(crop.w*scale));
 const imageHeight=Math.max(1,Math.round(crop.h*scale));
 canvas.height=imageHeight+HEADER_HEIGHT;
 const context=canvas.getContext('2d');
 if(!context)throw Error('教材局部暂时无法发送。');
 context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
 context.drawImage(image,crop.left,crop.top,crop.w,crop.h,0,HEADER_HEIGHT,canvas.width,imageHeight);
 context.fillStyle='#26334a';context.font='11px sans-serif';
 context.fillText(`TEXTBOOK DETAIL • PAGE X ${point.x.toFixed(3)} Y ${point.y.toFixed(3)}`,6,16,Math.max(1,canvas.width-12));
 const x=crop.x*canvas.width,y=HEADER_HEIGHT+crop.y*imageHeight;
 context.save();context.beginPath();context.rect(0,HEADER_HEIGHT,canvas.width,imageHeight);context.clip();
 context.beginPath();
 context.moveTo(x-16,y);context.lineTo(x-5,y);context.moveTo(x+5,y);context.lineTo(x+16,y);
 context.moveTo(x,y-16);context.lineTo(x,y-5);context.moveTo(x,y+5);context.lineTo(x,y+16);
 context.lineWidth=7;context.strokeStyle='#fffdf6';context.stroke();
 context.lineWidth=3;context.strokeStyle='#c24a21';context.stroke();context.restore();
 for(const quality of [.70,.48,.28]){
  const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
  if(!blob||blob.type!=='image/jpeg')throw Error('教材局部暂时无法发送。');
  if(blob.size>LAB_VISUAL_MAX_BYTES)continue;
  const bytes=new Uint8Array(await blob.arrayBuffer());
  if(bytes[0]!==255||bytes[1]!==216)throw Error('教材局部暂时无法发送。');
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary);
 }
 throw Error('教材局部画面过大，请稍后重试。');
}
