import test from 'node:test';
import assert from 'node:assert/strict';
import {buildClassroomChalkCandidate,parseClassroomChalkCandidate,spokenChalkReference} from '../lib/server/classroom-chalk-candidate';
const context={logicalSessionId:'10000000-0000-4000-8000-000000000001',courseVersion:'picnic-v2',connectionEpoch:1,stateRevision:3,pageId:'picnic',activityId:'apples'};
const source={context,evidenceItemId:'child-1',decision:{decision:'retry',confidence:'high',reason:'private reason',suggestedResponse:'I like apples.',nextAction:'model'},hints:2};
test('a short supported model response produces a bounded private candidate without reasoning or scores',()=>{
 const candidate=buildClassroomChalkCandidate(source);assert.deepEqual(candidate,{context,evidenceItemId:'child-1',text:'I like apples.',seconds:8});assert.equal(parseClassroomChalkCandidate({...candidate,score:1}),null);
});
test('no automatic chalk for first support, conversation, correct, uncertainty or a non-model response',()=>{
 for(const changed of [{hints:1},{hints:0},...['conversation','correct','clarify'].map(decision=>({decision:{...source.decision,decision}})),{decision:{...source.decision,confidence:'low'}},{decision:{...source.decision,nextAction:'hint'}}])assert.equal(buildClassroomChalkCandidate({...source,...changed}),null);
});
test('invalid, oversized or credential-like references never leave the candidate boundary',()=>{
 for(const text of ['', 'x'.repeat(121),'Line\nbreak','sk-'+'a'.repeat(40)])assert.equal(buildClassroomChalkCandidate({...source,decision:{...source.decision,suggestedResponse:text}}),null);
 assert.equal(buildClassroomChalkCandidate({...source,evidenceItemId:'bad\ninput'}),null);assert.equal(buildClassroomChalkCandidate({...source,context:{...context,stateRevision:NaN}}),null);
});
test('oral text must contain the reference with word boundaries, including split or varied punctuation',()=>{
 assert.equal(spokenChalkReference('You could say: I like apples!','I like apples.'),true);assert.equal(spokenChalkReference('I like applesauce.','I like apples.'),false);assert.equal(spokenChalkReference('Older unrelated text.','I like apples.'),false);
});
