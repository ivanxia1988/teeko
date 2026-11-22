import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {AdminError,AdminService,initializeTeacherAgents,resolvePublishedTeacher} from '../lib/server/admin-service';
import {ClassroomService,DEFAULT_CLASSROOM_PREFERENCES} from '../lib/server/classroom-service';
import {publishTrialCourses} from '../lib/server/course-catalog';
import {ModelCredentialsError,ModelCredentialsService} from '../lib/server/model-credentials';
import {DEFAULT_TEACHER_AGENT,DEFAULT_TEACHER_MODELS,type TeacherAgentInput,type FrozenTeacherConfig} from '../lib/teacher-agent';

const database=process.env.TEST_DATABASE_URL;
if(database){
 const url=new URL(database);
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!/^\/[A-Za-z0-9_]*test[A-Za-z0-9_]*$/.test(url.pathname)||url.search||url.hash)throw new Error('Use a loopback disposable test database without connection overrides.');
}
const secret='synthetic-grok-protection-secret-at-least-32-bytes';
const environment={OPENAI_API_KEY:'synthetic-environment-openai',DASHSCOPE_API_KEY:'synthetic-environment-qwen',DASHSCOPE_WORKSPACE_ID:'fixture-workspace',DASHSCOPE_REGION:'cn-beijing',XAI_API_KEY:'synthetic-environment-grok'};
const grok=DEFAULT_TEACHER_MODELS.find(entry=>entry.input.provider==='grok'&&entry.input.purpose==='realtime')!;
const openai=DEFAULT_TEACHER_MODELS.find(entry=>entry.input.provider==='openai'&&entry.input.purpose==='realtime')!;
const migrations=['0001_accounts.sql','0002_classrooms.sql','0003_teacher_agents.sql','0004_admin_auth.sql','0005_model_credentials.sql','0006_classroom_journal.sql','0007_classroom_notes.sql','0008_grok_credentials.sql'];
async function fixture(t:TestContext){
 const administrator=new Pool({connectionString:database}),schema=`grok_config_test_${randomUUID().replaceAll('-','')}`;
 const pool=new Pool({connectionString:database,options:`-c search_path=${schema},public`,max:4});
 let created=false;
 t.after(async()=>{try{await pool.end();if(created)await administrator.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await administrator.end();}});
 await administrator.query(`CREATE SCHEMA ${schema}`);created=true;
 for(const name of migrations)await pool.query(await readFile(new URL(`../db/migrations/${name}`,import.meta.url),'utf8'));
 await publishTrialCourses(pool);await initializeTeacherAgents(pool);
 const createAccount=async(profile=false)=>{
  const id=randomUUID();
  await pool.query("INSERT INTO teeko_accounts(id,email,password_hash,consent_version,consented_at,created_at) VALUES($1,$2,'synthetic','fixture',now(),now())",[id,`${id}@example.test`]);
  if(profile)await pool.query("INSERT INTO teeko_profiles(account_id,name,age_range,level,updated_at) VALUES($1,'Synthetic learner','10–11','starter',now())",[id]);
  return id;
 };
 const owner=await createAccount(),other=await createAccount(),learner=await createAccount(true);
 const admin=new AdminService(pool);await admin.grantAdmin(owner);
 const values:Record<string,string>={...environment};
 const credentials=new ModelCredentialsService(pool,{secret,environment:name=>values[name]});
 return {pool,admin,credentials,owner,other,learner,values,createAccount,classrooms:new ClassroomService(pool)};
}
const credentialRejects=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,error=>error instanceof ModelCredentialsError&&error.code===code);
const adminRejects=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,error=>error instanceof AdminError&&error.code===code);
const grokOnly=():TeacherAgentInput=>({...structuredClone(DEFAULT_TEACHER_AGENT),name:'Synthetic Grok-only teacher',routes:{qwen:{realtimeModelId:null,reasoningModelId:null},openai:{realtimeModelId:null,reasoningModelId:null,visionModelId:null},grok:{realtimeModelId:grok.id,reasoningModelId:null}}});
function assertNoCredentials(value:unknown,...keys:string[]){
 const text=JSON.stringify(value);for(const key of keys)assert(!text.includes(key),'Credential plaintext must not appear in public metadata or frozen configuration.');
 for(const field of ['apiKey','ciphertext','nonce','auth_tag'])assert(!text.includes(`"${field}"`),'Credential storage fields must not appear in configuration.');
}

