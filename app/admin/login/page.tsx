import {AdminLogin} from '../../../components/admin/admin-login';
import '../../../components/product/product.css';
import {requireAdminHost} from '../../../lib/server/admin-guard';
import {safeAdminReturnTarget} from '../../../lib/admin-return-target';
export const metadata={title:'管理后台登录 · Teeko'};
export const dynamic='force-dynamic';
export default async function AdminLoginPage({searchParams}:{searchParams:Promise<{returnTo?:string|string[]}>}){await requireAdminHost();const query=await searchParams;return <AdminLogin returnTo={safeAdminReturnTarget(query.returnTo)}/>;}
