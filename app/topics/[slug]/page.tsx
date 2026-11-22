import { TopicDetail } from '../../../components/topics/topic-detail';
import { cookies } from 'next/headers';
import { getAccountPool } from '../../../db/postgres';
import type { ClassroomPreferences, PublishedCourse } from '../../../lib/classroom-contract';
import { isTopicCourseId, topicIdSchema } from '../../../lib/topic-learning';
import { getAccountService } from '../../../lib/server/account-runtime';
import { resolvePublishedTeacher } from '../../../lib/server/admin-service';
import { getClassroomService } from '../../../lib/server/classroom-runtime';
import { readRuntimeEnv } from '../../../lib/server/runtime-env';
import { bundledTopicContent } from '../../../lib/server/topic-content';
import { loadTopicPromptPreview } from '../../../lib/server/topic-prompt-preview';

async function previewForOperator(topicId: string) {
  const allowed = (readRuntimeEnv('DIAGNOSTIC_ENTRY_ACCOUNT_IDS') ?? '').split(',').map(id => id.trim()).filter(Boolean);
  if (!allowed.length || !topicIdSchema.safeParse(topicId).success) return;
  const token = (await cookies()).get('teeko_session')?.value;
  if (!token) return;
  try {
    const accounts = getAccountService();
    const account = await accounts.session(token);
    if (!account) return;
    return await loadTopicPromptPreview(topicId, account.id, allowed, async id => {
      const builtIn = isTopicCourseId(id);
      const version = builtIn ? null : (await bundledTopicContent()).courses.findLast(course => course.id === id)?.version ?? null;
      if (!builtIn && version === null) return null;
      await getClassroomService();
      const pool = getAccountPool(readRuntimeEnv('DATABASE_URL'));
      const { rows } = await pool.query<{manifest: PublishedCourse}>(
        'SELECT manifest FROM teeko_courses WHERE id=$1 AND ($2::text IS NULL OR version=$2) ORDER BY published_at DESC LIMIT 1', [id, version],
      );
      if (!rows[0]) return null;
      const [teacher, profile, saved] = await Promise.all([
        resolvePublishedTeacher(pool),
        accounts.getProfile(account.id),
        pool.query<{preferences: ClassroomPreferences}>('SELECT preferences FROM teeko_preferences WHERE account_id=$1', [account.id]),
      ]);
      return {
        course: rows[0].manifest, teacher, profile,
        preferences: saved.rows[0]?.preferences,
        defaultVoiceModel: readRuntimeEnv('OPENAI_LIVE_MODEL'),
      };
    });
  } catch {
    return undefined;
  }
}

export default async function TopicPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ start?: string | string[]; prompt?: string | string[] }> }) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const promptPreview = query.prompt === '1' ? await previewForOperator(slug) : undefined;
  return <TopicDetail key={slug} topicId={slug} start={query.start === '1'} promptPreview={promptPreview}/>;
}
