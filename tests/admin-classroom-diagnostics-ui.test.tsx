import React from 'react';
import {after,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/admin/diagnostics',pretendToBeVisual:true});
for(const key of ['window','self','document','HTMLElement','Node','Event','MutationObserver','navigator'])Object.defineProperty(globalThis,key,{value:(dom.window as unknown as Record<string,unknown>)[key],configurable:true});
const {render,screen,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react');
const {ClassroomDiagnostics}=await import('../components/admin/classroom-diagnostics');
afterEach(cleanup);after(()=>dom.window.close());
const id='10000000-0000-4000-8000-000000000001',secondId='10000000-0000-4000-8000-000000000002',date='2026-11-12T01:00:00Z',turnId='30000000-0000-4000-8000-000000000001';
const classroom=(value=id)=>({id:value,accountId:'20000000-0000-4000-8000-000000000001',email:'parent@example.test',childName:'Mia',courseTitle:'一起去野餐',provider:'qwen',status:'active',startedAt:date,endedAt:null,elapsedSeconds:91,agentName:'Teeko',agentVersion:1,model:'fixture-model',eventCount:3});
const event=(value:string,extra:Record<string,unknown>={})=>({id:value,createdAt:date,epoch:1,revision:3,stepIndex:0,kind:'utterance',actor:'teacher',status:'recorded',name:'transcript',text:'Private generated sentence',correlationId:null,details:{source:'model',playback:'generated',turnId,clock:'server'},...extra});
const list=(extra:Record<string,unknown>={})=>({ok:true,classrooms:[classroom()],total:1,page:0,pageSize:20,...extra});
const details=(rows=[event('1')],extra:Record<string,unknown>={})=>({ok:true,classroom:classroom(),events:rows,nextCursor:null,coverage:'journal',...extra});
async function click(name:string){await act(async()=>{fireEvent.click(screen.getByRole('button',{name}));await new Promise(resolve=>setTimeout(resolve,0));});}
async function openTimelineDetails(){const row=document.querySelector('.td-timeline-item details') as HTMLDetailsElement;assert(row);if(!row.open){await act(async()=>{fireEvent.click(row.querySelector('summary')!);await new Promise(resolve=>setTimeout(resolve,0));});}}
function fixture(handler?:(url:URL)=>Response|Promise<Response>){const calls:URL[]=[];globalThis.fetch=async input=>{const url=new URL(String(input),'http://localhost');calls.push(url);return handler?handler(url):Response.json(url.pathname.endsWith('/events')?details():list());};return calls;}

test('point and provider diagnosis fields stay in expanded details and are available without raw messages',async()=>{
 const pointId='90000000-0000-4000-8000-000000000001';fixture(()=>Response.json(details([event('1',{kind:'interaction',actor:'child',name:'point_trace',status:'failed',text:null,correlationId:pointId,details:{pointId,pointStage:'send_failed',pointReason:'not_ready',source:'client',clientDiagnosticsVersion:1,clientPointVersion:1,providerErrorType:'invalid_request_error',providerErrorReason:'response_overlap',providerErrorCodeKind:'number',providerErrorCodeShape:'numeric',providerErrorCodeFingerprint:'0123456789abcdef',providerErrorMessageFingerprint:'abcdef0123456789',providerErrorMessageCategories:['active','response'],requestType:'response.cancel',requestCorrelation:'missing'}})])));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getAllByText(/点选未发出/).length));assert.equal(screen.queryByText('response_overlap'),null);assert.equal(screen.queryByText('0123456789abcdef'),null);assert.equal(screen.queryByText('客户端诊断版本'),null);
 await openTimelineDetails();await waitFor(()=>assert(screen.getByText('response_overlap')));assert(screen.getByText('点选阶段'));assert(screen.getAllByText('send_failed').length);assert(screen.getByText('not_ready'));assert(screen.getByText('客户端诊断版本'));assert(screen.getByText('客户端点选版本'));assert(screen.getByText('0123456789abcdef'));assert(screen.getByText('abcdef0123456789'));assert(screen.getByText('active、response'));assert(screen.getByText('response.cancel'));assert(screen.getByText('missing'));
});
test('request recovery stays visibly pending until verified success and fixed processing details remain folded',async()=>{
 fixture(()=>Response.json(details([event('1',{kind:'connection',actor:'application',name:'voice_provider_failure',status:'failed',text:null,details:{errorCode:'provider_unknown_error',action:'recovery_check'}}),event('2',{kind:'connection',actor:'application',name:'voice_request_recovery',status:'requested',text:null,details:{state:'checking',source:'application'}})])));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText('正在核验语音连接')));assert(screen.getByText('语音请求被拒绝'));assert.equal(screen.queryByText('语音连接已恢复'),null);assert.equal(screen.queryByText('恢复阶段'),null);
 await openTimelineDetails();assert(screen.getByText('正在核验连接（尚未确认恢复）'));
 const row=screen.getByText('正在核验语音连接').closest('.td-timeline-item');assert(row);await act(async()=>{fireEvent.click(row.querySelector('summary')!);await Promise.resolve();});assert(screen.getByText('恢复阶段'));assert(screen.getByText('核验中'));
});

