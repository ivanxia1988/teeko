import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { PublishedCourse } from '../lib/classroom-contract';
import { courseReadingSource } from '../lib/classroom-reading';

const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use a lowercase kebab-case ID');
const text = z.string().regex(/\S/, 'Provide non-blank text');
const positiveInteger = z.number().int().positive();
const fraction = z.number().min(0).max(1);
const objectSchema = z.object({
  id,
  label: text,
  chinese: text,
  box: z.object({
    x: fraction,
    y: fraction,
    w: fraction.gt(0),
    h: fraction.gt(0),
  }).strict(),
}).strict();

const courseSchema = z.object({
  id,
  version: z.string().regex(/^[1-9][0-9]*$/),
  title: text,
  subtitle: text,
  description: text,
  words: z.array(text).nonempty(),
  objectives: z.array(text).nonempty(),
  durationMinutes: positiveInteger,
  sessionLimitSeconds: positiveInteger.optional(),
  reading: z.object({
    sourceTitle: text.max(200),
    sourceUrl: text.max(2048),
    attribution: text.max(300),
  }).strict().optional(),
  pages: z.array(z.object({
    id,
    image: text,
    width: positiveInteger,
    height: positiveInteger,
    objects: z.array(objectSchema),
  }).strict()).nonempty(),
  steps: z.array(z.object({
    id,
    kind: z.enum(['listen', 'speak', 'select']),
    pageId: id,
    targetId: id.nullable(),
    english: text,
    chinese: text,
    hint: text,
    expected: text.nullable(),
    reading: z.object({
      phase: z.enum(['predict', 'read', 'explain', 'design', 'retell', 'chat']),
      passage: text.max(500),
      goal: text.max(260),
      teacherNotes: text.max(380),
      followUp: text.max(160),
    }).strict(),
  }).strict()).nonempty(),
}).strict() satisfies z.ZodType<PublishedCourse>;

async function fileExists(file: string) {
  return (await lstat(file).catch(() => null))?.isFile() === true;
}

export async function checkCourseDraft(path: string | URL): Promise<string[]> {
  const folder = resolve(typeof path === 'string' ? path : fileURLToPath(path));
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(folder, 'course.json'), 'utf8'));
  } catch {
    return ['course.json: expected a readable JSON file'];
  }
  const parsed = courseSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map(issue => `${issue.path.join('.') || 'course.json'}: ${issue.message}`);
  }

  const { data: course } = parsed;
  const errors: string[] = [];
  if (course.id !== basename(dirname(folder))) errors.push('id: must match the parent course folder');
  if (course.version !== basename(folder)) errors.push('version: must match the version folder');
  if (course.reading && !courseReadingSource(course)) {
    errors.push('reading.sourceUrl: use an HTTPS source URL without credentials');
  }
  if (!await fileExists(join(folder, 'AUTHOR-NOTES.md'))) {
    errors.push('AUTHOR-NOTES.md: include source and asset provenance for editorial review');
  }

  const pages = new Map<string, Set<string>>();
  const assetFolder = join(folder, 'assets');
  const hasAssetFolder = (await lstat(assetFolder).catch(() => null))?.isDirectory() === true;
  const assetPrefix = `/course-assets/${course.id}/${course.version}/`;
  for (const [index, page] of course.pages.entries()) {
    const field = `pages.${index}`;
    if (pages.has(page.id)) errors.push(`${field}.id: duplicate page ID`);
    const objects = new Set<string>();
    pages.set(page.id, objects);

    const assetName = page.image.slice(assetPrefix.length);
    if (!page.image.startsWith(assetPrefix) || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.(svg|png|webp|jpe?g)$/.test(assetName)) {
      errors.push(`${field}.image: use ${assetPrefix}<asset-file>`);
    } else if (!hasAssetFolder || !await fileExists(join(assetFolder, assetName))) {
      errors.push(`${field}.image: missing local assets/${assetName}`);
    }

    for (const [objectIndex, object] of page.objects.entries()) {
      const objectField = `${field}.objects.${objectIndex}`;
      if (objects.has(object.id)) errors.push(`${objectField}.id: duplicate ID on this page`);
      objects.add(object.id);
      const { x, y, w, h } = object.box;
      if (x + w > 1 || y + h > 1) errors.push(`${objectField}.box: must fit inside the page`);
    }
  }

  const steps = new Set<string>();
  for (const [index, step] of course.steps.entries()) {
    const field = `steps.${index}`;
    if (steps.has(step.id)) errors.push(`${field}.id: duplicate activity ID`);
    steps.add(step.id);
    if (step.kind === 'select') errors.push(`${field}.kind: use speak or listen in a voice-only topic`);
    if (step.expected !== null) errors.push(`${field}.expected: use null for an open spoken activity`);
    const objects = pages.get(step.pageId);
    if (!objects) errors.push(`${field}.pageId: page does not exist`);
    else if (step.targetId && !objects.has(step.targetId)) {
      errors.push(`${field}.targetId: target does not exist on this activity's page`);
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [folder] = process.argv.slice(2);
  if (!folder || process.argv.length !== 3) {
    console.error('Usage: npm run courses:check -- courses/drafts/<course-id>/<version>');
    process.exitCode = 1;
  } else {
    const errors = await checkCourseDraft(folder);
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log('Course draft passed the format, reference and local asset checks.');
    }
  }
}
