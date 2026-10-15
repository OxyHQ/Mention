import { beforeAll, afterAll, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
it('migration removes existing snapshots, keeps references and rejects copies from old-image writers without breaking writes', async () => {
  const migration = readFileSync(
    join(__dirname, '../../..', 'drizzle/0069_podcast_reference_only.sql'),
    'utf8',
  );
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`create schema podcast_migration_test`);
    await tx.execute(sql`set local search_path to podcast_migration_test`);
    await tx.execute(
      sql`create table posts (id text primary key, content_podcast_syra_id text, content_podcast_title text, content_podcast_author text, content_podcast_artwork_url text, content_podcast_show_url text)`,
    );
    await tx.execute(
      sql`insert into posts values ('old', 'show-1', 'old title', 'old author', 'old artwork', 'old url')`,
    );
    for (const statement of migration.split('--> statement-breakpoint'))
      await tx.execute(sql.raw(statement));
    await tx.execute(
      sql`insert into posts values ('rolling-old-writer', 'show-2', 'copied', 'copied', 'copied', 'copied')`,
    );
    await tx.execute(sql`update posts set content_podcast_title = 'copied again' where id = 'old'`);
    const rows = await tx.execute(sql`select * from posts order by id`);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.content_podcast_syra_id)).toEqual(['show-1', 'show-2']);
    for (const row of rows)
      expect([
        row.content_podcast_title,
        row.content_podcast_author,
        row.content_podcast_artwork_url,
        row.content_podcast_show_url,
      ]).toEqual([null, null, null, null]);
    await tx.execute(sql`drop schema podcast_migration_test cascade`);
  });
});