test('independent list filters and paging use the existing admin endpoint',async()=>{
 const calls=fixture(url=>Response.json(list({total:25,page:Number(url.searchParams.get('page')??0)})));render(<ClassroomDiagnostics/>);
 await waitFor(()=>assert(screen.getByRole('button',{name:'排查 Mia 的课堂'})));
 fireEvent.change(screen.getByLabelText('邮箱或孩子昵称'),{target:{value:'Mia & friends'}});await click('查询课堂');
 await waitFor(()=>assert(calls.some(url=>url.searchParams.get('query')==='Mia & friends')));await click('下一页课堂');
 await waitFor(()=>assert.equal(calls.at(-1)?.searchParams.get('page'),'1'));assert.equal(calls.at(-1)?.searchParams.get('pageSize'),'20');
});
test('single-class deep link switches between explicit turns and complete events and locates an anomaly',async()=>{
 fixture(()=>Response.json(details([event('1'),event('2',{kind:'connection',actor:'application',status:'failed',name:'voice_closed',text:null,details:{turnId,clock:'server',phase:'error'}})])));
 render(<ClassroomDiagnostics classroomId={id} eventId="2"/>);
 await waitFor(()=>assert(screen.getByText('Private generated sentence')));await click('技术详情');assert(screen.getAllByText(/生成文字/).length>0);assert(screen.getAllByText(/服务端时钟/).length>0);
 assert(screen.getAllByText(/未采集/).length>0);await click('定位首个异常');
 assert.equal(document.activeElement?.getAttribute('id'),'diagnostic-event-2');assert(screen.getByRole('list',{name:'课堂时间轴'}));
 fireEvent.click(screen.getByLabelText('仅看异常'));assert.equal(screen.queryByText('Private generated sentence'),null);assert(screen.getByText('voice_closed'));
});
test('copy exports only loaded metadata and reports a partial coverage boundary',async()=>{
 let copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied=value;}}});
 fixture(()=>Response.json(details([event('1')],{nextCursor:'1'})));render(<ClassroomDiagnostics classroomId={id}/>);
 await waitFor(()=>assert(screen.getByText('Private generated sentence')));await click('技术详情');await click('复制脱敏排查包');await waitFor(()=>assert(copied));
 assert(!copied.includes('Private generated sentence'));assert(!copied.includes('parent@example.test'));assert(!copied.includes('Mia'));assert(!copied.includes('fixture-model'));
 assert.equal(JSON.parse(copied).coverage.complete,false);assert(screen.getAllByText(/仅含已加载/).length>0);
});
test('incremental refresh deduplicates and pauses without overlapping pending reads',async()=>{
 let finish!:(value:Response)=>void,reads=0;const calls=fixture(()=>{reads++;return reads===1?Response.json(details([event('1')],{nextCursor:'1'})):new Promise<Response>(resolve=>{finish=resolve;});});
 render(<ClassroomDiagnostics classroomId={id} refreshIntervalMs={25}/>);await waitFor(()=>assert.equal(reads,2));
 await new Promise(resolve=>setTimeout(resolve,80));assert.equal(reads,2);await click('暂停自动刷新');
 await act(async()=>finish(Response.json(details([event('1'),event('2',{text:'new sentence'})]))));
 await waitFor(()=>assert(screen.getByText('new sentence')));assert.equal(screen.getAllByText('Private generated sentence').length,1);assert.equal(calls.at(-1)?.searchParams.get('after'),'1');
 await new Promise(resolve=>setTimeout(resolve,80));assert.equal(reads,2);
});
test('permission failure clears previously loaded content and offers independent admin login',async()=>{
 let forbidden=false;fixture(()=>forbidden?Response.json({ok:false,error:{code:'FORBIDDEN',message:'denied'}},{status:403}):Response.json(details()));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText('Private generated sentence')));forbidden=true;await click('刷新事件');
 await waitFor(()=>assert(screen.getByRole('alert').textContent?.includes('管理权限')));assert.equal(screen.queryByText('Private generated sentence'),null);
 assert.match(screen.getByRole('link',{name:'重新登录管理后台'}).getAttribute('href')??'',/^\/admin\/login\?returnTo=/);
});
test('loading and safe read failure can be retried, empty history remains empty',async()=>{
 let reads=0;fixture(()=>++reads===1?Response.json({ok:false,error:{code:'UNAVAILABLE',message:'fixture-error'}},{status:503}):Response.json(details([],{coverage:'none'})));
 render(<ClassroomDiagnostics classroomId={id}/>);assert(screen.getByText('正在读取课堂事件…'));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});assert(screen.getByRole('alert'));await click('重试读取');assert(screen.getByText('这节课堂没有可查看的日志。'));
});
test('late classroom data cannot overwrite a newly selected route',async()=>{
 let finish!:(value:Response)=>void;fixture(url=>url.pathname.includes(secondId)?Response.json(details([event('8',{text:'second classroom'})],{classroom:classroom(secondId)})):new Promise<Response>(resolve=>{finish=resolve;}));
 const view=render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(finish));view.rerender(<ClassroomDiagnostics classroomId={secondId}/>);
 await waitFor(()=>assert(screen.getByText('second classroom')));await act(async()=>finish(Response.json(details())));assert.equal(screen.queryByText('Private generated sentence'),null);
});
test('unloaded fault links expose the gap and load forward instead of inventing the event',async()=>{
 fixture(url=>Response.json(url.searchParams.get('after')?details([event('2',{text:'fault target'})]):details([event('1')],{nextCursor:'1'})));
 render(<ClassroomDiagnostics classroomId={id} eventId="2"/>);await waitFor(()=>assert(screen.getByText(/目标事件尚未加载/)));await click('加载更多事件');
 await waitFor(()=>assert(screen.getByText('fault target')));await waitFor(()=>assert.equal(document.activeElement?.id,'diagnostic-event-2'));
});

