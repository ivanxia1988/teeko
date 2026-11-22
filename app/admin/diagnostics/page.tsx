import {ClassroomDiagnostics} from '../../../components/admin/classroom-diagnostics';
import '../../../components/product/product.css';
import '../../../components/admin/admin.css';
import '../../../components/admin/classroom-diagnostics.css';
import {safeAdminReturnTarget} from '../../../lib/admin-return-target';
import {requireAdminAccount} from '../../../lib/server/admin-guard';
import {classroomId as classroomIdSchema} from '../../../components/product/classroom-request';

export const metadata={title:'课堂排查台 · Teeko'};
export const dynamic='force-dynamic';
export default async function DiagnosticsPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const query=await searchParams;
 const classroomId=classroomIdSchema.safeParse(query.classroomId),eventId=typeof query.eventId==='string'&&/^[1-9]\d{0,18}$/.test(query.eventId)&&BigInt(query.eventId)<=BigInt('9223372036854775807')?query.eventId:undefined;
 const target=safeAdminReturnTarget(`/admin/diagnostics${classroomId.success?`?classroomId=${classroomId.data}${eventId?`&eventId=${eventId}`:''}`:''}`);await requireAdminAccount(target);
 return <main className="tk-product ta-app td-app"><div className="ta-workspace"><header className="ta-header"><div><span>TEEKO / ADMIN</span><h1>课堂排查台</h1></div><a href="/admin">返回管理后台</a></header><ClassroomDiagnostics classroomId={classroomId.success?classroomId.data:undefined} eventId={classroomId.success?eventId:undefined}/></div></main>;
}
