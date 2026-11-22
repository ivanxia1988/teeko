import test from 'node:test';
import assert from 'node:assert/strict';
import {canVerifyQwenRequestFailure} from '../lib/server/classroom-request-recovery';
import {QWEN_PROVIDER_ERROR_REASONS,inspectQwenProviderError,type QwenProviderErrorMetadata} from '../lib/server/classroom-provider-errors';

const metadata:QwenProviderErrorMetadata={providerErrorType:'invalid_request_error',providerErrorCode:'unknown',providerErrorParam:'none',requestCorrelation:'missing',providerErrorReason:'unknown',providerErrorCodeKind:'null',providerErrorCodeShape:'none',providerErrorMessageCategories:[]};
const state={ready:true,used:false,idle:true,lastCompletedMs:100,clientCapable:true};

test('only a recently completed idle capable connection may enter its one transport verification',()=>{
 assert(canVerifyQwenRequestFailure(metadata,state));assert(canVerifyQwenRequestFailure({...metadata,providerErrorCode:'invalid_value',providerErrorReason:'configuration_rejected'},state));
 for(const value of [0,1500])assert(canVerifyQwenRequestFailure(metadata,{...state,lastCompletedMs:value}));
 for(const changed of [{ready:false},{used:true},{idle:false},{clientCapable:false},...[-1,1500.01,Infinity,NaN].map(lastCompletedMs=>({lastCompletedMs}))])assert.equal(canVerifyQwenRequestFailure(metadata,{...state,...changed}),false);
});
test('authentication, limits, media, content and malformed-data categories cannot be converted into recovery eligibility',()=>{
 const excluded=['auth','quota','rate','inspection','image','audio','decode','base64','length','timeout','exception','content'] as const;
 for(const category of excluded)assert.equal(canVerifyQwenRequestFailure({...metadata,providerErrorMessageCategories:['invalid',category]},state),false,category);
});
test('matched or ambiguous operations, non-request failures and known technical failures remain terminal',()=>{
 for(const requestCorrelation of ['matched','unknown','unsent','scope_mismatch'] as const)assert.equal(canVerifyQwenRequestFailure({...metadata,requestCorrelation},state),false);
 for(const providerErrorParam of ['response.cancel','response.create','session','audio','image','conversation.item','other'] as const)assert.equal(canVerifyQwenRequestFailure({...metadata,providerErrorParam},state),false);
 for(const providerErrorType of ['server_error','authentication_error','permission_error','rate_limit_error','unknown'] as const)assert.equal(canVerifyQwenRequestFailure({...metadata,providerErrorType},state),false);
 for(const providerErrorCode of ['authentication','quota','rate_limit','server'] as const)assert.equal(canVerifyQwenRequestFailure({...metadata,providerErrorCode},state),false);
 for(const providerErrorReason of QWEN_PROVIDER_ERROR_REASONS.filter(reason=>reason!=='unknown'&&reason!=='configuration_rejected'))assert.equal(canVerifyQwenRequestFailure({...metadata,providerErrorReason},state),false,providerErrorReason);
});
test('bounded technical metadata cannot hide a terminal category behind many ordinary technical terms',()=>{
 for(const terminal of ['content','internal exception']){
  const inspected=inspectQwenProviderError({error:{code:null,message:'active cancel empty tool unsupported invalid instruction response format event buffer conversation already missing text parameter '+terminal}});
  assert.equal(canVerifyQwenRequestFailure({...metadata,...inspected},state),false,terminal);
 }
});