test('a long classroom can continue into another bounded window without claiming full coverage',async()=>{
 fixture(url=>{const after=Number(url.searchParams.get('after')??0),rows=Array.from({length:100},(_,index)=>event(String(after+index+1),{text:`sentence ${after+index+1}`}));return Response.json(details(rows,{classroom:{...classroom(),eventCount:1200},nextCursor:after<1100?String(after+100):null}));});
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText('sentence 100')));await click('暂停自动刷新');fireEvent.click(screen.getByLabelText('仅看异常'));
 for(let index=1;index<10;index++){await click('加载更多事件');await waitFor(()=>assert(screen.getByText(new RegExp(`仅含已加载 ${(index+1)*100} / 1200`))));}
 assert(screen.getByText(/1000 条事件上限/));await click('读取下一段事件');await waitFor(()=>assert(screen.getByText(/事件范围 1001 — 1100/)));assert.equal(screen.queryByText('sentence 1'),null);assert(screen.getByText(/覆盖不完整/));
});
test('changing the coverage source replaces the old window before merging new journal events',async()=>{
 let reads=0;const calls=fixture(()=>Response.json(++reads===1?details([event('1',{text:'legacy line'})],{coverage:'legacy_transcripts'}):reads===2?details([event('2',{text:'discard incomplete merge'})]):details([event('3',{text:'fresh journal'})])));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText('legacy line')));await click('刷新事件');await waitFor(()=>assert(screen.getByText('fresh journal')));
 assert.equal(screen.queryByText('legacy line'),null);assert.equal(screen.queryByText('discard incomplete merge'),null);assert.equal(calls.at(-1)?.searchParams.get('after'),null);
});
test('playback telemetry retains client provenance and measured durations without claiming delivery',async()=>{
 fixture(()=>Response.json(details([event('1'),event('2',{kind:'connection',actor:'application',name:'playback_finished',text:null,details:{turnId,source:'client',clock:'client',phase:'playback_finished',elapsedMs:530,queueMs:20,rttMs:90}})])));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText('Private generated sentence')));await click('技术详情');await waitFor(()=>assert(screen.getByText('客户端报告播放（未独立核验）')));assert(screen.getByText('客户端时钟'));assert(screen.getByText('530 ms'));assert(screen.getByText('20 ms'));assert(screen.getByText('90 ms'));
});
test('event location links retain the selected classroom and filter dates reject reversed ranges',async()=>{
 const calls=fixture();render(<ClassroomDiagnostics/>);await waitFor(()=>assert(screen.getByRole('button',{name:'排查 Mia 的课堂'})));
 fireEvent.change(screen.getByLabelText('开始日期'),{target:{value:'2026-11-12'}});fireEvent.change(screen.getByLabelText('结束日期'),{target:{value:'2026-11-01'}});await click('查询课堂');assert.equal(calls.length,1);assert(screen.getByRole('alert').textContent?.includes('开始日期'));
 await click('排查 Mia 的课堂');await waitFor(()=>assert(screen.getByText('Private generated sentence')));await openTimelineDetails();assert.equal(screen.getByRole('link',{name:'事件 1 的定位链接'}).getAttribute('href'),`/admin/diagnostics?classroomId=${id}&eventId=1`);
});

