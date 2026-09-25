import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';
import { eq } from 'drizzle-orm';
import { posts } from '../../db/schema/posts';

/**
 * The profile-design post counts, against REAL ROWS.
 *
 * The previous version stubbed `Post.countDocuments` and asserted the three
 * FILTER OBJECTS the route passed. That could not distinguish a correct
 * predicate from one matching nothing (every count reads zero, which looks like
 * a new account) — and it could not have caught the change that actually
 * mattered here: the reply/root split now reads the STORED `is_reply`
 * discriminator instead of `parent_post_id IS NULL`, because `ON DELETE SET
 * NULL` clears a parent link without making the reply a root post.
 *
 * The three guarantees, each failing in its own direction: a root counts once as
 * a post and never as a reply, a boost counts as a boost, and nothing private or
 * unpublished is counted at all.
 */
const { findOne } = vi.hoisted(() => ({ findOne: vi.fn() }));

// Keep the runtime-client seam deterministic while importing the route in
// isolation. No live Oxy client should be constructed by this unit test.
vi.mock('../../runtime/oxyClient', () => ({ getRuntimeOxyClient: () => ({}) }));

// Mock privacyHelpers directly: this route test only needs the visibility
// contract, not the helper's Oxy graph dependencies. The two exports the route
// uses are reproduced faithfully; the gate resolves to "visible" so the counts
// below are what the assertions are actually about. The gate's own behaviour is
// covered by `profileDesignVisibilityParity.test.ts`.
vi.mock('../../utils/privacyHelpers', () => ({
  ProfileVisibility: {
    PUBLIC: 'public',
    PRIVATE: 'private',
    FOLLOWERS_ONLY: 'followers_only',
  },
  canViewProfileDesign: vi.fn().mockResolvedValue(true),
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { deletePostRecord, insertPostRecord } from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { deleteActorsByUris, setActorOxyUserId, upsertActor } from '../../db/federation/actorRepository';
import profileDesignRoutes from '../../routes/profileDesign';
import { accountErasures } from '../../db/schema/accountErasures';
import { recordAccountErasureRequest } from '../../db/accountErasures/accountErasureRepository';

const app = express();
app.use('/profile/design', profileDesignRoutes);

const AUTHOR = 'user-1';
const OTHER = 'user-2';
const created: string[] = [];

async function seed(overrides: Partial<PostRecordInput> = {}): Promise<string> {
  const owner = overrides.oxyUserId ?? AUTHOR;
  const record = await insertPostRecord({
    oxyUserId: owner,
    authorship: [{ oxyUserId: owner as string, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'hello', tag: 'en' }] },
    ...overrides,
  });
  created.push(record.id);
  return record.id;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
});

afterEach(async () => {
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id, undefined);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('profile design public counts', () => {
  it('counts a collapsed cross-post once while retaining both source records', async () => {
    await seed();
    const sibling = await seed();
    await getDb().update(posts).set({ crosspostCollapsed: true }).where(eq(posts.id, sibling));
    const response = await request(app).get(`/profile/design/${AUTHOR}`).expect(200);
    expect(response.body.data.postsCount).toBe(1);
    expect(await getDb().select({ id: posts.id }).from(posts).where(eq(posts.id, sibling))).toHaveLength(1);
  });

  it('counts only published public posts, boosts, and replies of THIS author', async () => {
    const root = await seed();
    await seed({ parentPostId: root });
    await seed({ type: PostType.BOOST, boostOf: root, content: {} });
    // Excluded: not public, not published, or not this author.
    await seed({ visibility: PostVisibility.PRIVATE });
    await seed({ status: 'draft' });
    await seed({ oxyUserId: OTHER });

    const response = await request(app).get(`/profile/design/${AUTHOR}`).expect(200);

    // The root and the boost are both non-replies; the reply is counted once.
    expect(response.body.data.postsCount).toBe(2);
    expect(response.body.data.boostsCount).toBe(1);
    expect(response.body.data.repliesCount).toBe(1);
  });

  it('counts an ORPHANED reply as a reply, not as a top-level post', async () => {
    const parent = await seed();
    const reply = await seed({ parentPostId: parent });

    // Deleting the parent fires `ON DELETE SET NULL`, so the reply's parent link
    // is gone while `is_reply` stays true. A count keyed on `parent_post_id IS
    // NULL` would now report this reply as one of the author's top-level posts.
    await deletePostRecord(parent, undefined);
    created.splice(created.indexOf(parent), 1);

    const response = await request(app).get(`/profile/design/${AUTHOR}`).expect(200);

    expect(response.body.data.postsCount).toBe(0);
    expect(response.body.data.repliesCount).toBe(1);
    expect(created).toContain(reply);
  });
});

/**
 * A federated account's origin figures ride the same DTO (OxyHQ/Mention#1126):
 * the Oxy mirror's graph and `createdAt` start the day Mention discovered the
 * actor, so the page reads these instead — and must be able to tell a local
 * account (no `remote` at all) from an origin that did not report a figure (the
 * key absent), neither of which may render as `0`.
 */
describe('profile design remote stats', () => {
  const REMOTE_USER = 'remote-design-user';
  const domain = 'profile-design-remote.test';
  const uri = `https://${domain}/users/someone`;

  afterEach(async () => {
    await deleteActorsByUris([uri]);
  });

  async function seedActor(overrides: { followersUrl?: string; remoteCreatedAt?: Date } = {}) {
    const row = await upsertActor(
      uri,
      {
        protocol: 'activitypub',
        username: 'someone',
        domain,
        acct: `someone@${domain}`,
        summary: '',
        type: 'Person',
        manuallyApprovesFollowers: false,
        discoverable: true,
        memorial: false,
        suspended: false,
        followingUrl: `${uri}/following`,
        followersCount: 0,
        followingCount: 57,
        postsCount: 9,
        lastFetchedAt: new Date(),
        ...overrides,
      },
      [],
    );
    await setActorOxyUserId(row!.id, REMOTE_USER);
  }

  it('serves the origin totals and published date for a federated account', async () => {
    await seedActor({
      followersUrl: `${uri}/followers`,
      remoteCreatedAt: new Date('2022-11-05T00:00:00.000Z'),
    });

    const response = await request(app).get(`/profile/design/${REMOTE_USER}`).expect(200);

    expect(response.body.data.remote).toEqual({
      followersCount: 0,
      followingCount: 57,
      joinedAt: '2022-11-05T00:00:00.000Z',
    });
  });

  it('omits what the origin did not report', async () => {
    await seedActor();

    const response = await request(app).get(`/profile/design/${REMOTE_USER}`).expect(200);

    expect(response.body.data.remote).toEqual({ followingCount: 57 });
  });

  it('carries no remote block for a local account', async () => {
    const response = await request(app).get(`/profile/design/${AUTHOR}`).expect(200);

    expect(response.body.data).not.toHaveProperty('remote');
  });
});

describe('GET /profile/design/:userId for an erased account (OxyHQ/Mention#1169)', () => {
  const ERASED = 'profile-design-erased-user';

  afterEach(async () => {
    await getDb().delete(accountErasures).where(eq(accountErasures.oxyUserId, ERASED));
  });

  it('answers 404 once Oxy has told Mention the account was deleted, and 200 for everyone else', async () => {
    // Before: any id answers 200 with a default design, which is what the issue saw.
    await request(app).get(`/profile/design/${ERASED}`).expect(200);

    await recordAccountErasureRequest({
      eventId: `${ERASED}-event`,
      oxyUserId: ERASED,
      source: 'webhook',
      reason: 'account.deleted',
      occurredAt: new Date(),
      retained: false,
      username: null,
    });

    await request(app).get(`/profile/design/${ERASED}`).expect(404);
    await request(app).get(`/profile/design/${AUTHOR}`).expect(200);
  });
});
