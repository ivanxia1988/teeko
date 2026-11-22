import test from 'node:test';
import assert from 'node:assert/strict';
import {labBrowserWireEvent} from '../lib/interaction-lab';

test('experimental point mirrors object and task IDs but never raw payload or coordinates',()=>{
 const result=labBrowserWireEvent({type:'interaction.point',eventId:'point-1',objectId:'wings',context:{pageId:'robot-predict',activityId:'predict',stateRevision:1,connectionEpoch:1},x:0.42,y:0.7,arbitrary:'fixture'});
 assert.deepEqual(result?.data,{event:'interaction.point',pointId:'point-1',objectId:'wings',pageId:'robot-predict',activityId:'predict',connectionEpoch:1,stateRevision:1,coordinatesSent:false,imageSent:false});
});
test('image and text metadata omit bytes and unredacted content',()=>{
 const picture=labBrowserWireEvent({type:'board.frame',image:'/9j/2Q==',sequence:2});
 assert.equal(picture?.data?.format,'JPEG');assert.equal(picture?.data?.bytes,4);assert(!JSON.stringify(picture).includes('/9j/2Q=='));
 const typed=labBrowserWireEvent({type:'text',text:'Circle the wings!'});
 assert.deepEqual(typed?.data,{event:'text',characters:17});assert.equal(typed?.transcript,undefined);
 assert.equal(labBrowserWireEvent({type:'audio',audio:'not-recorded'}),null);
 assert.equal(labBrowserWireEvent({type:'diagnostic.playback',phase:'playback_sample'}),null);
 assert.equal(labBrowserWireEvent({type:'diagnostic.playback',phase:'playback_started',turnId:'turn-1',elapsedMs:25})?.data?.elapsedMs,25);
});

test('the lab timeline distinguishes local staging, sending to the lab and provider delivery',()=>{
 const prepared=labBrowserWireEvent({type:'lab.visual.stage',kind:'region',id:'frame-1',contextKey:'room',point:{x:.32,y:.78}});
 assert.deepEqual(prepared?.data,{event:'lab.visual.stage',visualId:'frame-1',kind:'region',x:.32,y:.78,providerSent:false});
 const textPoint=labBrowserWireEvent({type:'lab.visual.stage',kind:'region',id:'frame-2',point:{x:.424,y:.695},textId:'passage-machine',word:'untrusted text'});
 assert.equal(textPoint?.kind,'point');assert.equal(textPoint?.data?.textId,'passage-machine');assert.equal(textPoint?.data?.word,'machine');
 const staged=labBrowserWireEvent({type:'lab.visual.ready',id:'frame-1',contextKey:'room',image:'/9j/2Q=='});
 assert.equal(staged?.data?.bytes,4);assert.equal(staged?.data?.providerSent,false);assert(!JSON.stringify(staged).includes('/9j/2Q=='));
});
