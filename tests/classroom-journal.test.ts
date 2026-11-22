import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeClassroomJournalEntry,classroomJournalListQuerySchema,classroomJournalEventsQuerySchema,CLASSROOM_PROVIDER_ERROR_REASONS,CLASSROOM_PROVIDER_ERROR_MESSAGE_CATEGORIES} from '../lib/classroom-journal';

test('journal keeps classroom facts while removing secrets and unapproved payload fields',()=>{
 const key=['sk','syntheticFixtureToken123456789'].join('-');
 const entry=sanitizeClassroomJournalEntry({eventKey:'tool:one',kind:'tool',actor:'teacher',status:'requested',name:'highlight_objects',text:`Please use ${key}.`,details:{objectIds:['apple'],source:'model',boundary:'provider_final',playback:'generated',answer:'My password is fixture-password.',question:'What is this?',headers:{authorization:'private'},image:'data:image/jpeg;base64,private',rawOutput:'private',apiKey:key}});
 assert.deepEqual(entry.details?.objectIds,['apple']);assert.equal(entry.details?.source,'model');
 assert(!JSON.stringify(entry).includes(key));assert(!JSON.stringify(entry).includes('fixture-password'));
 for(const field of ['headers','image','rawOutput','apiKey'])assert(!(field in entry.details!));
 assert.equal(entry.details?.boundary,'provider_final');assert.equal(entry.details?.playback,'generated');
});
test('journal bounds text, identifies fields precisely and rejects malformed event identity',()=>{
 const entry=sanitizeClassroomJournalEntry({eventKey:'speech:1',kind:'utterance',actor:'child',status:'recorded',name:'speech',text:'x '.repeat(10000),details:{strokeCount:2,pointCount:600,generation:1,unknown:42}});
 assert(entry.text!.length<=6000);assert.equal(entry.details?.strokeCount,2);assert(!('unknown' in entry.details!));
 assert.throws(()=>sanitizeClassroomJournalEntry({eventKey:'',kind:'tool',actor:'teacher',status:'confirmed',name:'x'}));
 assert.throws(()=>sanitizeClassroomJournalEntry({eventKey:'x',kind:'unexpected',actor:'teacher',status:'confirmed',name:'x'}));
});
test('journal redacts bearer, connection strings, data URLs and labelled credentials',()=>{
 const entry=sanitizeClassroomJournalEntry({eventKey:'speech:redacted',kind:'utterance',actor:'child',status:'recorded',name:'speech',text:'Bearer syntheticTokenValue; postgres://operator:fixture@localhost/db; data:image/jpeg;base64,AAAA; API_KEY=fixture-private-token; 密码是测试秘密'});
 for(const secret of ['syntheticTokenValue','operator:fixture','base64,AAAA','fixture-private-token','测试秘密'])assert(!entry.text?.includes(secret),secret);
 const quoted=sanitizeClassroomJournalEntry({eventKey:'quoted',kind:'utterance',actor:'child',status:'recorded',name:'speech',text:'{"apiKey":"quoted-private-value", "password":"a private phrase"}'});
 for(const secret of ['quoted-private-value','a private phrase'])assert(!quoted.text?.includes(secret),secret);
});
test('query parameters use bounded pages, valid Shanghai dates and decimal event cursors',()=>{
 assert.deepEqual(classroomJournalListQuerySchema.parse({}),{query:'',page:0,pageSize:20});
 assert.equal(classroomJournalListQuerySchema.parse({from:'2026-11-01',to:'2026-11-02'}).from,'2026-11-01');
 for(const query of [{from:'2026-02-30'},{from:'2026-11-02',to:'2026-11-01'},{page:-1},{pageSize:51},{query:'x'.repeat(101)}])assert.equal(classroomJournalListQuerySchema.safeParse(query).success,false);
 assert.deepEqual(classroomJournalEventsQuerySchema.parse({after:'9007199254740993'}),{after:'9007199254740993',limit:100});
 for(const after of ['-1','1; DROP TABLE x','1.5','9223372036854775808'])assert.equal(classroomJournalEventsQuerySchema.safeParse({after}).success,false);
});

test('journal redacts xAI credentials in text and nested diagnostic summaries',()=>{
 const key=['xai','syntheticFixtureCredential123456789'].join('-');const entry=sanitizeClassroomJournalEntry({eventKey:'grok:redaction',kind:'connection',actor:'application',status:'failed',name:'diagnostic_phase',text:`Accidental credential ${key}`,details:{message:key}});assert(!JSON.stringify(entry).includes(key));
});

