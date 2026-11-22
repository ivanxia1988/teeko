import React from 'react';
import {after,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/admin',pretendToBeVisual:true});
for(const key of ['window','self','document','HTMLElement','Node','Event','MutationObserver','navigator'])Object.defineProperty(globalThis,key,{value:(dom.window as unknown as Record<string,unknown>)[key],configurable:true});
const {render,screen,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react');
const {ClassroomJournal}=await import('../components/admin/classroom-journal');
afterEach(cleanup);after(()=>dom.window.close());

const firstId='10000000-0000-4000-8000-000000000001',secondId='10000000-0000-4000-8000-000000000002',date='2026-11-02T01:00:00Z';
const classroom=(id=firstId)=>({id,accountId:'20000000-0000-4000-8000-000000000001',email:id===firstId?'parent@example.test':'another@example.test',childName:id===firstId?'Mia':'Leo',courseTitle:'一起去野餐',provider:'qwen',status:'ended',startedAt:date,endedAt:'2026-11-02T01:12:00Z',elapsedSeconds:720,agentName:'Teeko',agentVersion:1,model:'qwen-fixture',eventCount:3});
const event=(id:string,extra:Record<string,unknown>={})=>({id,createdAt:date,epoch:1,revision:3,stepIndex:0,kind:'utterance',actor:'child',status:'recorded',name:'transcript',text:'Please tap the banana.',correlationId:null,details:{source:'speech'},...extra});
const list=(rows=[classroom()],extra:Record<string,unknown>={})=>({ok:true,classrooms:rows,total:rows.length,page:0,pageSize:20,...extra});
const details=(events=[event('1')],extra:Record<string,unknown>={})=>({ok:true,classroom:classroom(),events,nextCursor:null,coverage:'journal',...extra});
async function click(name:string){await act(async()=>{fireEvent.click(screen.getByRole('button',{name}));});}
async function openFirst(){await waitFor(()=>assert(screen.getByRole('button',{name:'查看 Mia 的课堂日志'})));await click('查看 Mia 的课堂日志');}
function fixture(handler?:(url:URL)=>Response|Promise<Response>){
 const calls:URL[]=[];
 globalThis.fetch=async(input)=>{const url=new URL(String(input),'http://localhost');calls.push(url);return handler?handler(url):Response.json(url.pathname.endsWith('/events')?details():list());};
 return calls;
}

test('journal list uses real returned rows, bounded filters and paging',async()=>{
 const calls=fixture(url=>Response.json(list([classroom()],{total:25,page:Number(url.searchParams.get('page')??0)})));render(<ClassroomJournal/>);
 await waitFor(()=>assert(screen.getByText('parent@example.test')));assert(screen.getByText('12 分钟'));assert(screen.getByText('通义'));
 fireEvent.change(screen.getByLabelText('邮箱或孩子昵称'),{target:{value:'Mia & friends'}});fireEvent.change(screen.getByLabelText('开始日期'),{target:{value:'2026-11-01'}});fireEvent.change(screen.getByLabelText('结束日期'),{target:{value:'2026-11-02'}});
 await click('查询日志');await waitFor(()=>assert(calls.some(url=>url.searchParams.get('query')==='Mia & friends')));
 const filtered=calls.at(-1)!;assert.equal(filtered.searchParams.get('from'),'2026-11-01');assert.equal(filtered.searchParams.get('to'),'2026-11-02');assert.equal(filtered.searchParams.get('pageSize'),'20');
 await click('下一页课堂');await waitFor(()=>assert.equal(calls.at(-1)?.searchParams.get('page'),'1'));
});
test('loading, empty records and a failed list can be retried without fabricated rows',async()=>{
 let resolve!:(value:Response)=>void;let attempts=0;
 fixture(()=>{attempts++;return attempts===1?new Promise<Response>(r=>{resolve=r;}):Response.json(list([]));});render(<ClassroomJournal/>);
 assert(screen.getByRole('status').textContent?.includes('读取课堂'));
 await act(async()=>resolve(Response.json({ok:false,error:{code:'UNAVAILABLE',message:'日志暂时不可用。'}},{status:503})));
 await waitFor(()=>assert(screen.getByRole('alert').textContent?.includes('日志暂时不可用')));await click('重试读取日志');
 await waitFor(()=>assert(screen.getByText('没有符合条件的课堂。')));assert.equal(screen.queryByText('parent@example.test'),null);
});
test('timeline separates speech, teacher tool requests, receipts and visual delivery',async()=>{
 const rows=[event('1',{text:'<img src=x onerror=alert(1)>'}),event('2',{actor:'teacher',text:'Here is the banana.'}),event('3',{kind:'tool',actor:'teacher',status:'requested',name:'highlight_objects',text:null,correlationId:'call-one',details:{objectIds:['banana']}}),event('4',{kind:'tool',actor:'application',status:'confirmed',name:'highlight_objects',text:null,correlationId:'call-one',details:{highlighted:['banana'],resultStatus:'confirmed'}}),event('5',{kind:'visual',actor:'application',status:'recorded',name:'board.frame',text:null,details:{source:'board'}})];
 fixture(url=>Response.json(url.pathname.endsWith('/events')?details(rows):list()));render(<ClassroomJournal/>);await openFirst();
 await waitFor(()=>assert(screen.getByText('<img src=x onerror=alert(1)>')));assert.equal(document.querySelector('img'),null);assert(screen.getByText('学生'));assert(screen.getAllByText('老师').length>0);
 assert(screen.getByText('已请求'));assert(screen.getByText('已确认'));assert.equal(screen.getAllByText('关联 call-one').length,2);assert(screen.getByText(/老师文字是生成转写/));assert(screen.getByText(/图片状态不代表识别正确/));
});
test('more and refresh preserve loaded events and deduplicate receipts by event ID',async()=>{
 const calls=fixture(url=>{
  if(!url.pathname.endsWith('/events'))return Response.json(list());
  const after=url.searchParams.get('after');return Response.json(!after?details([event('1'),event('2',{text:'second'})],{nextCursor:'2'}):after==='2'?details([event('2',{text:'second'}),event('3',{text:'third'})]):details([event('3',{text:'third'}),event('4',{text:'fourth'})]));
 });render(<ClassroomJournal/>);await openFirst();await waitFor(()=>assert(screen.getByText('second')));await click('加载更多事件');await waitFor(()=>assert(screen.getByText('third')));
 await click('刷新课堂日志');await waitFor(()=>assert(screen.getByText('fourth')));assert(screen.getByText('Please tap the banana.'));assert.equal(screen.getAllByText('second').length,1);assert.equal(screen.getAllByText('third').length,1);
 assert.equal(calls.at(-1)?.searchParams.get('after'),'3');
});
test('a late response from a previous classroom cannot overwrite another classroom',async()=>{
 let finishFirst!:(value:Response)=>void;
 fixture(url=>{if(!url.pathname.endsWith('/events'))return Response.json(list([classroom(),classroom(secondId)]));return url.pathname.includes(firstId)?new Promise<Response>(resolve=>{finishFirst=resolve;}):Response.json(details([event('8',{text:'Leo latest conversation'})],{classroom:classroom(secondId)}));});
 render(<ClassroomJournal/>);await openFirst();await click('返回课堂列表');await click('查看 Leo 的课堂日志');await waitFor(()=>assert(screen.getByText('Leo latest conversation')));
 await act(async()=>{finishFirst(Response.json(details([event('9',{text:'stale Mia conversation'})])));});
 assert.equal(screen.queryByText('stale Mia conversation'),null);assert(screen.getByText('Leo latest conversation'));
});
test('permission loss removes previously displayed conversation and offers admin login',async()=>{
 let deny=false;fixture(url=>deny?Response.json({ok:false,error:{code:'UNAUTHORIZED',message:'请先登录。'}},{status:401}):Response.json(url.pathname.endsWith('/events')?details():list()));
 render(<ClassroomJournal/>);await openFirst();await waitFor(()=>assert(screen.getByText('Please tap the banana.')));deny=true;await click('刷新课堂日志');
 await waitFor(()=>assert(screen.getByRole('link',{name:'返回管理登录'})));assert.equal(screen.queryByText('Please tap the banana.'),null);assert.equal(screen.getByRole('link',{name:'返回管理登录'}).getAttribute('href'),'/admin/login');
});
test('legacy and absent history never claim a complete interaction timeline',async()=>{
 fixture(url=>Response.json(url.pathname.endsWith('/events')?details([event('1')],{coverage:'legacy_transcripts'}):list()));render(<ClassroomJournal/>);await openFirst();
 await waitFor(()=>assert(screen.getByText(/仅保留部分历史转写/)));assert.equal(screen.queryByText('完整历史'),null);
});
test('fully loaded student-only legacy history explicitly explains that teacher replies were never saved',async()=>{
 fixture(url=>Response.json(url.pathname.endsWith('/events')?details([event('1')],{coverage:'legacy_transcripts',classroom:{...classroom(),eventCount:1}}):list()));
 render(<ClassroomJournal/>);await openFirst();await waitFor(()=>assert(screen.getByText(/这节历史课堂没有保留老师回答，无法补回/)));
 assert(screen.getByText('Please tap the banana.'));
});
test('partial legacy pages do not claim an unseen teacher reply is missing',async()=>{
 fixture(url=>Response.json(url.pathname.endsWith('/events')?details([event('1')],{coverage:'legacy_transcripts',nextCursor:'1',classroom:{...classroom(),eventCount:2}}):list()));
 render(<ClassroomJournal/>);await openFirst();await waitFor(()=>assert(screen.getByText(/仅保留部分历史转写/)));
 assert.equal(screen.queryByText(/没有保留老师回答/),null);
});
test('legacy history with an actual teacher reply and new journals do not get a missing-reply notice',async()=>{
 fixture(url=>Response.json(url.pathname.endsWith('/events')?details([event('1',{actor:'teacher',text:'Here is the apple.'})],{coverage:'legacy_transcripts',classroom:{...classroom(),eventCount:1}}):list()));
 const ui=render(<ClassroomJournal/>);await openFirst();await waitFor(()=>assert(screen.getByText('Here is the apple.')));assert.equal(screen.queryByText(/没有保留老师回答/),null);ui.unmount();
 fixture();render(<ClassroomJournal/>);await openFirst();await waitFor(()=>assert(screen.getByText('Please tap the banana.')));assert.equal(screen.queryByText(/没有保留老师回答/),null);
});
test('timeline retry retains previous events and retries the failed cursor',async()=>{
 let fail=true;const calls=fixture(url=>{
  if(!url.pathname.endsWith('/events'))return Response.json(list());if(!url.searchParams.has('after'))return Response.json(details([event('1')],{nextCursor:'1'}));
  if(fail){fail=false;return Response.json({ok:false,error:{code:'UNAVAILABLE',message:'稍后重试。'}},{status:503});}return Response.json(details([event('2',{text:'new result'})]));
 });render(<ClassroomJournal/>);await openFirst();await waitFor(()=>assert(screen.getByText('Please tap the banana.')));await click('加载更多事件');await waitFor(()=>assert(screen.getByRole('alert')));
 assert(screen.getByText('Please tap the banana.'));await click('重试读取日志');await waitFor(()=>assert(screen.getByText('new result')));assert.equal(calls.at(-1)?.searchParams.get('after'),'1');
});
test('classroom journal is reachable through the existing admin navigation',async()=>{
 const {AdminConsole}=await import('../components/admin/admin-console');
 const calls=fixture(url=>Response.json(url.pathname.endsWith('/config')?{ok:true,models:[],agents:[],releases:[],activeRelease:null,providers:{qwen:true,openai:true}}:url.pathname.endsWith('/overview')?{ok:true,overview:{days:7,registeredUsers:0,profiledUsers:0,newUsers:0,activeUsers:0,classroomCount:0,endedCount:0,usageSeconds:0,providerUsage:[],endings:[]}}:list()));
 render(<AdminConsole/>);await waitFor(()=>assert(screen.getByText('累计注册用户')));await click('课堂日志');await waitFor(()=>assert(screen.getByText('parent@example.test')));
 assert(calls.some(url=>url.pathname==='/api/v1/admin/classrooms'));assert(screen.getByRole('button',{name:'课堂日志'}).getAttribute('aria-current')==='page');
});
test('date validation stays local and all filter controls are keyboard reachable',async()=>{
 const calls=fixture();const {default:userEvent}=await import('@testing-library/user-event');const user=userEvent.setup({document:dom.window.document});
 render(<ClassroomJournal/>);await waitFor(()=>assert(screen.getByText('parent@example.test')));await user.tab();assert.equal(document.activeElement,screen.getByLabelText('邮箱或孩子昵称'));await user.tab();assert.equal(document.activeElement,screen.getByLabelText('开始日期'));
 fireEvent.change(screen.getByLabelText('开始日期'),{target:{value:'2026-11-03'}});fireEvent.change(screen.getByLabelText('结束日期'),{target:{value:'2026-11-02'}});const before=calls.length;await click('查询日志');
 assert(screen.getByRole('alert').textContent?.includes('开始日期不能晚于结束日期'));assert.equal(calls.length,before);
});
test('legacy cursor is discarded when a resumed old classroom begins recording structured events',async()=>{
 let opened=false;const calls=fixture(url=>{
  if(!url.pathname.endsWith('/events'))return Response.json(list());
  if(url.searchParams.has('after'))return Response.json(details([]));
  if(!opened){opened=true;return Response.json(details([event('10',{text:'legacy conversation'})],{coverage:'legacy_transcripts'}));}
  return Response.json(details([event('1',{text:'new structured event'})]));
 });render(<ClassroomJournal/>);await openFirst();await waitFor(()=>assert(screen.getByText('legacy conversation')));await click('刷新课堂日志');
 await waitFor(()=>assert(screen.getByText('new structured event')));assert.equal(screen.queryByText('legacy conversation'),null);assert.equal(calls.at(-1)?.searchParams.has('after'),false);assert(screen.getByText(/完整互动日志从本次更新起记录/));
});
