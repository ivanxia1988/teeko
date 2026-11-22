import {getAccountPool} from '../../../../../db/postgres';
import {accountFromRequest,accountOrigin} from '../../../../../lib/server/account-runtime';
import {adminOrigin} from '../../../../../lib/server/admin-origin';
import {createDiagnosticEntryHandler} from '../../../../../lib/server/diagnostic-entry';
import {readRuntimeEnv} from '../../../../../lib/server/runtime-env';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function GET(request:Request){
 try{
  return await createDiagnosticEntryHandler({
   appOrigin:accountOrigin(),adminOrigin:adminOrigin(),
   enabledAccountIds:(readRuntimeEnv('DIAGNOSTIC_ENTRY_ACCOUNT_IDS')??'').split(',').map(value=>value.trim()).filter(Boolean),
   authenticate:async incoming=>{const account=await accountFromRequest(incoming);return account?{accountId:account.id}:null;},
   belongsToClassroom:async(accountId,classroomId)=>{
    const pool=getAccountPool(readRuntimeEnv('DATABASE_URL'));
    return Boolean((await pool.query('SELECT 1 FROM teeko_classrooms WHERE id=$1 AND account_id=$2',[classroomId,accountId])).rowCount);
   },
  })(request);
 }catch{return Response.json({ok:false,error:{code:'UNAVAILABLE',message:'课堂排查入口暂时不可用。'}},{status:503,headers:{'cache-control':'no-store'}});}
}
