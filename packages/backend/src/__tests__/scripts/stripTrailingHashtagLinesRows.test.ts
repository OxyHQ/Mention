/**
 * `stripTrailingHashtagLines` against REAL ROWS. The text rule is pinned in
 * `textProcessing.test.ts`; this pins what the sweep writes and what it must
 * leave alone: every real tag in the `hashtags` column and the edited flag.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { insertPostRecord, loadPostRecords } from '../../db/posts/postRepository';
import {
  stripTrailingHashtagLines,
  truncatedHashtagFragments,
} from '../../scripts/stripTrailingHashtagLines';

const OWNER = 'strip-trailing-hashtags-owner';
const created: string[] = [];

async function seed(body: string, hashtags: string[]): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: OWNER,
    authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: body }] },
    hashtags,
  });
  created.push(record.id);
  return record.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  if (created.length > 0) {
    await getDb()
      .delete(posts)
      .where(inArray(posts.id, [...created]));
    created.length = 0;
  }
});

describe('stripTrailingHashtagLines', () => {
  it('cleans trailing hashtag lines only, keeps the tags, and is idempotent', async () => {
    const trailing = await seed('Read this https://example.com/a\n\n#Apple', ['apple', 'news']);
    const inline = await seed('I love #Apple', ['apple']);
    // The shape of /p/6a3a324868a43bdaaff95eb1: a stray `g` the pre-unicode
    // extractor cut from `#Göttingen`, beside the remote's folded `gottingen`.
    const fragment = await seed('Bericht https://taz.de/a/!6189698/\n\n#Göttingen #Antifa', [
      'gottingen',
      'antifa',
      'g',
    ]);
    const sleep = async () => {};

    const dry = await stripTrailingHashtagLines({ dryRun: true, sleep });
    expect(dry.changed).toBe(2);
    expect(dry.fragmentPosts).toBe(1);
    expect(dry.written).toBe(0);

    const live = await stripTrailingHashtagLines({ dryRun: false, sleep });
    expect(live.written).toBe(2);
    expect(live.fragmentPostsWritten).toBe(1);

    const [cleaned, untouched] = await loadPostRecords([trailing, inline]).then((records) =>
      [trailing, inline].map((id) => records.find((record) => record.id === id)),
    );
    expect(cleaned?.content.variants?.[0]?.text).toBe('Read this https://example.com/a');
    expect(cleaned?.hashtags).toEqual(['apple', 'news']);
    expect(cleaned?.isEdited).toBe(false);
    expect(untouched?.content.variants?.[0]?.text).toBe('I love #Apple');
    const [repaired] = await loadPostRecords([fragment]);
    expect(repaired?.content.variants?.[0]?.text).toBe('Bericht https://taz.de/a/!6189698/');
    expect(repaired?.hashtags).toEqual(['gottingen', 'antifa']);

    const again = await stripTrailingHashtagLines({ dryRun: false, sleep });
    expect(again.changed).toBe(0);
  });

  it('names only an ASCII prefix cut from a tag the text holds whole', () => {
    expect(truncatedHashtagFragments('#Göttingen', ['gottingen', 'g'])).toEqual(['g']);
    // `#G` is a tag of its own here, so `g` is not a fragment.
    expect(truncatedHashtagFragments('#G and #Göttingen', ['g'])).toEqual([]);
  });
});
