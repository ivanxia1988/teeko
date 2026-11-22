import test from 'node:test';
import assert from 'node:assert/strict';
import {QwenProviderRequestTracker,inspectQwenProviderError} from '../lib/server/classroom-provider-errors';

const scope='lease-1:context-1';
const requestError=(requestId?:string,overrides:Record<string,unknown>={})=>({
  type:'error',event_id:'provider-event',
  error:{type:'invalid_request_error',code:'invalid_value',param:'response.cancel',event_id:requestId,...overrides},
});

test('every request gets a fresh local ID while retaining its actual outgoing payload',()=>{
 const tracker=new QwenProviderRequestTracker();
 const a=tracker.prepare(JSON.stringify({type:'session.update',event_id:'untrusted-old-id',session:{instructions:'private'}}),scope);
 const b=tracker.prepare(JSON.stringify({type:'input_audio_buffer.append',audio:'private-audio'}),scope);
 assert.match(a.requestId,/^tkreq_[a-f0-9-]{36}$/);assert.notEqual(a.requestId,b.requestId);
 assert.equal(a.requestType,'session.update');assert.equal(b.requestType,'input_audio_buffer.append');
 assert.deepEqual(JSON.parse(a.raw),{type:'session.update',event_id:a.requestId,session:{instructions:'private'}});
 assert.equal(JSON.parse(b.raw).event_id,b.requestId);
});

test('explicit failed client event IDs identify only sent requests in the current context',()=>{
 const tracker=new QwenProviderRequestTracker();const request=tracker.prepare('{"type":"response.cancel"}',scope);
 assert.equal(tracker.markSent(request.requestId),true);
 const result=tracker.classify(requestError(request.requestId),{scope,responseState:'idle'});
 assert.equal(result.action,'fatal');
 assert.deepEqual(result.metadata,{providerErrorType:'invalid_request_error',providerErrorCode:'invalid_value',providerErrorParam:'response.cancel',requestCorrelation:'matched',requestId:request.requestId,requestType:'response.cancel',...inspectQwenProviderError(requestError(request.requestId))});
 assert.equal(tracker.classify(requestError(request.requestId),{scope,responseState:'idle'}).action,'fatal');
});

test('server event IDs and nearby sent requests never stand in for an explicit failed client event ID',()=>{
 for(const errorEvent of [requestError(),{...requestError(),event_id:'same-as-local'},requestError('unknown-id')]){
  const tracker=new QwenProviderRequestTracker();const request=tracker.prepare('{"type":"response.cancel"}',scope);tracker.markSent(request.requestId);
  if(errorEvent.event_id==='same-as-local')errorEvent.event_id=request.requestId;
  const result=tracker.classify(errorEvent,{scope,responseState:'idle'});
  assert.equal(result.action,'fatal');assert.equal(result.metadata.requestId,undefined);
 }
});

test('unsent, old-context, active-response, malformed and non-cancel requests remain fatal',()=>{
 for(const fixture of [
  {raw:'{"type":"response.cancel"}',sent:false,scope,responseState:'idle'},
  {raw:'{"type":"response.cancel"}',sent:true,scope:'other-context',responseState:'idle'},
  {raw:'{"type":"response.cancel"}',sent:true,scope,responseState:'active'},
  {raw:'{"type":"response.cancel","unsupported":"private"}',sent:true,scope,responseState:'idle'},
  {raw:'{"type":"response.create"}',sent:true,scope,responseState:'idle'},
 ] as const){
  const tracker=new QwenProviderRequestTracker();const request=tracker.prepare(fixture.raw,scope);
  if(fixture.sent)tracker.markSent(request.requestId);
  assert.equal(tracker.classify(requestError(request.requestId),{scope:fixture.scope,responseState:fixture.responseState}).action,'fatal');
 }
});

test('auth, quota, unknown, configuration, media and merely invalid requests remain fatal',()=>{
 for(const overrides of [
  {type:'server_error'}, {type:'authentication_error'}, {code:'invalid_api_key'}, {code:'insufficient_quota'},
  {code:'response_cancel_not_active'}, {code:'unexpected_code'}, {param:'session.modalities'},
  {param:'input_audio_buffer.append'}, {param:'input_image_buffer.append'}, {param:null}, {type:'unknown'},
 ]){
  const tracker=new QwenProviderRequestTracker();const request=tracker.prepare('{"type":"response.cancel"}',scope);tracker.markSent(request.requestId);
  assert.equal(tracker.classify(requestError(request.requestId,overrides),{scope,responseState:'idle'}).action,'fatal');
 }
});

