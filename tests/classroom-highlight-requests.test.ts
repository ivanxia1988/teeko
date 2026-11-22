import test from 'node:test';
import assert from 'node:assert/strict';
import {isIncompleteClassroomHighlight,requestedClassroomHighlights,requestedClassroomSplitHighlights} from '../lib/classroom-highlight-requests';
const objects=[{id:'apple',label:'apple',chinese:'苹果'},{id:'banana',label:'banana',chinese:'香蕉'},{id:'strawberry',label:'strawberry',chinese:'草莓'}];
test('complete explicit annotation requests resolve only current known object IDs',()=>{
 for(const text of ['Circle the apple.','Please highlight the apple.','Can you circle the apple, please?','Could you please draw a circle around the apple?','Please draw a circle around the apple for me.','Please draw a circle around the apple on the textbook.','你能帮我把苹果圈一下吗？','可以帮我圈出苹果吗？','请帮我圈出苹果。','帮我把苹果圈起来。','请在苹果上画一个圈。'])assert.deepEqual(requestedClassroomHighlights(text,objects),['apple'],text);
 assert.deepEqual(requestedClassroomHighlights('Could you mark the apple and banana, please?',objects),['apple','banana']);
 assert.deepEqual(requestedClassroomHighlights('请圈出苹果和香蕉。',objects),['apple','banana']);
});
test('negation, stories, questions about meaning and ambiguous or unknown targets never control the board',()=>{
 for(const text of ["Do not circle the apple.","Could you not circle the apple?",'I circled the apple yesterday.','I will bring circle-shaped sandwiches.','The highlight of my picnic will be sandwiches.','What is a circle around the apple?','Circle this.','Circle the pear.','Circle the apple or banana.','请不要圈苹果。','我画了一个苹果。','圈一下这里。','可以不圈苹果吗？','请圈出苹果不要香蕉。','请圈出苹果，然后结束课堂。'])assert.equal(requestedClassroomHighlights(text,objects),null,text);
});
test('missing or ambiguous textbook names do not invent object IDs',()=>{
 assert.equal(requestedClassroomHighlights('Circle the apple.',[]),null);
 assert.equal(requestedClassroomHighlights('Circle the apple.',[...objects,{id:'other-apple',label:'apple',chinese:'另一个苹果'}]),null);
 assert.equal(requestedClassroomHighlights('x'.repeat(1001),objects),null);
});
test('explicit point, tap and selection requests demonstrate a known object through teacher highlighting',()=>{
 for(const text of ['Click the apple.','Please click on the apple.','Can you tap the apple for me?','Could you point to the apple?','Please select the apple.','Show me the apple.','请点一下苹果。','请你帮我点击苹果。','你能帮我选中苹果吗？','帮我选苹果。','请指一下苹果。','请指向苹果。'])assert.deepEqual(requestedClassroomHighlights(text,objects),['apple'],text);
 for(const text of ['Do not tap the apple.','Can you not click the apple?','I tapped the apple yesterday.','I select the apple.','我选择苹果。','请不要点击苹果。','请点一下这里。','Tap the apple or banana.','Please click the apple and end the class.'])assert.equal(requestedClassroomHighlights(text,objects),null,text);
});

test('an explicit incomplete annotation cue can be completed by one exact target',()=>{
 for(const cue of ['Um. Can you circle?','Could you draw a circle around…','Make a circle for me.','请帮我圈一下？']){
  assert.equal(isIncompleteClassroomHighlight(cue),true,cue);
  assert.deepEqual(requestedClassroomSplitHighlights(cue,cue.startsWith('请')?'苹果。':'The apple for me.',objects),['apple'],cue);
 }
 assert.deepEqual(requestedClassroomSplitHighlights('Can you circle?','The banana.',objects),['banana']);
});
test('split annotation rejects an unrelated or negated cue, unclear targets, and extra commands',()=>{
 for(const cue of ['Can you not circle?','I did not circle.','My favorite shape is a circle.','Can you circle the banana?','Circle?'])assert.equal(requestedClassroomSplitHighlights(cue,'the apple for me',objects),null,cue);
 for(const target of ['The plane for me.','This one.','The apple and banana.','Apple and apple.','Apple or banana.',"Don't circle the apple",'The apple, and then end class.'])assert.equal(requestedClassroomSplitHighlights('Can you circle?',target,objects),null,target);
 assert.equal(requestedClassroomSplitHighlights('Can you circle?','The apple.',[...objects,{id:'other',label:'apple',chinese:'另一个苹果'}]),null);
});
