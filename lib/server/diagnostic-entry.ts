import {z} from 'zod';

export type DiagnosticEntryDependencies={
 authenticate(request:Request):Promise<{accountId:string}|null>;
 belongsToClassroom(accountId:string,classroomId:string):Promise<boolean>;
 adminOrigin:string;
 appOrigin:string;
 enabledAccountIds:readonly string[];
};
const identifier=z.string().uuid();
export function diagnosticEntryAllowlist(values: readonly string[]): Set<string> {
 return new Set(values.every(value=>identifier.safeParse(value).success)?values.map(value=>value.toLowerCase()):[]);
}
const response=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','vary':'Cookie, Origin','x-content-type-options':'nosniff'}});
const failure=(code:string,status:number)=>response({ok:false,error:{code,message:status===503?'课堂排查入口暂时不可用。':'课堂排查入口不可用。'}},status);
const disabled=()=>response({ok:true,enabled:false});
function trustedOrigin(value:string):string|null{
 try{
  const parsed=new URL(value),local=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);
  return value===parsed.origin&&!parsed.username&&!parsed.password&&(parsed.protocol==='https:'||parsed.protocol==='http:'&&local)?parsed.origin:null;
 }catch{return null;}
}
export function createDiagnosticEntryHandler(dependencies:DiagnosticEntryDependencies){
 const origin=trustedOrigin(dependencies.adminOrigin),appOrigin=trustedOrigin(dependencies.appOrigin);
 const enabledAccountIds=diagnosticEntryAllowlist(dependencies.enabledAccountIds);
 return async(request:Request):Promise<Response>=>{
  try{
   const url=new URL(request.url);
   if(url.pathname!=='/api/v1/diagnostics/entry')return failure('NOT_FOUND',404);
   if(request.method!=='GET')return failure('METHOD',405);
   if(!origin||!appOrigin)return failure('UNAVAILABLE',503);
   if(request.headers.get('sec-fetch-site')==='cross-site'||request.headers.has('origin')&&request.headers.get('origin')!==appOrigin)return failure('ORIGIN',403);
   const account=await dependencies.authenticate(request);
   if(!account||!identifier.safeParse(account.accountId).success)return failure('UNAUTHENTICATED',401);
   const classroomId=url.searchParams.get('classroomId');
   if(url.searchParams.size!==1||!identifier.safeParse(classroomId).success)return failure('INVALID_INPUT',400);
   if(!enabledAccountIds.has(account.accountId.toLowerCase()))return disabled();
   if(!await dependencies.belongsToClassroom(account.accountId,classroomId!))return disabled();
   const target=new URL('/admin/diagnostics',origin);target.searchParams.set('classroomId',classroomId!);
   return response({ok:true,enabled:true,url:target.toString()});
  }catch{return failure('UNAVAILABLE',503);}
 };
}
