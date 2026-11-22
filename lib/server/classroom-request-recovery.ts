import type {QwenProviderErrorMetadata} from './classroom-provider-errors';

/** Eligibility to verify a connection, never evidence that a failed operation succeeded. */
export function canVerifyQwenRequestFailure(metadata:QwenProviderErrorMetadata,state:{ready:boolean;used:boolean;idle:boolean;lastCompletedMs:number;clientCapable:boolean}):boolean{
 const excluded=new Set(['auth','quota','rate','inspection','image','audio','decode','base64','length','timeout','exception','content']);
 return state.ready&&!state.used&&state.idle&&state.clientCapable&&Number.isFinite(state.lastCompletedMs)&&state.lastCompletedMs>=0&&state.lastCompletedMs<=1500&&
  metadata.providerErrorType==='invalid_request_error'&&['unknown','invalid_value'].includes(metadata.providerErrorCode)&&metadata.providerErrorParam==='none'&&metadata.requestCorrelation==='missing'&&
  ['unknown','configuration_rejected'].includes(metadata.providerErrorReason)&&!metadata.providerErrorMessageCategories.some(category=>excluded.has(category));
}
