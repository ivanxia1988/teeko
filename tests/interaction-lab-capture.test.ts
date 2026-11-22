import assert from 'node:assert/strict';
import test from 'node:test';
import {captureLabRegion,labRegionCrop} from '../lib/interaction-lab-capture';

test('textbook crop stays within the source and preserves the clicked position at centers and edges',()=>{
 assert.deepEqual(labRegionCrop(900,720,{x:.5,y:.5}),{left:216,top:216,w:468,h:288,x:.5,y:.5});
 assert.deepEqual(labRegionCrop(900,720,{x:0,y:1}),{left:0,top:432,w:468,h:288,x:0,y:1});
});

test('capture draws only the requested crop, embeds coordinates, and adds a marked JPEG',async()=>{
 const image={complete:true,naturalWidth:900,naturalHeight:720} as HTMLImageElement;
 const drawn:unknown[][]=[],label:unknown[][]=[],strokes:unknown[][]=[];
 const context={fillRect(){},drawImage(...args:unknown[]){drawn.push(args);},fillText(...args:unknown[]){label.push(args);},save(){},restore(){},beginPath(){},rect(){},clip(){},moveTo(...args:unknown[]){strokes.push(args);},lineTo(){},stroke(){}};
 const canvas={width:0,height:0,getContext(){return context;},toBlob(cb:(blob:Blob)=>void){cb(new Blob([Uint8Array.from([255,216,255,217])],{type:'image/jpeg'}));}} as unknown as HTMLCanvasElement;
 assert.equal(await captureLabRegion(image,{x:.5,y:.5},canvas),'/9j/2Q==');
 assert.deepEqual(drawn,[[image,216,216,468,288,0,24,468,288]]);
 assert.deepEqual([canvas.width,canvas.height],[468,312]);
 assert.match(String(label[0][0]),/TEXTBOOK DETAIL.*0\.500 Y 0\.500/);
 assert.deepEqual(strokes[0],[218,168]);
});