test('only fixed safe categories and locally generated IDs leave the error classifier',()=>{
 const tracker=new QwenProviderRequestTracker();const secret='fixture-private-provider-value';
 const result=tracker.classify({type:'error',event_id:secret,error:{type:secret,code:secret,param:secret,event_id:secret,message:secret,payload:{private:secret}}},{scope,responseState:'idle'});
 assert.deepEqual(result,{action:'fatal',metadata:{providerErrorType:'unknown',providerErrorCode:'unknown',providerErrorParam:'other',requestCorrelation:'unknown',...inspectQwenProviderError({error:{code:secret,message:secret}})}});
 assert(!JSON.stringify(result).includes(secret));
 assert.equal(tracker.classify(requestError(undefined,{param:'session.modalities'}),{scope,responseState:'idle'}).metadata.providerErrorParam,'session');
});

test('metadata is bounded, expires and is cleared on connection replacement; media does not evict controls',()=>{
 let now=1000;const tracker=new QwenProviderRequestTracker({now:()=>now});
 const cancel=tracker.prepare('{"type":"response.cancel"}',scope);tracker.markSent(cancel.requestId);
 for(let i=0;i<1000;i++){const media=tracker.prepare('{"type":"input_audio_buffer.append","audio":"private"}',scope);tracker.markSent(media.requestId);}
 assert(tracker.size<=96);assert.equal(tracker.classify(requestError(cancel.requestId),{scope,responseState:'idle'}).metadata.requestCorrelation,'matched');
 const expired=tracker.prepare('{"type":"response.cancel"}',scope);tracker.markSent(expired.requestId);now+=30_001;
 assert.equal(tracker.classify(requestError(expired.requestId),{scope,responseState:'idle'}).action,'fatal');
 for(let i=0;i<1000;i++)tracker.prepare('{"type":"response.create"}',scope);
 assert(tracker.size<=96);tracker.clear();assert.equal(tracker.size,0);
});

test('invalid local request envelopes fail with a fixed error and do not retain data',()=>{
 const tracker=new QwenProviderRequestTracker();
 for(const raw of ['private','[]','null','{}','{"type":1}'])assert.throws(()=>tracker.prepare(raw,scope),{message:'Invalid Qwen request envelope'});
 assert.equal(tracker.size,0);
});

test('a classified control rejection can retain a recently confirmed stable idle session without retrying',()=>{
 let now=1000;const tracker=new QwenProviderRequestTracker({now:()=>now});
 tracker.confirmIdle(scope);now+=14;
 const result=tracker.classify(requestError(undefined,{param:'response.create'}),{scope,stableIdle:true});
 assert.equal(result.action,'retain_idle');assert.equal(result.metadata.requestCorrelation,'missing');
 assert.equal(tracker.size,0);
});

test('idle retention needs an unchanged current completed response within 1500ms',()=>{
 for(const fixture of [
  {advance:0,scope,stableIdle:false}, {advance:1501,scope,stableIdle:true},
  {advance:-1,scope,stableIdle:true}, {advance:0,scope:'other',stableIdle:true},
 ]){
  let now=1000;const tracker=new QwenProviderRequestTracker({now:()=>now});tracker.confirmIdle(scope);now+=fixture.advance;
  assert.equal(tracker.classify(requestError(),fixture).action,'fatal');
 }
 const tracker=new QwenProviderRequestTracker();assert.equal(tracker.classify(requestError(),{scope,stableIdle:true}).action,'fatal');
});

test('new audio, images, configuration, or item requests revoke the completed idle proof',()=>{
 for(const type of ['input_audio_buffer.append','input_image_buffer.append','session.update','conversation.item.create','unknown']){
  const tracker=new QwenProviderRequestTracker();tracker.confirmIdle(scope);tracker.prepare(JSON.stringify({type}),scope);
  assert.equal(tracker.classify(requestError(),{scope,stableIdle:true}).action,'fatal',type);
 }
});

test('idle retention never accepts unknown, authentication, quota, media, or configuration errors',()=>{
 for(const overrides of [{code:'unknown'}, {code:'invalid_api_key'}, {code:'insufficient_quota'}, {type:'server_error'}, {type:'authentication_error'}, {param:'session.modalities'}, {param:'audio'}, {param:'response.create.instructions'}, {param:null}]){
  const tracker=new QwenProviderRequestTracker();tracker.confirmIdle(scope);
  assert.equal(tracker.classify(requestError(undefined,overrides),{scope,stableIdle:true}).action,'fatal');
 }
});

test('explicit invalid or mismatched client request IDs cannot use the uncorrelated idle fallback',()=>{
 const tracker=new QwenProviderRequestTracker();tracker.confirmIdle(scope);
 assert.equal(tracker.classify(requestError('foreign'),{scope,stableIdle:true}).action,'fatal');
 for(const event_id of [42,'',{},[]])assert.equal(tracker.classify(requestError(undefined,{event_id}),{scope,stableIdle:true}).action,'fatal');
 const request=tracker.prepare('{"type":"response.create"}',scope);tracker.markSent(request.requestId);
 assert.equal(tracker.classify(requestError(request.requestId),{scope,stableIdle:true}).action,'fatal');
});