test('incremental updates do not steal keyboard focus after the initial deep-link location',async()=>{
 fixture();render(<ClassroomDiagnostics classroomId={id} eventId="1"/>);await waitFor(()=>assert(screen.getByText('Private generated sentence')));assert.equal(document.activeElement?.id,'diagnostic-event-1');
 const refresh=screen.getByRole('button',{name:'刷新事件'});refresh.focus();await click('刷新事件');assert(document.activeElement===refresh,'refresh must retain keyboard focus');
});

test('safe application fault codes and state are visible without exporting free-form details',async()=>{
 fixture(()=>Response.json(details([event('1',{kind:'connection',actor:'application',status:'failed',text:null,name:'voice_closed',details:{clock:'server',phase:'error',errorCode:'PROVIDER_UNAVAILABLE',state:'disconnected'}})])));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByRole('button',{name:'技术详情'})));await click('技术详情');await waitFor(()=>assert(screen.getByText('voice_closed')));assert(screen.getByText('PROVIDER_UNAVAILABLE'));assert(screen.getByText('disconnected'));
});

test('classroom details expose a stable copyable log ID without copying dialogue or account data',async()=>{
 const copied:string[]=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied.push(value);}}});
 fixture();render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText(`TKLOG1:${id}`)));
 await click('复制课堂日志ID');assert.deepEqual(copied,[`TKLOG1:${id}`]);assert(screen.getByText(`已复制课堂日志ID：TKLOG1:${id}`));
});
test('a specific persistent event copies its exact scoped bigint reference',async()=>{
 let copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied=value;}}});
 fixture(()=>Response.json(details([event('9007199254740993')])));render(<ClassroomDiagnostics classroomId={id}/>);
 await waitFor(()=>assert(screen.getByText('Private generated sentence')));await openTimelineDetails();await waitFor(()=>assert(screen.getByRole('button',{name:'复制事件 9007199254740993 的排查ID'})));
 await click('复制事件 9007199254740993 的排查ID');assert.equal(copied,`TKLOG1:${id}:E9007199254740993`);
});
test('classroom list IDs can be copied without opening or fetching private event contents',async()=>{
 let copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied=value;}}});
 const calls=fixture();render(<ClassroomDiagnostics/>);await waitFor(()=>assert(screen.getByRole('button',{name:'复制 Mia 的课堂日志ID'})));
 await click('复制 Mia 的课堂日志ID');assert.equal(copied,`TKLOG1:${id}`);assert(calls.every(url=>!url.pathname.endsWith('/events')));
});
test('legacy transcript rows offer only classroom IDs and explain the absence of stable event IDs',async()=>{
 fixture(()=>Response.json(details([event('1')],{coverage:'legacy_transcripts'})));render(<ClassroomDiagnostics classroomId={id}/>);
 await waitFor(()=>assert(screen.getByRole('button',{name:'复制课堂日志ID'})));assert.equal(screen.queryByRole('button',{name:/复制事件 .* 的排查ID/}),null);
 assert(screen.getByText('历史转写没有稳定的事件ID，可复制课堂日志ID定位。'));
});
test('clipboard failures leave a selectable ID in a safe manual-copy message',async()=>{
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('PRIVATE_CLIPBOARD_ERROR');}}});
 fixture();render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByRole('button',{name:'复制课堂日志ID'})));
 await click('复制课堂日志ID');assert(screen.getByText(`复制未成功，请手动复制：TKLOG1:${id}`));assert.equal(screen.queryByText('PRIVATE_CLIPBOARD_ERROR'),null);
});
test('diagnostic metadata copies include their classroom and persistent-event locator IDs',async()=>{
 let copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied=value;}}});
 fixture();render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText('Private generated sentence')));
 await click('技术详情');await click('复制脱敏排查包');const result=JSON.parse(copied);assert.equal(result.diagnosticId,`TKLOG1:${id}`);assert.equal(result.events[0].diagnosticId,`TKLOG1:${id}:E1`);assert(!copied.includes('Private generated sentence'));assert(!copied.includes('parent@example.test'));
});

