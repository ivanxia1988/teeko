import {z} from 'zod';

const prefix='/admin/diagnostics?',identifier=z.string().uuid(),decimal=/^(?:0|[1-9]\d{0,18})$/;
/** Accept a literal local route only; encoded paths and redirect parameters are never decoded into trust. */
export function safeAdminReturnTarget(value:unknown):string{
 if(typeof value!=='string'||value.length>200||!value.startsWith(prefix)||/[%#\\\s]/.test(value))return '/admin';
 const query=value.slice(prefix.length),parts=query.split('&');
 if(!parts.every(part=>/^(?:classroomId|eventId)=[A-Za-z0-9-]+$/.test(part)))return '/admin';
 const params=new URLSearchParams(query),classroomId=params.get('classroomId'),eventId=params.get('eventId');
 if(params.getAll('classroomId').length!==1||params.getAll('eventId').length>1||!identifier.safeParse(classroomId).success)return '/admin';
 if(eventId!==null&&(!decimal.test(eventId)||BigInt(eventId)>BigInt('9223372036854775807')))return '/admin';
 return `${prefix}classroomId=${classroomId!.toLowerCase()}${eventId!==null?`&eventId=${eventId}`:''}`;
}
export function adminLoginHref(value?:unknown):string{
 const target=safeAdminReturnTarget(value);
 return target==='/admin'?'/admin/login':`/admin/login?returnTo=${encodeURIComponent(target)}`;
}