test('idle retention is limited to two events per rolling 30 seconds and clear resets the connection state',()=>{
 let now=1000;const tracker=new QwenProviderRequestTracker({now:()=>now});tracker.confirmIdle(scope);
 assert.equal(tracker.classify(requestError(),{scope,stableIdle:true}).action,'retain_idle');
 assert.equal(tracker.classify(requestError(),{scope,stableIdle:true}).action,'retain_idle');
 assert.equal(tracker.classify(requestError(),{scope,stableIdle:true}).action,'fatal');
 now+=30_001;tracker.confirmIdle(scope);
 assert.equal(tracker.classify(requestError(),{scope,stableIdle:true}).action,'retain_idle');
 tracker.clear();assert.equal(tracker.classify(requestError(),{scope,stableIdle:true}).action,'fatal');
});

test('provider error inspection distinguishes absent, null, numeric and unrecognized code shapes without keeping them',()=>{
 for(const [code,kind,shape]of [[undefined,'missing','none'],[null,'null','none'],['','string','empty'],['Some_Unrecognized.Code','string','identifier'],['400','string','numeric'],[400,'number','numeric'],['private value\nwith content','string','text'],[{private:'unlogged'},'object','none'],[[],'array','none']] as const){
  const detail=inspectQwenProviderError({type:'error',error:{code}});
  assert.equal(detail.providerErrorCodeKind,kind);assert.equal(detail.providerErrorCodeShape,shape);
  assert.equal(detail.providerErrorReason,'unknown');
  if(typeof code==='string'&&code||typeof code==='number')assert.match(detail.providerErrorCodeFingerprint??'',/^[a-f0-9]{16}$/);
  assert(!JSON.stringify(detail).includes('Some_Unrecognized.Code'));assert(!JSON.stringify(detail).includes('unlogged'));
 }
 const one=inspectQwenProviderError({error:{code:'first-value'}}),same=inspectQwenProviderError({error:{code:'first-value'}}),other=inspectQwenProviderError({error:{code:'second-value'}});
 assert.equal(one.providerErrorCodeFingerprint,same.providerErrorCodeFingerprint);assert.notEqual(one.providerErrorCodeFingerprint,other.providerErrorCodeFingerprint);
});

test('known technical message templates become fixed reasons while quoted content and unknown errors stay unknown',()=>{
 const message='Cannot create response while another response is in progress.';
 const detail=inspectQwenProviderError({error:{message}});
 assert.equal(detail.providerErrorReason,'response_overlap');assert(detail.providerErrorMessageCategories.includes('response'));assert(detail.providerErrorMessageCategories.includes('active'));
 assert.match(detail.providerErrorMessageFingerprint??'',/^[a-f0-9]{16}$/);
 assert.equal(inspectQwenProviderError({error:{message:`The supplied text was "${message}"`}}).providerErrorReason,'unknown');
 assert.equal(inspectQwenProviderError({error:{message:'Cancellation failed: no active response found.'}}).providerErrorReason,'cancel_without_response');
 const unknown=inspectQwenProviderError({error:{message:'API_KEY=synthetic-private-token; a private learner phrase'}});
 assert.equal(unknown.providerErrorReason,'unknown');assert(!JSON.stringify(unknown).includes('synthetic-private-token'));assert(!JSON.stringify(unknown).includes('learner phrase'));
});

test('inspection metadata is bounded and cannot turn an uncorrelated unknown request failure into recovery',()=>{
 const message='audio image response event buffer active invalid format empty quota auth tool text parameter content unsupported timeout '.repeat(2000),detail=inspectQwenProviderError({error:{message}});
 assert(detail.providerErrorMessageCategories.length<=16);assert(JSON.stringify(detail).length<1000);assert(!JSON.stringify(detail).includes(' '.repeat(2)));
 const tracker=new QwenProviderRequestTracker();tracker.confirmIdle(scope);
 const result=tracker.classify({type:'error',error:{type:'invalid_request_error',message:'Cannot create response while another response is in progress.'}},{scope,stableIdle:true});
 assert.equal(result.action,'fatal');assert.equal(result.metadata.providerErrorCode,'unknown');assert.equal(result.metadata.providerErrorReason,'response_overlap');
});

test('bounded diagnostic categories always retain every recovery-blocking signal before descriptive terms',()=>{
 const message='active cancel empty tool unsupported invalid instruction response format event buffer conversation already missing text parameter internal exception content';
 const detail=inspectQwenProviderError({error:{message}});
 assert(detail.providerErrorMessageCategories.includes('exception'));assert(detail.providerErrorMessageCategories.includes('content'));assert(detail.providerErrorMessageCategories.length<=16);
 const all=inspectQwenProviderError({error:{message:`${message} auth quota rate inspection image audio decode base64 length timeout`}});
 for(const category of ['auth','quota','rate','inspection','image','audio','decode','base64','length','timeout','exception','content'] as const)assert(all.providerErrorMessageCategories.includes(category),category);
 assert(all.providerErrorMessageCategories.length<=16);assert(!JSON.stringify(all).includes(message));
});