const providerError={providerErrorType:'invalid_request_error',providerErrorCode:'invalid_value',providerErrorParam:'response.cancel',requestCorrelation:'matched',requestId:'tkreq_00000000-0000-4000-8000-000000000001',requestType:'response.cancel'};
test('journal retains fixed provider error metadata and locally generated request identifiers',()=>{
 const entry=sanitizeClassroomJournalEntry({eventKey:'provider:error',kind:'connection',actor:'provider',status:'failed',name:'voice_provider_failure',details:{...providerError,contextKey:'class:1:0'}});
 assert.deepEqual(entry.details,{...providerError,contextKey:'class:1:0'});
});
test('provider error journals omit raw messages, unapproved parameters and arbitrary provider identifiers',()=>{
 const entry=sanitizeClassroomJournalEntry({eventKey:'provider:error',kind:'connection',actor:'provider',status:'failed',name:'voice_provider_failure',text:'provider-raw-body',correlationId:'provider-issued-private-id',details:{providerErrorType:'private-error-type',providerErrorCode:'private-error-code',providerErrorParam:'session.private-instructions',requestCorrelation:'private-correlation',requestId:'provider-issued-private-id',requestType:'private-command',message:'provider-raw-body',rawMessage:'provider-raw-body',error:{message:'provider-raw-body'},event_id:'provider-issued-private-id'}});
 assert.deepEqual(entry.details,{});assert.equal(entry.text,undefined);assert.equal(entry.correlationId,undefined);
 assert(!JSON.stringify(entry).includes('private'));assert(!JSON.stringify(entry).includes('raw-body'));
 const business=sanitizeClassroomJournalEntry({eventKey:'business:message',kind:'interaction',actor:'application',status:'recorded',name:'business_message',details:{message:'safe business explanation'}});
 assert.equal(business.details?.message,'safe business explanation');
});
test('provider request IDs require the exact local prefix and UUID with no payload suffix',()=>{
 for(const requestId of ['event_provider','00000000-0000-4000-8000-000000000001','TKREQ_00000000-0000-4000-8000-000000000001','tkreq_bad','tkreq_00000000-0000-4000-8000-000000000001-private','tkreq_00000000-0000-4000-8000-000000000001\n']){
  const entry=sanitizeClassroomJournalEntry({eventKey:'provider:error',kind:'connection',actor:'provider',status:'failed',name:'voice_provider_failure',details:{...providerError,requestId}});
  assert.equal(entry.details?.requestId,undefined,requestId);assert.equal(entry.details?.requestType,'response.cancel');
 }
});
test('journal retains fixed point stages and client capability versions without arbitrary diagnostic fields',()=>{
 const pointId='10000000-0000-4000-8000-000000000001';const safe=sanitizeClassroomJournalEntry({eventKey:'point:trace',name:'point_trace',kind:'interaction',actor:'child',status:'recorded',correlationId:pointId,details:{pointId,pointStage:'send_failed',pointReason:'not_ready',clientDiagnosticsVersion:1,clientPointVersion:1,raw:'private'}});
 assert.deepEqual(safe.details,{pointId,pointStage:'send_failed',pointReason:'not_ready',clientDiagnosticsVersion:1,clientPointVersion:1});
 const invalid=sanitizeClassroomJournalEntry({...safe,details:{pointId:'arbitrary',pointStage:'made-up',pointReason:'raw-body',clientDiagnosticsVersion:2,clientPointVersion:99}});assert.deepEqual(invalid.details,{});
});
test('provider error inspection persists fixed technical categories and 16-hex fingerprints, never unknown raw bodies',()=>{
 const metadata={providerErrorReason:'response_overlap',providerErrorCodeKind:'number',providerErrorCodeShape:'numeric',providerErrorCodeFingerprint:'0123456789abcdef',providerErrorMessageFingerprint:'abcdef0123456789',providerErrorMessageCategories:['active','response','already']};const safe=sanitizeClassroomJournalEntry({eventKey:'provider:inspection',name:'voice_provider_failure',kind:'connection',actor:'provider',status:'failed',details:{...metadata,rawCode:'private',message:'private message',body:{secret:'private'}}});assert.deepEqual(safe.details,metadata);
 for(const bad of [{providerErrorReason:'private-reason'},{providerErrorCodeKind:'arbitrary'},{providerErrorCodeShape:'raw-code'},{providerErrorCodeFingerprint:'secret'},{providerErrorMessageFingerprint:'a'.repeat(17)},{providerErrorMessageCategories:['response','private-message']},{providerErrorMessageCategories:Array(17).fill('audio')}]){const invalid=sanitizeClassroomJournalEntry({...safe,details:bad});assert.deepEqual(invalid.details,{});}
});
test('browser-safe provider diagnostic enums stay aligned with the server inspector contract',async()=>{
 const {QWEN_PROVIDER_ERROR_REASONS,QWEN_PROVIDER_ERROR_MESSAGE_CATEGORIES,inspectQwenProviderError}=await import('../lib/server/classroom-provider-errors');assert.deepEqual(CLASSROOM_PROVIDER_ERROR_REASONS,QWEN_PROVIDER_ERROR_REASONS);assert.deepEqual(CLASSROOM_PROVIDER_ERROR_MESSAGE_CATEGORIES,QWEN_PROVIDER_ERROR_MESSAGE_CATEGORIES);
 const inspected=inspectQwenProviderError({error:{code:'SYNTHETIC_UNKNOWN_CODE',message:'Conversation already has an active response.'}});const safe=sanitizeClassroomJournalEntry({eventKey:'provider:inspection',name:'voice_provider_failure',kind:'connection',actor:'provider',status:'failed',details:inspected});assert.deepEqual(safe.details,inspected);assert(!JSON.stringify(safe).includes('SYNTHETIC_UNKNOWN_CODE'));
});
test('recovery journal states and provider recovery action are closed without restricting unrelated business actions',()=>{
 const entry={eventKey:'recovery:1',name:'voice_request_recovery',kind:'connection',actor:'application',status:'requested'};assert.equal(sanitizeClassroomJournalEntry({...entry,details:{state:'checking'}}).details?.state,'checking');assert.equal(sanitizeClassroomJournalEntry({...entry,details:{state:'raw-private-body'}}).details?.state,undefined);
 assert.equal(sanitizeClassroomJournalEntry({...entry,name:'voice_provider_failure',details:{action:'recovery_check'}}).details?.action,'recovery_check');assert.equal(sanitizeClassroomJournalEntry({...entry,name:'voice_provider_failure',details:{action:'raw-private-action'}}).details?.action,undefined);
 assert.equal(sanitizeClassroomJournalEntry({...entry,name:'annotation',details:{action:'draw'}}).details?.action,'draw');
});
