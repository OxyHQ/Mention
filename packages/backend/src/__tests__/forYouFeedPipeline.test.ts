/**
 * The `popular` SOURCE module — For You's anonymous + never-blank fallback —
 * against a real database.
 *
 * Its one contract is that sensitive/NSFW content NEVER reaches it, whatever
 * the viewer's `showSensitiveContent` says: this is the page an anonymous
 * visitor and a starved personalized feed both land on, and neither has opted
 * in to anything. The old suite asserted the SHAPE of a Mongo `$match` object,
 * which could not tell a correct predicate from one Postgres would evaluate
 * differently — and `sensitiveExcludeSql` is exactly where the literal
 * translation is wrong (`<> true` drops every NULL row). So the assertion here
 * is on ROWS.
 *
 * Each sensitive fixture carries MORE engagement than the clean one, so if the
 * gate ever stopped firing they would sort ABOVE it rather than merely appear —
 * and the clean post's presence is the vacuity floor proving the scan reached
 * these rows at all.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import { uuidv7 } from '@oxyhq/db';
import { popularSource } from '../mtn/feed/engine/sources/discoverySources';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

let db: Database;

const AUTHOR = 'oxy-popular-author';
/** Well above any page this suite asks for, so ordering can never be the reason a row is absent. */
const CAP = 500;

function baseInput(overrides: Partial<PostRecordInput> = {}): PostRecordInput {
  return {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'popular fixture body', tag: 'en' }] },
    createdAt: new Date(),
    ...overrides,
  };
}

/** Create a post and give it `likes` engagement (stats are DB-owned, not writer-supplied). */
async function create(likes: number, overrides: Partial<PostRecordInput> = {}): Promise<string> {
  const record = await insertPostRecord(baseInput(overrides));
  await db.update(posts).set({ statsLikesCount: likes }).where(eq(posts.id, record.id));
  return record.id;
}

function gather(ctx: FeedEngineContext) {
  return popularSource.gather({ ...ctx, pageLimit: CAP }, {}, CAP);
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  await db.delete(posts).where(eq(posts.oxyUserId, AUTHOR));
});

afterAll(async () => {
  await closePostgres();
});

/** The four independent ways a post is sensitive, each as its own fixture. */
async function seedSensitiveSet(): Promise<{ clean: string; sensitive: Record<string, string> }> {
  const clean = await create(50, { hashtags: ['tech'] });
  const sensitive = {
    nsfwHashtag: await create(100, { hashtags: ['nsfw'] }),
    classifier: await create(100, { postClassification: { sensitive: true } }),
    metadata: await create(100, { metadata: { isSensitive: true } }),
    federation: await create(100, {
      federation: {
        activityId: `https://remote.example/notes/${uuidv7()}`,
        actorUri: 'https://remote.example/users/bob',
        sensitive: true,
      },
    }),
  };
  return { clean, sensitive };
}

describe('popular source — SFW (default / anonymous)', () => {
  it('excludes every flavour of sensitive for the anonymous path', async () => {
    const { clean, sensitive } = await seedSensitiveSet();

    const ids = (await gather({ currentUserId: undefined })).map((post) => post.id);

    expect(ids).toContain(clean);
    for (const [flavour, id] of Object.entries(sensitive)) {
      expect(ids, `sensitive via ${flavour} reached the popular page`).not.toContain(id);
    }
  });

  it('defaults to SFW when showSensitiveContent is absent (authed never-blank)', async () => {
    const { clean, sensitive } = await seedSensitiveSet();

    const ids = (await gather({ currentUserId: 'viewer' })).map((post) => post.id);

    expect(ids).toContain(clean);
    expect(ids).not.toContain(sensitive.nsfwHashtag);
    expect(ids).not.toContain(sensitive.classifier);
  });

  it('serves only published public posts', async () => {
    const published = await create(50);
    const draft = await create(100, { status: 'draft' });
    const privatePost = await create(100, { visibility: PostVisibility.PRIVATE });

    const ids = (await gather({ currentUserId: undefined })).map((post) => post.id);

    expect(ids).toContain(published);
    expect(ids).not.toContain(draft);
    expect(ids).not.toContain(privatePost);
  });
});

describe('popular source — hard SFW (ignores showSensitiveContent)', () => {
  it('still excludes every flavour of sensitive when the viewer opted in', async () => {
    // The viewer opt-in governs the RANKED feeds. This source backs the
    // anonymous page and the never-blank fallback, where nobody has consented
    // to anything, so it stays hard-SFW.
    const { clean, sensitive } = await seedSensitiveSet();

    const ids = (await gather({ currentUserId: 'viewer', showSensitiveContent: true })).map(
      (post) => post.id,
    );

    expect(ids).toContain(clean);
    for (const [flavour, id] of Object.entries(sensitive)) {
      expect(ids, `sensitive via ${flavour} reached an opted-in popular page`).not.toContain(id);
    }
  });
});

describe('popular source — the viewer never sees the same page twice', () => {
  it('excludes the ids the viewer has already been shown', async () => {
    const seen = await create(100);
    const unseen = await create(50);

    const ids = (await gather({ currentUserId: 'viewer', seenPostIds: [seen] })).map(
      (post) => post.id,
    );

    expect(ids).toContain(unseen);
    expect(ids).not.toContain(seen);
  });
});