test('Grok PG initialization inserts six models idempotently without granting administrators',{skip:!database},async t=>{
 const f=await fixture(t);await initializeTeacherAgents(f.pool);
 const config=await f.admin.config(f.owner);
 assert.equal(config.models.length,6);assert.equal(grok.id,'20000000-0000-4000-8000-000000000006');assert.equal(grok.input.model,'grok-voice-3.0');
 assert.equal(config.models.filter(model=>model.provider==='grok'&&model.purpose==='realtime').length,1);
 assert.equal((await f.pool.query('SELECT count(*)::int count FROM teeko_teacher_releases')).rows[0].count,1);
 assert.equal(await f.admin.isAdmin(f.other),false);
 assert.equal((await resolvePublishedTeacher(f.pool))?.routes.grok?.realtime.model,'grok-voice-3.0');
});

test('Grok-only publication freezes the supported realtime model with optional null reasoning',{skip:!database},async t=>{
 const f=await fixture(t),agent=await f.admin.createAgent(f.owner,grokOnly());
 const published=await f.admin.publishAgent(f.owner,agent.id,agent.revision),frozen=await resolvePublishedTeacher(f.pool);
 assert.equal(frozen?.id,published.id);assert.equal(frozen?.routes.qwen,null);assert.equal(frozen?.routes.openai,null);
 assert.equal(frozen?.routes.grok?.realtime.id,grok.id);assert.equal(frozen?.routes.grok?.realtime.model,'grok-voice-3.0');assert.equal(frozen?.routes.grok?.reasoning,null);
 const created=await f.classrooms.create(f.learner,'picnic',{...DEFAULT_CLASSROOM_PREFERENCES,provider:'grok'});
 assert.deepEqual((await f.classrooms.teacherRuntime(f.learner,created.id)).config,frozen);assertNoCredentials(created,environment.XAI_API_KEY);
});

test('legacy releases without Grok stay unchanged and only a new publication enables new Grok classrooms',{skip:!database},async t=>{
 const f=await fixture(t),original=await resolvePublishedTeacher(f.pool);assert(original);
 const legacy=structuredClone(original) as FrozenTeacherConfig;delete legacy.routes.grok;delete legacy.voices.grok;
 await f.pool.query('UPDATE teeko_teacher_releases SET config=$2 WHERE id=$1',[legacy.id,JSON.stringify(legacy)]);
 const created=await f.classrooms.create(f.learner,'picnic',{...DEFAULT_CLASSROOM_PREFERENCES,provider:'qwen'});
 const frozen=await f.classrooms.teacherRuntime(f.learner,created.id);
 assert.deepEqual(frozen.config,legacy);
 const agent=await f.admin.createAgent(f.owner,grokOnly());
 await f.credentials.set(f.owner,grok.id,{provider:'grok',expectedRevision:0,apiKey:'synthetic-draft-only-grok-key'});
 await initializeTeacherAgents(f.pool);assert.deepEqual(await resolvePublishedTeacher(f.pool),legacy);
 const newLearner=await f.createAccount(true);
 await assert.rejects(f.classrooms.create(newLearner,'picnic',{...DEFAULT_CLASSROOM_PREFERENCES,provider:'grok'}),error=>error instanceof Error&&'code'in error&&error.code==='VOICE_UNAVAILABLE');
 const published=await f.admin.publishAgent(f.owner,agent.id,agent.revision);
 const next=await f.classrooms.create(newLearner,'picnic',{...DEFAULT_CLASSROOM_PREFERENCES,provider:'grok'});
 assert.equal((await f.classrooms.teacherRuntime(newLearner,next.id)).config?.id,published.id);
 assert.deepEqual((await f.classrooms.teacherRuntime(f.learner,created.id)).config,legacy);
 assert.deepEqual((await f.pool.query('SELECT config FROM teeko_teacher_releases WHERE id=$1',[legacy.id])).rows[0].config,legacy);
});