test('the default timeline keeps conversation readable and technical facts behind item details',async()=>{
 fixture(()=>Response.json(details([event('1'),event('2',{kind:'connection',actor:'application',name:'diagnostic_phase',text:null,details:{phase:'response_requested',clock:'server',turnId}})])));
 render(<ClassroomDiagnostics classroomId={id}/>);
 await waitFor(()=>assert(screen.getByText('Private generated sentence')));
 assert(screen.getByRole('list',{name:'课堂时间轴'}));assert(screen.getByRole('region',{name:'最近进展'}));
 assert.equal(screen.queryByText('服务端时钟'),null);assert.equal(screen.queryByText('response_requested'),null);
 assert.equal(screen.queryByRole('button',{name:'完整事件'}),null);
 const row=document.querySelector('.td-timeline-item details') as HTMLDetailsElement;
 assert(row&&!row.open);fireEvent.click(row.querySelector('summary')!);
 await waitFor(()=>assert(screen.getAllByText('服务端时钟').length>0));
 assert.equal(screen.getAllByText('Private generated sentence').length,1);
 assert(screen.getByRole('button',{name:'复制事件 1 的排查ID'}));
});


test('a deep link to hidden technical data opens the advanced event without inventing a timeline action',async()=>{
 fixture(()=>Response.json(details([event('1',{details:{source:'speech'}}),event('2',{kind:'connection',actor:'application',name:'diagnostic_phase',text:null,details:{phase:'context_updated',clock:'server'}})])));
 render(<ClassroomDiagnostics classroomId={id} eventId="2"/>);
 await waitFor(()=>assert.equal(document.activeElement?.id,'diagnostic-event-2'));
 assert(screen.getByRole('button',{name:'返回时间轴'}));assert(screen.getByText('context_updated'));
 await click('返回时间轴');assert(screen.getByRole('list',{name:'课堂时间轴'}));assert.equal(screen.queryByText('context_updated'),null);
});

