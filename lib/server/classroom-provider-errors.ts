import {createHash,randomUUID} from 'node:crypto';

const REQUEST_TYPES=[
 'session.update','response.create','response.cancel','conversation.item.create',
 'input_audio_buffer.append','input_audio_buffer.commit','input_audio_buffer.clear','input_image_buffer.append',
] as const;
export type QwenRequestType=typeof REQUEST_TYPES[number]|'unknown';
export const QWEN_PROVIDER_ERROR_REASONS=['unknown','cancel_without_response','response_overlap','empty_audio_commit','invalid_image','invalid_audio','unknown_tool_call','unsupported_operation','empty_output','content_policy','context_limit','upstream_timeout','configuration_rejected'] as const;
export const QWEN_PROVIDER_ERROR_MESSAGE_CATEGORIES=['active','cancel','empty','image','audio','tool','unsupported','invalid','instruction','response','format','event','buffer','conversation','already','decode','base64','rate','quota','auth','timeout','inspection','length','missing','text','parameter','content','sequence','commit','update','exception'] as const;
export type QwenProviderErrorInspection={
 providerErrorReason:typeof QWEN_PROVIDER_ERROR_REASONS[number];
 providerErrorCodeKind:'missing'|'null'|'string'|'number'|'boolean'|'object'|'array'|'other';
 providerErrorCodeShape:'none'|'empty'|'identifier'|'numeric'|'text';
 providerErrorCodeFingerprint?:string;
 providerErrorMessageFingerprint?:string;
 providerErrorMessageCategories:(typeof QWEN_PROVIDER_ERROR_MESSAGE_CATEGORIES[number])[];
};
export type QwenProviderErrorMetadata=QwenProviderErrorInspection&{
 providerErrorType:'invalid_request_error'|'server_error'|'authentication_error'|'permission_error'|'rate_limit_error'|'unknown';
 providerErrorCode:'invalid_value'|'authentication'|'quota'|'rate_limit'|'server'|'unknown';
 providerErrorParam:'response.cancel'|'response.create'|'session'|'audio'|'image'|'conversation.item'|'none'|'other';
 requestCorrelation:'matched'|'missing'|'unknown'|'unsent'|'scope_mismatch';
 requestId?:string;
 requestType?:QwenRequestType;
};
type RequestMetadata={requestId:string;requestType:QwenRequestType;scope:string;createdAt:number;sentAt:number|null};
const CONTROL_LIMIT=64;
const MEDIA_LIMIT=32;
const REQUEST_TTL_MS=30_000;
const record=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const member=<T extends string>(value:unknown,values:readonly T[]):value is T=>typeof value==='string'&&values.includes(value as T);
const fingerprint=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,16);
const technicalTerms:Record<typeof QWEN_PROVIDER_ERROR_MESSAGE_CATEGORIES[number],RegExp>={
 active:/active|progress|活动|进行中/i,cancel:/cancel|取消/i,empty:/empty|blank|为空|空的/i,image:/image|jpeg|jpg|图片|图像/i,audio:/audio|pcm|音频/i,
 tool:/tool|function|工具|函数/i,unsupported:/unsupported|not support|不支持/i,invalid:/invalid|illegal|不合法|无效/i,instruction:/instruction|指令/i,
 response:/response|回复|响应/i,format:/format|格式/i,event:/event|事件/i,buffer:/buffer|缓冲/i,conversation:/conversation|对话/i,already:/already|已经/i,
 decode:/decode|解码/i,base64:/base64/i,rate:/rate|频率/i,quota:/quota|credit|balance|额度|余额/i,auth:/auth|permission|api.?key|鉴权|权限/i,
 timeout:/timeout|timed out|deadline|超时/i,inspection:/inspection|policy|safety|security|sensitive|inappropriate|审核|敏感|违规/i,
 length:/length|size|large|limit|token|长度|大小|限制/i,missing:/missing|required|not found|不存在|缺少/i,text:/text|文字|文本/i,parameter:/parameter|param|参数/i,
 content:/content|内容/i,sequence:/sequence|order|顺序/i,commit:/commit|提交/i,update:/update|更新/i,exception:/exception|internal|异常/i,
};
const recoveryBlockingCategories=new Set<typeof QWEN_PROVIDER_ERROR_MESSAGE_CATEGORIES[number]>(['auth','quota','rate','inspection','image','audio','decode','base64','length','timeout','exception','content']);
function technicalReason(message:string):QwenProviderErrorInspection['providerErrorReason']{
 if(/^(?:Cannot create response while another response is in progress|Conversation already has an active response)\.?$/i.test(message))return 'response_overlap';
 if(/^(?:Cancellation failed: |Response cancellation failed: )?no active response(?: found)?\.?$/i.test(message))return 'cancel_without_response';
 if(/^Error committing input audio buffer: buffer too small\. Expected at least \d+ms of audio, but buffer only has \d+(?:\.\d+)?ms of audio\.?$/i.test(message))return 'empty_audio_commit';
 if(/^(?:Invalid|Unsupported) (?:image|JPEG) (?:format|data)\.?$/i.test(message))return 'invalid_image';
 if(/^(?:Invalid|Unsupported) (?:audio|PCM) (?:format|data|sample rate)\.?$/i.test(message))return 'invalid_audio';
 if(/^(?:Tool|Function) call (?:not found|is unknown)\.?$/i.test(message))return 'unknown_tool_call';
 if(/^(?:Unsupported|Unknown) (?:event|operation|message) type(?:\: [A-Za-z][A-Za-z0-9_.-]{0,127})?\.?$/i.test(message))return 'unsupported_operation';
 if(/^(?:The )?(?:response|output text|output message) is empty\.?$/i.test(message))return 'empty_output';
 if(/^(?:Data inspection failed|Input data may contain inappropriate content)\.?$/i.test(message))return 'content_policy';
 if(/^(?:Maximum context length exceeded|Instructions exceed the maximum length)\.?$/i.test(message))return 'context_limit';
 if(/^(?:Request timed out|Upstream request timed out|Request deadline exceeded)\.?$/i.test(message))return 'upstream_timeout';
 return 'unknown';
}