test('saved Grok drafts and rotated keys do not mutate releases while the next resolve uses the new credential',{skip:!database},async t=>{
 const f=await fixture(t),input=grokOnly(),agent=await f.admin.createAgent(f.owner,input);
 await f.admin.publishAgent(f.owner,agent.id,agent.revision);
 const frozen=await resolvePublishedTeacher(f.pool);assert(frozen?.routes.grok);
 const keyOne='synthetic-first-grok-model-key',keyTwo='synthetic-replacement-grok-model-key';
 const firstStatus=await f.credentials.set(f.owner,grok.id,{provider:'grok',expectedRevision:0,apiKey:keyOne});
 assert.equal((await f.credentials.resolve(frozen.routes.grok.realtime)).apiKey,keyOne);
 const changed=await f.admin.updateAgent(f.owner,agent.id,agent.revision,{...input,systemPrompt:'A future synthetic teacher prompt that has not yet been published.'});
 const changedModel=await f.admin.updateModel(f.owner,grok.id,1,{...grok.input,name:'Future Grok model display name'});
 const secondStatus=await f.credentials.set(f.owner,grok.id,{provider:'grok',expectedRevision:firstStatus.revision,apiKey:keyTwo});
 assert.equal(secondStatus.revision,2);assert.equal((await f.credentials.resolve(frozen.routes.grok.realtime)).apiKey,keyTwo);
 assert.deepEqual(await resolvePublishedTeacher(f.pool),frozen);
 assertNoCredentials([await f.admin.config(f.owner),frozen,firstStatus,secondStatus,await f.credentials.status(f.owner,grok.id)],keyOne,keyTwo,environment.XAI_API_KEY);
 const next=await f.admin.publishAgent(f.owner,changed.id,changed.revision),nextFrozen=await resolvePublishedTeacher(f.pool);
 assert.equal(nextFrozen?.id,next.id);assert.equal(nextFrozen?.routes.grok?.realtime.revision,changedModel.revision);assert.equal(nextFrozen?.systemPrompt,changed.systemPrompt);
 assert.deepEqual((await f.pool.query('SELECT config FROM teeko_teacher_releases WHERE id=$1',[frozen.id])).rows[0].config,frozen);
});

test('Grok publication rejects wrong-provider, wrong-purpose, disabled and absent live bindings',{skip:!database},async t=>{
 const f=await fixture(t);
 const reasoning=await f.admin.createModel(f.owner,{name:'Synthetic Grok reasoning',provider:'grok',purpose:'reasoning',model:'grok-4',enabled:true});
 const disabled=await f.admin.createModel(f.owner,{...grok.input,name:'Disabled Grok fixture',enabled:false});
 for(const modelId of [openai.id,reasoning.id,disabled.id,null]){
  const input=grokOnly();input.routes.grok={realtimeModelId:modelId,reasoningModelId:null};
  const agent=await f.admin.createAgent(f.owner,input);await adminRejects(f.admin.publishAgent(f.owner,agent.id,agent.revision),'MODEL_BINDING');
 }
});

test('Grok ciphertext and authentication metadata fail closed under wrong-key, cross-model and cross-provider copies',{skip:!database},async t=>{
 const f=await fixture(t),apiKey='synthetic-encrypted-grok-model-key';
 const status=await f.credentials.set(f.owner,grok.id,{provider:'grok',expectedRevision:0,apiKey});assert.equal(status.configured,true);
 const stored=(await f.pool.query('SELECT * FROM teeko_model_credentials WHERE model_id=$1',[grok.id])).rows[0];
 assert.equal(stored.provider,'grok');assert(Buffer.isBuffer(stored.ciphertext));assert(!stored.ciphertext.includes(Buffer.from(apiKey)));assert.equal(stored.nonce.length,12);assert.equal(stored.auth_tag.length,16);
 const wrongKey=new ModelCredentialsService(f.pool,{secret:'different-synthetic-protection-secret-at-least-32-bytes',environment:name=>f.values[name]});
 await credentialRejects(wrongKey.resolve({id:grok.id,provider:'grok'}),'CREDENTIALS_UNAVAILABLE');assert.equal((await wrongKey.status(f.owner,grok.id)).configured,false);
 await credentialRejects(f.credentials.resolve({id:grok.id,provider:'openai'}),'CREDENTIALS_UNAVAILABLE');
 const target=await f.admin.createModel(f.owner,{...grok.input,name:'Second Grok model fixture'});
 for(const [id,provider] of [[target.id,'grok'],[openai.id,'openai']]){
  await f.pool.query('INSERT INTO teeko_model_credentials(model_id,provider,revision,version,ciphertext,nonce,auth_tag,updated_at) SELECT $1,$2,revision,version,ciphertext,nonce,auth_tag,updated_at FROM teeko_model_credentials WHERE model_id=$3',[id,provider,grok.id]);
  assert.equal((await f.credentials.status(f.owner,id)).configured,false);
  await credentialRejects(f.credentials.resolve({id,provider:provider as 'grok'|'openai'}),'CREDENTIALS_UNAVAILABLE');
 }
 await f.pool.query('UPDATE teeko_model_credentials SET ciphertext=set_byte(ciphertext,0,(get_byte(ciphertext,0)+1)%256) WHERE model_id=$1',[grok.id]);
 await credentialRejects(f.credentials.resolve({id:grok.id,provider:'grok'}),'CREDENTIALS_UNAVAILABLE');
});