test('pausing record updates never presents the previous progress as a live diagnosis',async()=>{
 const calls=fixture(()=>Response.json(details([event('1',{createdAt:new Date().toISOString(),kind:'connection',actor:'application',name:'diagnostic_phase',text:null,details:{phase:'response_requested',clock:'server'}})],{classroom:{...classroom(),eventCount:1}})));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByRole('region',{name:'最近进展'})));
 await click('暂停自动刷新');assert(screen.getByRole('region',{name:'最近进展'}).textContent?.includes('记录更新已暂停'));
 await new Promise(resolve=>setTimeout(resolve,60));assert.equal(calls.length,1);
});

test('action details expose selected request and execution facts only after opening the row',async()=>{
 fixture(()=>Response.json(details([
  event('1',{kind:'tool',actor:'teacher',name:'highlight_objects',status:'requested',text:null,correlationId:'highlight-1',details:{objectIds:['banana']}}),
  event('2',{kind:'tool',actor:'application',name:'highlight_objects',status:'confirmed',text:null,correlationId:'highlight-1',details:{highlighted:['banana'],resultStatus:'confirmed'}}),
 ],{classroom:{...classroom(),eventCount:2}})));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByRole('list',{name:'课堂时间轴'})));
 assert.equal(screen.queryByText('请求对象'),null);await openTimelineDetails();
 assert(screen.getByText('请求对象'));assert(screen.getByText('已标记对象'));assert(screen.getByText('应用结果'));
 assert.equal(document.querySelectorAll('.td-business-facts').length,2);
});

test('a read error marks the last progress as unconfirmed without removing the loaded timeline',async()=>{
 let failed=false;fixture(()=>failed?Response.json({ok:false,error:{code:'UNAVAILABLE',message:'not displayed'}},{status:503}):Response.json(details([event('1',{createdAt:new Date().toISOString()})],{classroom:{...classroom(),eventCount:1}})));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText('Private generated sentence')));
 failed=true;await click('刷新事件');await waitFor(()=>assert(screen.getByRole('region',{name:'最近进展'}).textContent?.includes('当前进展无法确认')));
 assert(screen.getByText('Private generated sentence'));assert(screen.getByRole('alert'));
});


test('locating a timeline anomaly reopens its details without switching to technical cards',async()=>{
 fixture(()=>Response.json(details([event('1'),event('2',{kind:'connection',actor:'application',status:'failed',name:'voice_closed',text:null,details:{errorCode:'response_timeout'}})])));
 render(<ClassroomDiagnostics classroomId={id} eventId="2"/>);
 await waitFor(()=>assert.equal(document.activeElement?.id,'diagnostic-event-2'));
 for(let i=0;i<2;i++){
  const row=document.getElementById('diagnostic-event-2')!.closest('details')!;
  await act(async()=>{fireEvent.click(row.querySelector('summary')!);await new Promise(resolve=>setTimeout(resolve,0));});
  await waitFor(()=>assert.equal(document.getElementById('diagnostic-event-2'),null));
  await click('定位首个异常');
  assert(screen.getByRole('list',{name:'课堂时间轴'}));
  await waitFor(()=>assert.equal(document.activeElement?.id,'diagnostic-event-2'));
  assert((document.getElementById('diagnostic-event-2')!.closest('details') as HTMLDetailsElement).open);
 }
});