/** Inspect technical fields only in memory; returned values contain no provider text or opaque code. */
export function inspectQwenProviderError(event:unknown):QwenProviderErrorInspection{
 const error=record(record(event)?.error),code=error?.code,message=error?.message;
 const kind:QwenProviderErrorInspection['providerErrorCodeKind']=code===undefined?'missing':code===null?'null':Array.isArray(code)?'array':member(typeof code,['string','number','boolean','object'])?typeof code as 'string'|'number'|'boolean'|'object':'other';
 const shape:QwenProviderErrorInspection['providerErrorCodeShape']=typeof code==='number'&&Number.isFinite(code)?'numeric':typeof code!=='string'?'none':!code?'empty':/^[0-9.:-]+$/.test(code)?'numeric':/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(code)?'identifier':'text';
 const text=typeof message==='string'?message.slice(0,16000):'';
 return {
  providerErrorReason:technicalReason(text),providerErrorCodeKind:kind,providerErrorCodeShape:shape,
  ...(typeof code==='string'&&code||typeof code==='number'&&Number.isFinite(code)?{providerErrorCodeFingerprint:fingerprint(String(code))}:{}),
  ...(typeof message==='string'&&message?{providerErrorMessageFingerprint:fingerprint(message)}:{}),
  providerErrorMessageCategories:QWEN_PROVIDER_ERROR_MESSAGE_CATEGORIES.filter(category=>technicalTerms[category].test(text)).sort((left,right)=>Number(recoveryBlockingCategories.has(right))-Number(recoveryBlockingCategories.has(left))).slice(0,16),
 };
}

function safeErrorType(value:unknown):QwenProviderErrorMetadata['providerErrorType']{
 return member(value,['invalid_request_error','server_error','authentication_error','permission_error','rate_limit_error'])?value:'unknown';
}
function safeErrorCode(value:unknown):QwenProviderErrorMetadata['providerErrorCode']{
 if(value==='invalid_value')return 'invalid_value';
 if(member(value,['invalid_api_key','authentication_error','unauthorized']))return 'authentication';
 if(member(value,['insufficient_quota','quota_exceeded']))return 'quota';
 if(member(value,['rate_limit_exceeded','rate_limit_error']))return 'rate_limit';
 if(member(value,['server_error','internal_error']))return 'server';
 return 'unknown';
}
function safeErrorParam(value:unknown):QwenProviderErrorMetadata['providerErrorParam']{
 if(value===null||value===undefined)return 'none';
 if(value==='response.cancel'||value==='response.create')return value;
 if(typeof value!=='string')return 'other';
 if(value==='session'||value.startsWith('session.'))return 'session';
 if(value==='audio'||value.startsWith('audio.')||value.startsWith('input_audio_buffer.'))return 'audio';
 if(value==='image'||value.startsWith('image.')||value.startsWith('input_image_buffer.'))return 'image';
 if(value==='conversation.item'||value.startsWith('conversation.item.'))return 'conversation.item';
 return 'other';
}

/** Keeps identifiers and fixed metadata, never request payloads or provider messages. */
export class QwenProviderRequestTracker{
 private readonly control=new Map<string,RequestMetadata>();
 private readonly media=new Map<string,RequestMetadata>();
 private readonly now:()=>number;
 private idleProof:{scope:string;at:number}|null=null;
 private retainedAt:number[]=[];
 constructor(options:{now?:()=>number}={}){this.now=options.now??Date.now;}