test('Grok credential status, writes, resets and publication recheck independent administrator authorization',{skip:!database},async t=>{
 const f=await fixture(t),input={provider:'grok' as const,expectedRevision:0,apiKey:'synthetic-permission-grok-key'};
 await credentialRejects(f.credentials.status(f.other,grok.id),'FORBIDDEN');await credentialRejects(f.credentials.set(f.other,grok.id,input),'FORBIDDEN');
 await credentialRejects(f.credentials.reset(f.other,grok.id,{provider:'grok',expectedRevision:0}),'FORBIDDEN');await credentialRejects(f.credentials.importDefaults(f.other),'FORBIDDEN');
 await adminRejects(f.admin.createAgent(f.other,grokOnly()),'FORBIDDEN');
 const agent=await f.admin.createAgent(f.owner,grokOnly());await adminRejects(f.admin.publishAgent(f.other,agent.id,agent.revision),'FORBIDDEN');
 await credentialRejects(f.credentials.set(f.owner,grok.id,{provider:'openai',expectedRevision:0,apiKey:input.apiKey}),'PROVIDER_MISMATCH');
 await credentialRejects(f.credentials.set(f.owner,openai.id,input),'PROVIDER_MISMATCH');
 const saved=await f.credentials.set(f.owner,grok.id,input);
 await f.admin.revokeAdmin(f.owner);await credentialRejects(f.credentials.status(f.owner,grok.id),'FORBIDDEN');
 await credentialRejects(f.credentials.reset(f.owner,grok.id,{provider:'grok',expectedRevision:saved.revision}),'FORBIDDEN');
 await adminRejects(f.admin.publishAgent(f.owner,agent.id,agent.revision),'FORBIDDEN');
});

test('Grok reset preserves revision tombstones and startup import cannot restore an old override',{skip:!database},async t=>{
 const f=await fixture(t);assert.equal(await f.credentials.importDefaults(f.owner),6);assert.equal(await f.credentials.importDefaults(f.owner),0);
 const saved=await f.credentials.set(f.owner,grok.id,{provider:'grok',expectedRevision:1,apiKey:'synthetic-removed-grok-model-key'});
 const reset=await f.credentials.reset(f.owner,grok.id,{provider:'grok',expectedRevision:saved.revision});
 assert.equal(reset.revision,3);assert.equal(reset.source,'environment');assert.equal(reset.configured,true);
 assert.deepEqual((await f.pool.query('SELECT ciphertext,nonce,auth_tag FROM teeko_model_credentials WHERE model_id=$1',[grok.id])).rows[0],{ciphertext:null,nonce:null,auth_tag:null});
 await initializeTeacherAgents(f.pool);assert.equal(await f.credentials.importDefaults(f.owner),0);assert.equal((await f.credentials.status(f.owner,grok.id)).revision,3);
 assert.equal((await f.credentials.resolve({id:grok.id,provider:'grok'})).apiKey,environment.XAI_API_KEY);
 await credentialRejects(f.credentials.set(f.owner,grok.id,{provider:'grok',expectedRevision:2,apiKey:'synthetic-stale-grok-model-key'}),'STALE');
 delete f.values.XAI_API_KEY;assert.equal((await f.credentials.status(f.owner,grok.id)).source,'missing');
 await credentialRejects(f.credentials.resolve({id:grok.id,provider:'grok'}),'CREDENTIALS_UNAVAILABLE');
});
