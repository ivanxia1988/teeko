import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { PublishedCourse } from '../lib/classroom-contract';
import { loadTopicContent } from '../lib/server/topic-content';

const example = new URL('../courses/drafts/paper-glider/1/', import.meta.url);
type Draft = PublishedCourse & { topic?: { category: 'science' | 'life'; difficulty: 'starter' | 'intermediate' } };

async function fixture(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), 'teeko-topic-content-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return { root: join(folder, 'topics'), drafts: join(folder, 'drafts') };
}

async function coursePackage(root: string, id: string, version: string, edit?: (course: Draft) => void) {
  const folder = join(root, id, version);
  await cp(example, folder, { recursive: true });
  const manifest = join(folder, 'course.json');
  const course = JSON.parse(await readFile(manifest, 'utf8')) as Draft;
  course.id = id;
  course.version = version;
  course.title = `Paper glider ${version}`;
  for (const page of course.pages) page.image = `/course-assets/${id}/${version}/${page.image.split('/').pop()}`;
  edit?.(course);
  await writeFile(manifest, JSON.stringify(course));
  return folder;
}

test('discovers packages from the publication directory and lists only the latest numeric version', async t => {
  const { root, drafts } = await fixture(t);
  await coursePackage(drafts, 'unreviewed-topic', '1');
  assert.deepEqual(await loadTopicContent(root), { courses: [], cards: [] });
  await coursePackage(root, 'paper-glider', '10', course => {
    course.topic = { category: 'science', difficulty: 'intermediate' };
  });
  await coursePackage(root, 'paper-glider', '2');
  const result = await loadTopicContent(root);

  assert.deepEqual(result.courses.map(course => course.version), ['2', '10']);
  assert.deepEqual(result.courses[0].topic, { category: 'life', difficulty: 'starter' });
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].title, 'Paper glider 10');
  assert.equal(result.cards[0].category, 'science');
  assert.equal(result.cards[0].difficulty, 'intermediate');
  const firstPage = result.courses[1].pages[0];
  assert.equal(result.cards[0].coverImage, firstPage.image);
  assert.equal(result.cards[0].preview.width, firstPage.width);
  assert.equal(result.cards[0].preview.passage, result.courses[1].steps[0].reading?.passage);
});

test('rejects collisions, invalid references, and symlinked package directories', async t => {
  const { root } = await fixture(t);

  const reserved = await coursePackage(root, 'topic-robot', '2');
  await assert.rejects(loadTopicContent(root), /reserved/i);
  await rm(reserved, { recursive: true });

  const invalid = await coursePackage(root, 'paper-glider', '1', course => {
    course.steps[0].targetId = 'missing';
  });
  await assert.rejects(loadTopicContent(root), /steps\.0\.targetId/);
  await rm(invalid, { recursive: true });

  await symlink(example, join(root, 'paper-glider', '1'), 'dir');
  await assert.rejects(loadTopicContent(root), /directory|symbolic/i);
});

test('rejects active or external SVG features inside a published package', async t => {
  const { root } = await fixture(t);
  const folder = await coursePackage(root, 'paper-glider', '1');
  const file = join(folder, 'assets', 'look-at-the-glider.svg');
  const svg = await readFile(file, 'utf8');
  await writeFile(file, svg.replace('</svg>', '<foreignObject width="1" height="1"/></svg>'));
  await assert.rejects(loadTopicContent(root), /passive SVG/);
  await writeFile(file, svg.replace('</svg>', '<rect fill="url(https://example.test/a)" width="1" height="1"/></svg>'));
  await assert.rejects(loadTopicContent(root), /passive SVG/);
});
