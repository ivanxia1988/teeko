'use client';

import {Classroom,type VoiceFactory} from '../product/classroom';
import {ClassroomVoiceClient} from '../../lib/classroom-voice-client';

const createVoice:VoiceFactory=options=>new ClassroomVoiceClient(options);
const navigate=(path:string)=>{
 if(path==='/topics'||path.startsWith('/topics/login?next='))window.location.assign(path);
};
export function TopicClassroom({id}:{id:string}){
 return <Classroom classroomId={id} voiceFactory={createVoice} variant="topic" navigate={navigate}/>;
}
