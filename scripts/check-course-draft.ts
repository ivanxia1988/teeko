import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkCourseDraft } from '../lib/server/course-package';

export { checkCourseDraft } from '../lib/server/course-package';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [folder] = process.argv.slice(2);
  if (!folder || process.argv.length !== 3) {
    console.error('Usage: npm run courses:check -- <course-package-directory>');
    process.exitCode = 1;
  } else {
    const errors = await checkCourseDraft(folder);
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log('Course package passed the format, reference and local asset checks.');
    }
  }
}
