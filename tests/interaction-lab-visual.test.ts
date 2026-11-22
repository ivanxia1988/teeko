import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {labVisualContext,parseLabVisualMessage} from '../lib/interaction-lab-visual';
import {teacherSnapshot} from './teacher-runtime-fixture';
import {ROBOT_READING_COURSE} from '../lib/server/robot-reading-course';

test('lab visuals allow finite page coordinates, never geometry on ordinary board frames or unrelated data',()=>{
 const stage={type:'lab.visual.stage',contextKey:'task',id:randomUUID(),kind:'region',point:{x:0,y:1}};
 assert.deepEqual(parseLabVisualMessage(stage),stage);
 assert.deepEqual(parseLabVisualMessage({...stage,textId:'passage-machine'}),{...stage,textId:'passage-machine'});
 assert.equal(parseLabVisualMessage({...stage,textId:'off-page-word'}),null);
 assert.equal(parseLabVisualMessage({type:'lab.visual.stage',contextKey:'task',id:stage.id,kind:'board',textId:'passage-machine'}),null);
 for(const invalid of [{...stage,point:{x:1.01,y:0}},{...stage,point:{x:NaN,y:0}},{...stage,point:{x:0,y:0,screenX:10}},{...stage,kind:'board'},{...stage,photoFrom:'camera'}])assert.equal(parseLabVisualMessage(invalid),null);
 const ready={type:'lab.visual.ready',contextKey:'task',id:stage.id,image:'/9j/2Q=='};
 assert.deepEqual(parseLabVisualMessage(ready),ready);
 for(const image of ['data:image/jpeg;base64,/9j/2Q==','A'.repeat(24004),'not an image'])assert.equal(parseLabVisualMessage({...ready,image}),null);
 assert.equal(parseLabVisualMessage({...ready,source:'camera'}),null);
});

test('lab visual scope survives same-page state updates but not task or connection changes',()=>{
 const snap=teacherSnapshot({course:ROBOT_READING_COURSE,stepIndex:0});
 const scope=labVisualContext(snap);
 assert(scope);
 assert.equal(labVisualContext({...snap,revision:snap.revision+1}),scope);
 assert.notEqual(labVisualContext({...snap,stepIndex:1}),scope);
 assert.notEqual(labVisualContext({...snap,connectionEpoch:snap.connectionEpoch+1}),scope);
 assert.equal(labVisualContext({...snap,status:'paused'}),'');
});
