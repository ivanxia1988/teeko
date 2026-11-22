import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { PublishedCourse } from '../classroom-contract';
import { TOPIC_CATALOG, type TopicCard } from '../topic-learning';
import { courseAssetPattern, courseIdPattern, courseVersionPattern, readCourseAsset, readCoursePackage } from './course-package';

type BundledCourse = PublishedCourse & { topic: NonNullable<PublishedCourse['topic']> };
type TopicContent = { courses: BundledCourse[]; cards: TopicCard[] };
const reservedIds = new Set(['classroom', 'login', 'me', 'picnic', 'robot-reading', ...TOPIC_CATALOG.map(card => card.id)]);
const bundledRoot = resolve(process.cwd(), 'courses', 'topics');

async function directories(path: string) {
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.some(entry => entry.isSymbolicLink())) throw new Error('Course package directories cannot contain symbolic links.');
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
}

function topicCard(course: BundledCourse): TopicCard {
  const { id, title, subtitle, description, durationMinutes, words, objectives, reading } = course;
  const { category, difficulty } = course.topic;
  const { image, width, height, id: firstPageId } = course.pages[0];
  const firstStep = course.steps.find(step => step.pageId === firstPageId) ?? course.steps[0];
  return {
    id, title, subtitle, description, durationMinutes, words, objectives, category, difficulty,
    categoryLabel: category === 'science' ? '科技' : '生活',
    difficultyLabel: difficulty === 'intermediate' ? '进阶表达' : '基础开口',
    coverImage: image,
    preview: { image, width, height, passage: firstStep.reading?.passage ?? firstStep.english },
    source: reading ? { title: reading.sourceTitle, url: reading.sourceUrl } : null,
  };
}

export async function loadTopicContent(root: string): Promise<TopicContent> {
  const folder = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!folder) return { courses: [], cards: [] };
  if (!folder.isDirectory()) throw new Error('Course catalog root must be a directory.');

  const courses: BundledCourse[] = [];
  const cards: TopicCard[] = [];
  for (const id of (await directories(root)).sort()) {
    if (!courseIdPattern.test(id) || id.length > 80) throw new Error('Invalid course package directory ID.');
    if (reservedIds.has(id)) throw new Error('Reserved course package directory ID: ' + id);
    const path = join(root, id);
    const versions = (await directories(path)).sort((a, b) => a.length - b.length || a.localeCompare(b, 'en'));
    let latest: BundledCourse | undefined;
    for (const version of versions) {
      if (!courseVersionPattern.test(version) || version.length > 30) {
        throw new Error('Course versions must use positive integer directory names.');
      }
      const result = await readCoursePackage(join(path, version));
      if (!result.course) throw new Error(id + '/' + version + ': ' + result.errors.join('; '));
      const course = result.course;
      latest = {
        ...course,
        topic: course.topic ?? { category: course.reading ? 'science' : 'life', difficulty: 'starter' },
        sessionLimitSeconds: course.sessionLimitSeconds ?? course.durationMinutes * 60,
      };
      courses.push(latest);
    }
    if (latest) cards.push(topicCard(latest));
  }
  return { courses, cards };
}

let bundled: Promise<TopicContent> | undefined;

export function bundledTopicContent(): Promise<TopicContent> {
  bundled ??= loadTopicContent(bundledRoot).catch(error => {
    bundled = undefined;
    throw error;
  });
  return bundled;
}

export async function readBundledTopicAsset(id: string, version: string, name: string) {
  if (!courseIdPattern.test(id) || !courseVersionPattern.test(version) || !courseAssetPattern.test(name)) return null;
  const course = (await bundledTopicContent()).courses.find(candidate => candidate.id === id && candidate.version === version);
  const assetPath = '/course-assets/' + id + '/' + version + '/' + name;
  if (!course?.pages.some(page => page.image === assetPath)) return null;
  const folder = join(bundledRoot, id, version, 'assets');
  if (!(await lstat(folder).catch(() => null))?.isDirectory()) return null;
  return readCourseAsset(join(folder, name));
}
