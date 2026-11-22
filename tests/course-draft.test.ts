import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { PublishedCourse } from '../lib/classroom-contract';
import { checkCourseDraft } from '../scripts/check-course-draft';

const example = new URL('../courses/drafts/paper-glider/1/', import.meta.url);

async function editDraft(t: TestContext, edit: (course: PublishedCourse) => void) {
  const root = await mkdtemp(join(tmpdir(), 'teeko-course-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'paper-glider', '1');
  await cp(example, folder, { recursive: true });
  const manifest = join(folder, 'course.json');
  const course = JSON.parse(await readFile(manifest, 'utf8')) as PublishedCourse;
  edit(course);
  await writeFile(manifest, JSON.stringify(course));
  return folder;
}

test('the two-page course draft uses the existing classroom format', async () => {
  assert.deepEqual(await checkCourseDraft(example), []);
});

test('a teaching target must be on the activity page', async t => {
  const folder = await editDraft(t, course => {
    course.steps[0].targetId = course.pages[1].objects[0].id;
  });
  assert.match((await checkCourseDraft(folder)).join('\n'), /steps\.0\.targetId/);
});

test('checks duplicate element IDs and boxes outside the page', async t => {
  const folder = await editDraft(t, course => {
    const [object] = course.pages[0].objects;
    object.box.x = 1;
    course.pages[0].objects.push({ ...object });
  });
  const errors = (await checkCourseDraft(folder)).join('\n');
  assert.match(errors, /pages\.0\.objects\.0\.box/);
  assert.match(errors, /pages\.0\.objects\.\d+\.id/);
});

test('checks draft asset references without loading a remote image', async t => {
  const folder = await editDraft(t, course => {
    course.pages[0].image = 'https://example.com/glider.svg';
  });
  await unlink(join(folder, 'assets', 'test-flight.svg'));
  const errors = (await checkCourseDraft(folder)).join('\n');
  assert.match(errors, /pages\.0\.image/);
  assert.match(errors, /pages\.1\.image/);
});

test('checks course paths and rejects student selection in voice-only lessons', async t => {
  const folder = await editDraft(t, course => {
    course.id = 'different-topic';
    course.steps[0].kind = 'select';
  });
  const errors = (await checkCourseDraft(folder)).join('\n');
  assert.match(errors, /\bid\b/);
  assert.match(errors, /steps\.0\.kind/);
});

test('checks reading text that would otherwise be cut off during teaching', async t => {
  const folder = await editDraft(t, course => {
    course.steps[0].reading!.passage = 'a'.repeat(501);
  });
  assert.match((await checkCourseDraft(folder)).join('\n'), /steps\.0\.reading\.passage/);
});