const latencyId='10000000-0000-4000-8000-000000000099',latencyInput='20000000-0000-4000-8000-000000000099';
function latencyRow(id:string,stage:string,elapsedMs:number,extra:Record<string,unknown>={}){return event(id,{kind:'connection',actor:'application',name:'latency_stage',text:null,details:{measurementId:latencyId,latencyInputId:latencyInput,latencyStage:stage,latencyBasis:'provider_turn',clock:'server',elapsedMs,...extra}});}
test('round latency and measured waiting stage are prominent without opening technical details',async()=>{
 const rows=[latencyRow('1','input_received',0),latencyRow('2','speech_stopped',1000),event('3',{actor:'child',text:'An apple.',details:{source:'speech',measurementId:latencyId,latencyInputId:latencyInput}}),latencyRow('4','input_final',1800),latencyRow('5','response_requested',2100),latencyRow('6','audio_first_received',4200),latencyRow('7','playback_started',0,{clock:'client',waitMs:3500,playbackMs:80})];
 fixture(()=>Response.json(details(rows,{classroom:{...classroom(),eventCount:rows.length}})));render(<ClassroomDiagnostics classroomId={id}/>);
 await waitFor(()=>assert(screen.getByText('An apple.')));
 assert.match(document.querySelector('.td-timeline-item summary')?.textContent??'',/等待 3.5 秒 · 较长的已测阶段：回复等待 2.1 秒/);
 assert.equal(document.querySelectorAll('.td-timeline-item').length,1);assert.equal(document.querySelectorAll('.td-timeline-item details[open]').length,0);
 await openTimelineDetails();assert(screen.getByLabelText('本轮时延分段'));assert(screen.getByText('到浏览器后等待播放'));
});
test('audio without recognized text has one measured round rather than hidden protocol records',async()=>{
 fixture(()=>Response.json(details([latencyRow('1','input_received',0),latencyRow('2','speech_stopped',800),latencyRow('3','response_requested',1600)],{classroom:{...classroom(),eventCount:3}})));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText('本轮语音')));
 assert(screen.getAllByText(/等待老师语音/).length>0);assert.equal(document.querySelectorAll('.td-timeline-item').length,1);assert.equal(screen.queryByText('latency_stage'),null);
});
test('historical student speech visibly says latency is unmeasured instead of fabricating a zero',async()=>{
 fixture(()=>Response.json(details([event('1',{actor:'child',text:'Historical speech',details:{source:'speech'}})],{classroom:{...classroom(),eventCount:1}})));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText('Historical speech')));assert(screen.getByText('时延未测得'));assert.equal(screen.queryByText(/等待 0.0 秒/),null);
});
test('advanced measurement details expose the latency stage and explicit measurement association',async()=>{
 fixture(()=>Response.json(details([latencyRow('1','speech_stopped',1000),latencyRow('2','playback_started',0,{clock:'client',waitMs:2300})])));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText('本轮语音')));await click('技术详情');
 assert(screen.getByText('speech_stopped'));await click('按话轮');assert(screen.getByRole('heading',{name:/本轮时延/}));
});
test('pending round waiting is visible on its summary and updates only from recorded server snapshots',async()=>{
 let reads=0;fixture(()=>Response.json(details([latencyRow('1','speech_stopped',1000),latencyRow('2','wait_update',++reads===1?3400:5400,{state:'waiting_audio'})])));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText('本轮语音')));
 assert.match(document.querySelector('.td-timeline-item summary')?.textContent??'',/服务端最近记录已等 2.4 秒 · 等待老师语音/);
 await click('刷新事件');await waitFor(()=>assert.match(document.querySelector('.td-timeline-item summary')?.textContent??'',/服务端最近记录已等 4.4 秒/));
 assert.equal(document.querySelector<HTMLDetailsElement>('.td-timeline-item details')?.open,false);
});
test('teacher text shows the first-audible receipt without claiming playback finished',async()=>{
 const replySpan='40000000-0000-4000-8000-000000000099';
 fixture(()=>Response.json(details([latencyRow('1','speech_stopped',1000),event('2',{text:'The teacher reply.',details:{spanId:replySpan,turnId,playback:'generated'}}),latencyRow('3','playback_started',0,{spanId:replySpan,turnId,clock:'client',waitMs:3200})])));
 render(<ClassroomDiagnostics classroomId={id}/>);await waitFor(()=>assert(screen.getByText('The teacher reply.')));
 assert(screen.getByText('浏览器报告开始有声播放'));assert.equal(screen.queryByText('播放未确认'),null);assert.equal(screen.queryByText('浏览器报告播放结束'),null);
 assert.equal(document.querySelectorAll('#diagnostic-event-3').length,0);
});
