import {readBundledTopicAsset} from '../../../../../lib/server/topic-content';

export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function GET(_request:Request,{params}:{params:Promise<{courseId:string;version:string;asset:string}>}){
  const {courseId,version,asset}=await params;
  const file=await readBundledTopicAsset(courseId,version,asset);
  if(!file)return new Response(null,{status:404});
  return new Response(Uint8Array.from(file.bytes),{headers:{
    'Content-Type':file.contentType,
    'Content-Security-Policy':"default-src 'none'; sandbox",
    'X-Content-Type-Options':'nosniff',
    'Cache-Control':'public, max-age=3600',
  }});
}