 get size():number{this.prune();return this.control.size+this.media.size;}

 prepare(raw:string,scope:string):{raw:string;requestId:string;requestType:QwenRequestType}{
  let event:Record<string,unknown>|undefined;
  try{event=record(JSON.parse(raw));}catch{throw new Error('Invalid Qwen request envelope');}
  if(!event||typeof event.type!=='string'||!event.type)throw new Error('Invalid Qwen request envelope');
  if(!scope||scope.length>1024)throw new Error('Invalid Qwen request scope');
  this.prune();
  const requestId=`tkreq_${randomUUID()}`;
  const requestType:QwenRequestType=member(event.type,REQUEST_TYPES)?event.type:'unknown';
  if(requestType!=='response.create'&&requestType!=='response.cancel')this.idleProof=null;
  const entries=requestType==='input_audio_buffer.append'||requestType==='input_image_buffer.append'?this.media:this.control;
  entries.set(requestId,{requestId,requestType,scope,createdAt:this.now(),sentAt:null});
  this.bound(entries,entries===this.media?MEDIA_LIMIT:CONTROL_LIMIT);
  return {raw:JSON.stringify({...event,event_id:requestId}),requestId,requestType};
 }

 markSent(requestId:string):boolean{
  this.prune();const request=this.lookup(requestId);
  if(!request||request.sentAt!==null)return false;
  request.sentAt=this.now();return true;
 }

 confirmIdle(scope:string):void{
  const now=this.now();this.idleProof=Number.isFinite(now)&&scope.length>0&&scope.length<=1024?{scope,at:now}:null;
 }

 classify(event:unknown,context:{scope:string;responseState?:string;stableIdle?:boolean}):{action:'retain_idle'|'fatal';metadata:QwenProviderErrorMetadata}{
  this.prune();const envelope=record(event),error=record(envelope?.error);
  const metadata:QwenProviderErrorMetadata={
   ...inspectQwenProviderError(event),
   providerErrorType:safeErrorType(error?.type),providerErrorCode:safeErrorCode(error?.code),
   providerErrorParam:safeErrorParam(error?.param),requestCorrelation:'missing',
  };
  // Omni documents the top-level event_id as a server event ID, not the failed request ID.
  const failedRequestId=error?.event_id;
  if(failedRequestId!==undefined&&failedRequestId!==null)metadata.requestCorrelation='unknown';
  let matchedRequest:RequestMetadata|undefined;
  if(typeof failedRequestId==='string'&&failedRequestId){
   const request=this.lookup(failedRequestId);
   metadata.requestCorrelation=!request?'unknown':request.sentAt===null?'unsent':request.scope!==context.scope?'scope_mismatch':'matched';
   if(metadata.requestCorrelation==='matched'&&request){
    matchedRequest=request;
    metadata.requestId=request.requestId;metadata.requestType=request.requestType;
    this.control.delete(request.requestId);this.media.delete(request.requestId);
   }
  }
  const now=this.now(),proof=this.idleProof;
  const matchingControl=metadata.requestCorrelation==='missing'||metadata.requestCorrelation==='matched'&&matchedRequest?.requestType===error?.param;
  // This bounded passive policy never retries a rejected request or treats it as successful.
  // Configuration/media errors and any uncertain in-flight operation still close the session.
  const retain=envelope?.type==='error'&&error?.type==='invalid_request_error'&&error.code==='invalid_value'&&
   (error.param==='response.create'||error.param==='response.cancel')&&matchingControl&&context.stableIdle===true&&
   (!context.responseState||context.responseState==='idle')&&proof?.scope===context.scope&&Number.isFinite(now)&&now>=proof.at&&now-proof.at<=1500;
  if(retain){
   this.retainedAt=this.retainedAt.filter(at=>now>=at&&now-at<30_000);
   if(this.retainedAt.length<2){this.retainedAt.push(now);return {action:'retain_idle',metadata};}
  }
  return {action:'fatal',metadata};
 }

 clear():void{this.control.clear();this.media.clear();this.idleProof=null;this.retainedAt=[];}
 private lookup(requestId:string):RequestMetadata|undefined{return this.control.get(requestId)??this.media.get(requestId);}
 private prune():void{
  const now=this.now();
  for(const entries of [this.control,this.media])for(const [id,request] of entries){
   const timestamp=request.sentAt??request.createdAt;
   if(!Number.isFinite(now)||now<timestamp||now-timestamp>REQUEST_TTL_MS)entries.delete(id);
  }
 }
 private bound(entries:Map<string,RequestMetadata>,limit:number):void{
  while(entries.size>limit){const oldest=entries.keys().next().value;if(oldest===undefined)break;entries.delete(oldest);}
 }
}
