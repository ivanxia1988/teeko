import {headers} from 'next/headers';
import {notFound,redirect} from 'next/navigation';
import {getAccountService} from '../../../../lib/server/account-runtime';
import {accountCookie} from '../../../../lib/server/account-http';
import {TopicClassroom} from '../../../../components/topics/topic-classroom';
import {classroomId} from '../../../../components/product/classroom-request';
import {getClassroomService} from '../../../../lib/server/classroom-runtime';
import {isTopicCourseId} from '../../../../lib/topic-learning';
import {ClassroomError} from '../../../../lib/server/classroom-service';
import '../../../../components/product/classroom.css';
import '../../../../components/product/teacher-avatar.css';
import '../../../../components/product/classroom-camera.css';
import '../../../../components/product/classroom-chalk.css';
import '../../../../components/product/classroom-notes.css';
import '../../../../components/topics/topic-classroom.css';

export const dynamic='force-dynamic';
export const metadata={title:'主题学习 · Teeko'};
export default async function TopicClassroomPage({params}:{params:Promise<{id:string}>}){
 const {id}=await params;if(!classroomId.safeParse(id).success)notFound();
 const incoming=await headers();
 const user=await getAccountService().session(accountCookie(new Request('https://app.local',{headers:incoming}),'teeko_session')).catch(()=>null);
 if(!user)redirect(`/topics/login?next=${encodeURIComponent(`/topics/classroom/${id}`)}`);
 const state=await (await getClassroomService()).get(user.id,id).catch(error=>{if(error instanceof ClassroomError&&error.status===404)notFound();throw error;});
 if(!isTopicCourseId(state.course.id))redirect(`/classroom/${id}`);
 return <TopicClassroom id={id}/>;
}
