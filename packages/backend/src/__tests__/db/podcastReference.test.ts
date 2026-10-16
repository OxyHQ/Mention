import { beforeAll, afterAll, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { connectPostgres, closePostgres, getDb } from '../../db/postgres';
import {
  insertPostRecord,
  loadPostRecord,
  replacePostContent,
  deletePostRecord,
} from '../../db/posts/postRepository';
import { sanitizePodcast } from '../../utils/podcastReference';
import { toStoredContent } from '../../services/postVariants';

beforeAll(async () => {
  await connectPostgres();
});
afterAll(closePostgres);
const legacy = {
  syraPodcastId: 'show-1',
  title: 'Stale',
  author: 'Host',
  artworkUrl: 'https://old.invalid/art',
  showUrl: 'https://old.invalid',
  episode: { title: 'Old episode', videoUrl: 'https://old.invalid/video' },
};
it('projects input, variants, repository insert and replacement to the opaque reference', async () => {
  expect(sanitizePodcast(legacy)).toEqual({ syraPodcastId: 'show-1' });
  expect(toStoredContent({ text: 'hello', podcast: legacy }, 'en').podcast).toEqual({
    syraPodcastId: 'show-1',
  });
  const post = await insertPostRecord({
    oxyUserId: 'podcast-ref-test',
    authorship: [{ oxyUserId: 'podcast-ref-test', role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { podcast: legacy },
  });
  try {
    expect((await loadPostRecord(post.id))?.content.podcast).toEqual({ syraPodcastId: 'show-1' });
    await getDb().transaction(async (tx) => {
      const nextPodcast = { ...legacy, syraPodcastId: 'show-2' };
      await replacePostContent(post.id, { podcast: nextPodcast }, [], tx);
    });
    expect((await loadPostRecord(post.id))?.content.podcast).toEqual({ syraPodcastId: 'show-2' });
    const [row] = await getDb().execute(
      sql`select content_podcast_title, content_podcast_author, content_podcast_artwork_url, content_podcast_show_url from posts where id = ${post.id}`,
    );
    expect(row).toEqual({
      content_podcast_title: null,
      content_podcast_author: null,
      content_podcast_artwork_url: null,
      content_podcast_show_url: null,
    });
  } finally {
    await deletePostRecord(post.id, undefined);
  }
});
