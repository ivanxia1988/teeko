import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { PublishedCourse } from '../classroom-contract';
import { courseReadingSource } from '../classroom-reading';

export const courseIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const courseVersionPattern = /^[1-9][0-9]*$/;
export const courseAssetPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(svg|png|webp|jpe?g)$/;
const id = z.string().max(80).regex(courseIdPattern, 'Use a lowercase kebab-case ID');
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
  version: z.string().max(30).regex(courseVersionPattern),
  title: text,
  subtitle: text,
  description: text,
  words: z.array(text).nonempty(),
  objectives: z.array(text).nonempty(),
  durationMinutes: positiveInteger.max(Math.floor(Number.MAX_SAFE_INTEGER / 60_000)),
  sessionLimitSeconds: positiveInteger.max(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)).optional(),
  topic: z.object({
    category: z.enum(['science', 'life']),
    difficulty: z.enum(['starter', 'intermediate']),
  }).strict().optional(),
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

type PackageResult = { course: PublishedCourse; errors: [] } | { course: null; errors: string[] };

export async function readCoursePackage(path: string | URL): Promise<PackageResult> {
  const folder = resolve(typeof path === 'string' ? path : fileURLToPath(path));
  let raw: unknown;
  try {
    const manifest = await readLocalFile(join(folder, 'course.json'), 512 * 1024);
    raw = JSON.parse(manifest?.toString('utf8') ?? '');
  } catch {
    return { course: null, errors: ['course.json: expected a readable JSON file up to 512 KiB'] };
  }
  const parsed = courseSchema.safeParse(raw);
  if (!parsed.success) {
    return { course: null, errors: parsed.error.issues.map(issue => `${issue.path.join('.') || 'course.json'}: ${issue.message}`) };
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
    if (!page.image.startsWith(assetPrefix) || !courseAssetPattern.test(assetName)) {
      errors.push(`${field}.image: use ${assetPrefix}<asset-file>`);
    } else if (!hasAssetFolder || !await fileExists(join(assetFolder, assetName))) {
      errors.push(`${field}.image: missing local assets/${assetName}`);
    } else if (!await readCourseAsset(join(assetFolder, assetName))) {
      errors.push(`${field}.image: use a valid passive SVG or raster image under 5 MiB`);
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
  return errors.length ? { course: null, errors } : { course, errors: [] };
}

export async function checkCourseDraft(path: string | URL): Promise<string[]> {
  return (await readCoursePackage(path)).errors;
}

async function readLocalFile(file: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) return null;
    const bytes = await handle.readFile();
    return bytes.length <= maxBytes ? bytes : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

const svgTags = new Set((
  'svg title desc g rect circle ellipse path line polyline polygon text tspan defs linearGradient radialGradient stop clipPath mask'
).split(' '));
const svgAttributes = new Set((
  'xmlns version viewBox preserveAspectRatio id role aria-label aria-hidden ' +
  'x y x1 y1 x2 y2 width height cx cy fx fy r rx ry d points transform ' +
  'fill fill-opacity fill-rule stroke stroke-opacity stroke-width stroke-dasharray stroke-dashoffset ' +
  'stroke-linecap stroke-linejoin stroke-miterlimit opacity clip-path clip-rule mask ' +
  'font-family font-size font-weight font-style text-anchor dominant-baseline letter-spacing dx dy ' +
  'gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity clipPathUnits maskUnits maskContentUnits'
).split(' '));
const svgNamespace = 'http://www.w3.org/2000/svg';

// Accept the workbook's passive geometry and text subset, without processing instructions or external references.
function isPassiveSvg(source: string): boolean {
  const input = source.trim().replace(/^<\?xml\s+version\s*=\s*["']1\.0["'](?:\s+encoding\s*=\s*["']UTF-8["'])?\s*\?>\s*/i, '');
  const element = /<!--(?:[^-]|-(?!-))*-->|<(\/?)([A-Za-z][A-Za-z0-9]*)(?=[\s/>])((?:\s+[A-Za-z][\w-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g;
  const attribute = /\s+([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const stack: string[] = [];
  let seenRoot = false;
  let position = 0;
  for (const match of input.matchAll(element)) {
    const between = input.slice(position, match.index);
    if (between.includes('<') || (!stack.length && between.trim())) return false;
    position = match.index + match[0].length;
    const [, closing, name, attributes, selfClosing] = match;
    if (!name) continue; // XML comment.
    if (!svgTags.has(name)) return false;
    if (closing) {
      if (attributes || selfClosing || stack.pop() !== name) return false;
      continue;
    }
    const seen = new Map<string, string>();
    for (const [, key, doubleQuoted, singleQuoted] of attributes.matchAll(attribute)) {
      const value = doubleQuoted ?? singleQuoted;
      if (!svgAttributes.has(key) || seen.has(key) || /[&\\]/.test(value)) return false;
      if (key === 'xmlns' && value !== svgNamespace) return false;
      if (/url\s*\(/i.test(value) &&
          (!['fill', 'stroke', 'clip-path', 'mask'].includes(key) || !/^url\(#[A-Za-z][\w-]*\)$/.test(value))) return false;
      seen.set(key, value);
    }
    if (!stack.length) {
      if (seenRoot || name !== 'svg' || seen.get('xmlns') !== svgNamespace) return false;
      seenRoot = true;
    }
    if (!selfClosing) stack.push(name);
  }
  return seenRoot && !stack.length && !input.slice(position).trim();
}

export async function readCourseAsset(file: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string } | null> {
  const name = basename(file);
  if (!courseAssetPattern.test(name)) return null;
  const bytes = await readLocalFile(file, 5 * 1024 * 1024);
  if (!bytes) return null;
  const extension = name.split('.').pop();
  let contentType: string;
  switch (extension) {
    case 'svg': {
      const text = new TextDecoder('utf-8', { fatal: true });
      let source: string;
      try { source = text.decode(bytes); } catch { return null; }
      if (!isPassiveSvg(source)) return null;
      contentType = 'image/svg+xml';
      break;
    }
    case 'png':
      if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return null;
      contentType = 'image/png';
      break;
    case 'jpg':
    case 'jpeg':
      if (!bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return null;
      contentType = 'image/jpeg';
      break;
    case 'webp':
      if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
      contentType = 'image/webp';
      break;
    default:
      return null;
  }
  return { bytes: Uint8Array.from(bytes), contentType };
}
