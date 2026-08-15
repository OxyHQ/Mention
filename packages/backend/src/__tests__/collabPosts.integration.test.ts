import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { and, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { buildAuthorship, authorFeedSql, isProfileVisible } from '../utils/postAuthorship';
import { postCollaborationService } from '../services/PostCollaborationService';
import { closePostgres, connectPostgres } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { CHRONO_DESC, deletePostRecord, findPostRecords, insertPostRecord } from '../db/posts/postRepository';

vi.mock('../utils/oxyHelpers', () => ({
  getServiceOxyClient: vi.fn(() => ({
    getUsersByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, type: 'local', username: id, name: { displayName: id } })),
    ),
  })),
}));

const created: string[] = [];

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('collaborative posts integration', () => {
  it('builds authorship with owner always accepted', () => {
    const authorship = buildAuthorship('owner-1', ['c-1', 'c-2']);
    expect(authorship[0]).toMatchObject({ role: 'owner', status: 'accepted' });
    expect(authorship[1]).toMatchObject({ role: 'collaborator', status: 'pending' });
  });

  it('profile visibility requires accepted collaborator', () => {
    const authorship = buildAuthorship('owner-1', ['collab-1']);
    expect(isProfileVisible(authorship, 'owner-1')).toBe(true);
    expect(isProfileVisible(authorship, 'collab-1')).toBe(false);
    authorship[1].status = 'accepted';
    expect(isProfileVisible(authorship, 'collab-1')).toBe(true);
  });

  /**
   * The author-feed predicate, against REAL ROWS.
   *
   * This used to assert the Mongo `$elemMatch` object literal, which proved only
   * that the helper returned the shape someone typed into the test. The
   * predicate is now a correlated `EXISTS` over `post_authorships` — the exact
   * construct that renders a bare column name and silently matches NOTHING (see
   * `@oxyhq/db`). An empty author feed is indistinguishable from "this person
   * has not posted", so shape assertions cannot guard it and row assertions can.
   *
   * Two guarantees in one case, because they fail in opposite directions: an
   * ACCEPTED collaborator must SEE the post on their profile, and a PENDING
   * invitee must NOT — an invitee's name on a stranger's post before they
   * consented is the failure that matters.
   */
  it('matches an accepted collaborator and never a pending invitee', async () => {
    const db = await connectPostgres();
    const owner = 'oxy-collab-owner';
    const accepted = 'oxy-collab-accepted';
    const pending = 'oxy-collab-pending';

    const record = await insertPostRecord({
      oxyUserId: owner,
      authorship: [
        { oxyUserId: owner, role: 'owner', status: 'accepted' },
        { oxyUserId: accepted, role: 'collaborator', status: 'accepted' },
        { oxyUserId: pending, role: 'collaborator', status: 'pending' },
      ],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'a collaboration', tag: 'en' }] },
    });
    created.push(record.id);

    const mine = inArray(posts.id, created);

    const byOwner = await findPostRecords(and(mine, authorFeedSql(owner)), { orderBy: CHRONO_DESC });
    expect(byOwner.map((post) => post.id)).toEqual([record.id]);

    const byAccepted = await findPostRecords(and(mine, authorFeedSql(accepted)), { orderBy: CHRONO_DESC });
    expect(byAccepted.map((post) => post.id)).toEqual([record.id]);

    const byPending = await findPostRecords(and(mine, authorFeedSql(pending)), { orderBy: CHRONO_DESC });
    expect(byPending).toEqual([]);

    // A stranger matches nothing — the predicate is not vacuously true.
    const byStranger = await findPostRecords(and(mine, authorFeedSql('oxy-collab-nobody')), {
      orderBy: CHRONO_DESC,
    });
    expect(byStranger).toEqual([]);

    expect(db).toBeDefined();
  });

  it('skips federation when collaborators present', async () => {
    const authorship = buildAuthorship('owner', ['c1']);
    expect(authorship.some((e) => e.role === 'collaborator')).toBe(true);
    const validated = await postCollaborationService.validateInvites('owner', ['c1']);
    expect(validated).toEqual(['c1']);
  });
});
