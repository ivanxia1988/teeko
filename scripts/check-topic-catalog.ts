import {bundledTopicContent} from '../lib/server/topic-content';

try {
  const {cards,courses}=await bundledTopicContent();
  console.log(`Checked ${courses.length} course package versions for ${cards.length} topics.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to read course packages.');
  process.exitCode=1;
}
