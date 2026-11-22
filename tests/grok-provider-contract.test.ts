import test from 'node:test';
import assert from 'node:assert/strict';
import {teacherProviderSchema,teacherModelInputSchema,teacherAgentInputSchema,DEFAULT_TEACHER_AGENT,DEFAULT_TEACHER_MODELS} from '../lib/teacher-agent';
import {modelCredentialInputSchema,modelCredentialStatusSchema} from '../lib/model-credentials';
import {preferencesSchema} from '../lib/server/classroom-http';
import {classroomJournalClassroomSchema,sanitizeClassroomJournalEntry} from '../lib/classroom-journal';

test('Grok is a distinct third classroom provider with a fixed default voice model',()=>{
 assert(teacherProviderSchema.safeParse('grok').success);
 const model=DEFAULT_TEACHER_MODELS.find(value=>value.input.provider as string==='grok');assert(model);assert.equal(model.input.model,'grok-voice-3.0');assert.equal(model.input.purpose,'realtime');assert(teacherModelInputSchema.safeParse(model.input).success);
 assert(preferencesSchema.safeParse({provider:'grok',language:'english',style:'gentle',voice:'female',soundEffects:true}).success);
});
test('old agent drafts normalize without inventing a Grok route while an explicit draft can enable it',()=>{
 const legacy={...DEFAULT_TEACHER_AGENT,routes:{qwen:DEFAULT_TEACHER_AGENT.routes.qwen,openai:DEFAULT_TEACHER_AGENT.routes.openai},voices:{qwen:DEFAULT_TEACHER_AGENT.voices.qwen,openai:DEFAULT_TEACHER_AGENT.voices.openai}};
 const old=teacherAgentInputSchema.parse(legacy);assert.deepEqual(old.routes.grok,{realtimeModelId:null,reasoningModelId:null});assert.deepEqual(old.voices.grok,{female:'eve',male:'rex'});
 const model=DEFAULT_TEACHER_MODELS.find(value=>value.input.provider as string==='grok');assert(model);assert(teacherAgentInputSchema.safeParse({...legacy,routes:{...legacy.routes,grok:{realtimeModelId:model.id,reasoningModelId:null}},voices:{...legacy.voices,grok:{female:'ara',male:'leo'}}}).success);
});
test('Grok credentials use a separate bounded encrypted-store contract without workspace or secret-bearing status',()=>{
 assert(modelCredentialInputSchema.safeParse({provider:'grok',expectedRevision:0,apiKey:'fixture-grok-secret'}).success);
 assert(!modelCredentialInputSchema.safeParse({provider:'grok',expectedRevision:0,apiKey:'fixture-grok-secret',workspaceId:'other-space'}).success);
 const status={provider:'grok',source:'model',configured:true,revision:1,updatedAt:null};assert(modelCredentialStatusSchema.safeParse(status).success);assert(!modelCredentialStatusSchema.safeParse({...status,apiKey:'fixture-grok-secret'}).success);
});
test('journal trace fields retain bounded explicit correlation and a third-provider classroom',()=>{
 const trace={turnId:'10000000-0000-4000-8000-000000000001',spanId:'10000000-0000-4000-8000-000000000002',phase:'audio_first_received',clock:'server',elapsedMs:230,queueMs:50,rttMs:120};const event=sanitizeClassroomJournalEntry({eventKey:'trace:test',kind:'connection',actor:'provider',status:'recorded',name:'diagnostic_phase',details:trace});assert.deepEqual(event.details,trace);
 const invalid=sanitizeClassroomJournalEntry({eventKey:'trace:bad',kind:'connection',actor:'application',status:'recorded',name:'diagnostic_phase',details:{turnId:'bad',phase:'raw-secret',clock:'untrusted',elapsedMs:-1}});assert.equal(Object.keys(invalid.details!).length,0);
 const room={id:trace.turnId,accountId:trace.spanId,email:'fixture@example.test',childName:'Fixture',courseTitle:'Picnic',provider:'grok',status:'active',startedAt:'2026-11-12T00:00:00Z',endedAt:null,elapsedSeconds:0,agentName:null,agentVersion:null,model:'grok-voice-3.0',eventCount:0};assert(classroomJournalClassroomSchema.safeParse(room).success);
});
