/**
 * THE SHARED EDITORIAL QUEUE — `GET /posts/scheduled` for a channel's members.
 *
 * Several people publish under one channel's byline, so a queue only one of them
 * can see is a queue two of them schedule into for the same Tuesday. This suite
 * pins the two questions that feature turns on, and they have DIFFERENT answers:
 *
 *  - **Who may see the queue** — an ACTIVE member of the channel, and nobody
 *    else. Answered by the one gate the write routes already use, never by a
 *    second membership reader.
 *  - **Who may see WHO QUEUED each entry** — exactly whoever the published post
 *    would have named, which is `channel.signPosts`' decision and no new one.
 *    A member of a channel that does not sign learns WHAT is queued and WHEN,
 *    and nothing about the person who queued it.
 *
 * The second is the one that is easy to get wrong by accident, because the
 * obvious implementation ("show the team who scheduled what") reads as helpful
 * and quietly ends the anonymity of every channel that never opted in. It is
 * also the direction that cannot be walked back: a name shown to colleagues has
 * been shown.
 *
 * ## Everything Mention owns is REAL here
 *
 * The posts, the `user_settings` row carrying the consent flag, the query, the
 * hydration ACL and the byline are all real; `listOperatedChannelIds` runs for
 * real over a stubbed account forest, so the membership PREDICATE
 * (`membershipAuthorizesActingFor`) is exercised rather than assumed. Only Oxy —
 * a remote service — is mocked.
 *
 * That division matters for a consent gate. Stubbing the settings read would
 * make the disclosure cases a test of the stub: the gate asks `user_settings` a
 * question, and a mock answers it whether or not the query would have found the
 * row — and "found nothing" is exactly what a broken consent read looks like
 * from outside, while reading as ANONYMOUS and therefore passing.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountMember, AccountNode, User } from '@oxyhq/core';
import type { CachedUserSummary } from '../../services/userSummaryCache';

const { getUsersByIds, cacheStore, listAccounts, listAccountMembers, claim } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  cacheStore: new Map<string, CachedUserSummary>(),
  listAccounts: vi.fn(),
  listAccountMembers: vi.fn(),
  claim: vi.fn(),
}));

// The publish PIPELINE (MTN record, federation fan-out, notifications) is the
// subject of its own suites; what matters here is WHO may start it and WHICH
// account it is claimed for, so the claim is observed rather than executed.
vi.mock('../../services/PostCreationService', () => ({
  postCreationService: { claimAndPublishScheduledPost: claim },
}));

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

// Oxy owns identity and the account graph, and is a remote service, so it stays
// mocked. Everything Mention stores is real.
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById: vi.fn(),
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds,
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
  // Hydration falls back to the service client when this is undefined, which is
  // what keeps the identity batch on one stub.
  createScopedOxyClient: () => undefined,
  // The caller's own Oxy client. It carries BOTH account reads, because the two
  // halves of this feature ask different questions of the account graph and a
  // stub offering only one silently turns the other's refusals into 503s:
  //
  //  - `listAccounts` (the caller's forest) answers `listOperatedChannelIds`,
  //    which is how the READ decides which queues to merge in;
  //  - `listAccountMembers` (one account's roster) answers
  //    `assertCanPublishAsAccount` behind `postManagementRefusal`, which is how
  //    every WRITE decides.
  //
  // Both are derived from ONE fixture below, so the test cannot accidentally
  // describe someone who reads a queue they may not act on, or the reverse.
  createUserScopedOxyServices: (req: { user?: { id?: string } }) => ({
    listAccounts: async () => listAccounts(req.user?.id),
    listAccountMembers: async (accountId: string) => listAccountMembers(accountId),
  }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async (ids: string[]) => {
    const hits = new Map<string, CachedUserSummary>();
    for (const id of ids) {
      const hit = cacheStore.get(id);
      if (hit) hits.set(id, hit);
    }
    return hits;
  }),
  mset: vi.fn(async (entries: Map<string, CachedUserSummary>) => {
    for (const [id, value] of entries) cacheStore.set(id, value);
  }),
}));

import { eq } from 'drizzle-orm';
import type { HydratedPost } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { userSettings } from '../../db/schema/userProfile';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { PostHydrationService } from '../../services/PostHydrationService';
import { getScheduledPosts, publishScheduledPostNow } from '../../controllers/posts.controller';
import { loadPostRecord } from '../../db/posts/postRepository';

const scope = serviceScope('channel-editorial-queue');
const CHANNEL = scope.user('channel');
/** The member who wrote the queued post. */
const WRITER = scope.user('writer');
/** A second member of the same channel, who wrote nothing. */
const COLLEAGUE = scope.user('colleague');
/** Not a member of anything. */
const OUTSIDER = scope.user('outsider');
/** A member whose invitation has not been accepted. */
const INVITEE = scope.user('invitee');
/** An account the caller operates that is NOT a channel. */
const ORGANIZATION = scope.user('organization');

const OPERATOR_PERMISSIONS = ['account:read', 'account:update', 'account:act_as', 'members:read'];

function membership(
  accountId: string,
  memberUserId: string,
  status: AccountMember['status'] = 'active',
): AccountMember {
  return {
    _id: `member-${accountId}-${memberUserId}`,
    accountId,
    memberUserId,
    role: 'owner',
    permissions: OPERATOR_PERMISSIONS,
    inherit: true,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A whole `User`, so no field has to be asserted into existence. */
function account(accountId: string): User {
  return {
    id: accountId,
    publicKey: `pk-${accountId}`,
    username: accountId,
    name: { displayName: accountId },
  };
}

function node(
  accountId: string,
  kind: AccountNode['kind'],
  callerMembership: AccountMember | null,
): AccountNode {
  return {
    accountId,
    kind,
    parentAccountId: null,
    account: account(accountId),
    relationship: callerMembership ? 'member' : 'self',
    callerMembership,
  };
}

/**
 * THE ONE ROSTER both account reads are derived from.
 *
 * WRITER and COLLEAGUE are active members of the channel; INVITEE has been asked
 * and has not accepted. Deriving the forest AND the member list from this single
 * fixture is what stops the suite describing an impossible person — someone the
 * read admits and the write refuses, or the reverse — which is exactly the
 * inconsistency this change exists to remove.
 */
const CHANNEL_ROSTER: ReadonlyArray<{ member: string; status: AccountMember['status'] }> = [
  { member: WRITER, status: 'active' },
  { member: COLLEAGUE, status: 'active' },
  { member: INVITEE, status: 'invited' },
];

function membersOf(accountId: string): AccountMember[] {
  if (accountId === CHANNEL) {
    return CHANNEL_ROSTER.map((row) => membership(CHANNEL, row.member, row.status));
  }
  if (accountId === ORGANIZATION) {
    return [membership(ORGANIZATION, WRITER), membership(ORGANIZATION, COLLEAGUE)];
  }
  return [];
}

/**
 * What Oxy answers about one viewer's forest — the same roster, seen from the
 * caller's side.
 *
 * The INVITEE is the discriminating fixture for the membership predicate: the
 * channel IS in their forest, so a check that merely asked "is this account
 * reachable" would admit them. Only the `status === 'active'` clause keeps them
 * out. The ORGANIZATION is the same for the KIND clause — the caller may
 * genuinely act for it, so only the `kind === 'channel'` filter excludes it.
 */
function forestFor(viewerId: string | undefined): AccountNode[] {
  const own = node(viewerId ?? '', 'personal', null);
  const channelRow = CHANNEL_ROSTER.find((row) => row.member === viewerId);
  if (!channelRow) return [own];
  const forest = [own, node(CHANNEL, 'channel', membership(CHANNEL, viewerId ?? '', channelRow.status))];
  if (channelRow.status === 'active') {
    forest.push(node(ORGANIZATION, 'organization', membership(ORGANIZATION, viewerId ?? '')));
  }
  return forest;
}

const IDENTITIES: Record<string, { kind: string }> = {
  [CHANNEL]: { kind: 'channel' },
  [WRITER]: { kind: 'personal' },
  [COLLEAGUE]: { kind: 'personal' },
  [OUTSIDER]: { kind: 'personal' },
  [INVITEE]: { kind: 'personal' },
  [ORGANIZATION]: { kind: 'organization' },
};

function later(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

/** One scheduled post owned by `owner`, optionally written by a human. */
async function seedScheduled(options: {
  owner: string;
  writtenBy?: string;
  inMinutes?: number;
  text?: string;
}): Promise<string> {
  const record = await seedPost(scope, {
    oxyUserId: options.owner,
    authorship: [{ oxyUserId: options.owner, role: 'owner', status: 'accepted' }],
    ...(options.writtenBy ? { writtenByOxyUserId: options.writtenBy } : {}),
    status: 'scheduled',
    scheduledFor: later(options.inMinutes ?? 60),
    content: { variants: [{ source: 'author', text: options.text ?? 'a queued story', tag: 'en' }] },
  });
  return record.id;
}

/** Turn a channel's writer disclosure on, off, or to a hostile value. */
async function setSignPosts(value: boolean | null): Promise<void> {
  await getDb()
    .insert(userSettings)
    .values({ oxyUserId: CHANNEL, channelAccountSignPosts: value })
    .onConflictDoUpdate({
      target: userSettings.oxyUserId,
      set: { channelAccountSignPosts: value },
    });
}

function buildRequest(viewerId?: string) {
  return {
    params: {},
    query: {},
    headers: {},
    acceptsLanguages: () => [] as string[],
    ...(viewerId ? { user: { id: viewerId } } : {}),
  };
}

interface Captured {
  status?: number;
  body?: { posts?: HydratedPost[]; message?: string };
}

function buildResponse(): { res: unknown; captured: Captured } {
  const captured: Captured = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: Captured['body']) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

/** Drive the real handler and answer with the hydrated page. */
async function fetchQueue(viewerId?: string): Promise<Captured> {
  const { res, captured } = buildResponse();
  await getScheduledPosts(buildRequest(viewerId) as never, res as never);
  return captured;
}

function idsOf(captured: Captured): string[] {
  return (captured.body?.posts ?? []).map((post) => post.id);
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  cacheStore.clear();
  getUsersByIds.mockReset();
  listAccounts.mockReset();
  claim.mockReset();
  listAccountMembers.mockReset();
  listAccounts.mockImplementation(async (viewerId: string | undefined) => forestFor(viewerId));
  listAccountMembers.mockImplementation(async (accountId: string) => membersOf(accountId));
  getUsersByIds.mockImplementation(async (ids: string[]) =>
    ids
      .filter((id) => IDENTITIES[id])
      .map((id) => ({
        id,
        username: id,
        name: { displayName: id },
        kind: IDENTITIES[id].kind,
        verified: false,
      })),
  );
});

afterEach(async () => {
  await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, CHANNEL));
  await clearServiceScope(scope);
});

describe('the shared editorial queue — who may READ it', () => {
  it('gives a member the channel’s queue alongside their own posts', async () => {
    const channelEntry = await seedScheduled({ owner: CHANNEL, writtenBy: WRITER, inMinutes: 30 });
    const ownEntry = await seedScheduled({ owner: COLLEAGUE, inMinutes: 90 });

    const page = await fetchQueue(COLLEAGUE);

    // Soonest first, and the channel's entry is there even though COLLEAGUE did
    // not write it — that is the whole feature.
    expect(idsOf(page)).toEqual([channelEntry, ownEntry]);
  });

  it('names the CHANNEL as the author, so the client knows whose queue an entry is in', async () => {
    await seedScheduled({ owner: CHANNEL, writtenBy: WRITER });

    const page = await fetchQueue(COLLEAGUE);

    // No separate `channel` field and no parallel notion of "queue": the post
    // says which account it belongs to, because the channel IS its author.
    expect(page.body?.posts?.[0]?.user.id).toBe(CHANNEL);
  });

  it('gives the WRITER their own channel post back', async () => {
    // The bug this feature had to fix first, and it is not a narrow one. A
    // channel AUTHORS its post, so `oxy_user_id` is an account nobody can sign in
    // as — and the owner-scoped read returned this post to NOBODY, including the
    // person who scheduled it. It could only ever leave the queue via the sweep.
    const entry = await seedScheduled({ owner: CHANNEL, writtenBy: WRITER });

    expect(idsOf(await fetchQueue(WRITER))).toEqual([entry]);
  });

  it('gives an OUTSIDER nothing of the channel’s', async () => {
    await seedScheduled({ owner: CHANNEL, writtenBy: WRITER });
    const ownEntry = await seedScheduled({ owner: OUTSIDER });

    const page = await fetchQueue(OUTSIDER);

    expect(idsOf(page)).toEqual([ownEntry]);
  });

  it('refuses a member whose invitation is not yet ACCEPTED', async () => {
    // The discriminating fixture for the membership predicate: the channel IS in
    // this caller's forest, so anything that merely asked "can you reach this
    // account" would admit them. Only `status === 'active'` keeps them out.
    await seedScheduled({ owner: CHANNEL, writtenBy: WRITER });

    expect(idsOf(await fetchQueue(INVITEE))).toEqual([]);
  });

  it('does NOT fold in an organization the caller may act for', async () => {
    // The kind clause on its own. A channel's queue is shared because a channel
    // cannot be acted as, so its members have no other way in. An organization
    // CAN be acted as, and widening this to it would be a decision nobody made.
    await seedScheduled({ owner: ORGANIZATION });
    const ownEntry = await seedScheduled({ owner: COLLEAGUE });

    expect(idsOf(await fetchQueue(COLLEAGUE))).toEqual([ownEntry]);
  });

  it('degrades to the personal queue when Oxy cannot answer', async () => {
    // `listOperatedChannelIds` fails soft, so an account-graph outage costs a
    // member the shared half rather than 500-ing the composer. It can never ADD
    // an account, which is the direction that would matter.
    listAccounts.mockRejectedValue(new Error('oxy is down'));
    await seedScheduled({ owner: CHANNEL, writtenBy: WRITER });
    const ownEntry = await seedScheduled({ owner: COLLEAGUE });

    const page = await fetchQueue(COLLEAGUE);

    expect(idsOf(page)).toEqual([ownEntry]);
    expect(page.status).toBeUndefined();
  });

  it('still refuses an unauthenticated caller with a 401', async () => {
    await seedScheduled({ owner: CHANNEL, writtenBy: WRITER });

    const page = await fetchQueue(undefined);

    expect(page.status).toBe(401);
    expect(listAccounts).not.toHaveBeenCalled();
  });
});

/**
 * PUBLISHING AN ENTRY EARLY — the write half, which had to be decided in the
 * same change as the read.
 *
 * Widening one alone breaks `affordance ⊆ permission` in whichever direction it
 * is left, so this pins that seeing and acting are the SAME right. They can be,
 * and should be, because membership is the strongest right that exists over a
 * channel — it can never be acted as, so there is nothing stronger to demand of
 * whoever sends an entry early than of whoever reads it.
 *
 * The read was in fact the NARROW half before this: `DELETE /posts/:id` already
 * let any active member CANCEL a channel's scheduled post, through the same
 * `postManagementRefusal` used here. So this endpoint was the one management
 * action still keyed on the caller, and a member could destroy a queued post
 * they were unable to see or send.
 *
 * The load-bearing assertion is WHICH ACCOUNT the claim names. The claim is an
 * atomic `status = 'scheduled' AND oxy_user_id = ?` update, and that owner is the
 * CHANNEL — passing the caller (as this did) matched no row, so the post was
 * unpublishable by everybody while the 409/404 told them it did not exist.
 */
describe('the shared editorial queue — publishing an entry early', () => {
  async function publishAs(viewerId: string | undefined, postId: string): Promise<Captured> {
    const { res, captured } = buildResponse();
    const req = { ...buildRequest(viewerId), params: { id: postId } };
    await publishScheduledPostNow(req as never, res as never);
    return captured;
  }

  it('lets a member send a channel’s entry early, claimed AS THE CHANNEL', async () => {
    const entry = await seedScheduled({ owner: CHANNEL, writtenBy: WRITER });
    claim.mockImplementation(async ({ postId }: { postId: string }) => {
      const record = await loadPostRecord(postId);
      return record ? { ...record, status: 'published' } : null;
    });

    // COLLEAGUE did not write it — they are simply on the team.
    const response = await publishAs(COLLEAGUE, entry);

    expect(response.status).toBeUndefined();
    expect(claim).toHaveBeenCalledWith({ postId: entry, ownerId: CHANNEL });
  });

  it('publishes a channel’s whole scheduled THREAD, root first', async () => {
    // The fixture that tells the chain walk's owner apart, and without it a
    // mutation survives: a LONE scheduled post walks to itself whatever account
    // the walk is scoped to (no parent to climb, no children to match), so every
    // other case here is blind to that argument. Scoped to the caller instead of
    // the channel, the descendant query matches nothing and only the root goes
    // out — a thread published half-way, stopping mid-sentence until the
    // continuation's own time comes round.
    const root = await seedScheduled({ owner: CHANNEL, writtenBy: WRITER, text: 'part one' });
    const continuation = await seedPost(scope, {
      oxyUserId: CHANNEL,
      authorship: [{ oxyUserId: CHANNEL, role: 'owner', status: 'accepted' }],
      writtenByOxyUserId: WRITER,
      status: 'scheduled',
      scheduledFor: later(60),
      parentPostId: root,
      content: { variants: [{ source: 'author', text: 'part two', tag: 'en' }] },
    });
    claim.mockImplementation(async ({ postId }: { postId: string }) => {
      const record = await loadPostRecord(postId);
      return record ? { ...record, status: 'published' } : null;
    });

    await publishAs(COLLEAGUE, root);

    expect(claim.mock.calls.map((call) => call[0])).toEqual([
      { postId: root, ownerId: CHANNEL },
      { postId: continuation.id, ownerId: CHANNEL },
    ]);
  });

  it('refuses an OUTSIDER with a 404 and never reaches the claim', async () => {
    const entry = await seedScheduled({ owner: CHANNEL, writtenBy: WRITER });

    const response = await publishAs(OUTSIDER, entry);

    expect(response.status).toBe(404);
    // The refusal is a 404 rather than a 403 precisely so it cannot be used to
    // confirm that somebody else's unpublished post exists.
    expect(claim).not.toHaveBeenCalled();
  });

  it('refuses a member whose invitation is not yet ACCEPTED', async () => {
    const entry = await seedScheduled({ owner: CHANNEL, writtenBy: WRITER });

    expect((await publishAs(INVITEE, entry)).status).toBe(404);
    expect(claim).not.toHaveBeenCalled();
  });

  it('still refuses an unauthenticated caller with a 401', async () => {
    const entry = await seedScheduled({ owner: CHANNEL, writtenBy: WRITER });

    expect((await publishAs(undefined, entry)).status).toBe(401);
    expect(claim).not.toHaveBeenCalled();
  });

  it('CONTROL: an ordinary author still publishes their OWN post, claimed as themselves', async () => {
    // Without this, every assertion above would pass on a handler that had
    // stopped letting anybody publish anything.
    const entry = await seedScheduled({ owner: OUTSIDER });
    claim.mockImplementation(async ({ postId }: { postId: string }) => {
      const record = await loadPostRecord(postId);
      return record ? { ...record, status: 'published' } : null;
    });

    const response = await publishAs(OUTSIDER, entry);

    expect(response.status).toBeUndefined();
    expect(claim).toHaveBeenCalledWith({ postId: entry, ownerId: OUTSIDER });
  });
});

/**
 * THE ACL UNDERNEATH, asked WITHOUT the operated-account set.
 *
 * This block exists because a mutation SURVIVED without it. Every case above
 * reaches the queue through the endpoint, which resolves the caller's channels
 * and hands them to hydration — so the writer is admitted by `operatedAccountIds`
 * and the writer clause beside it never decides anything. Deleting
 * `canManagePostWithoutLookup` from the ACL left all twelve of them green.
 *
 * The distinguishing shape is the one the endpoint can never produce: hydration
 * asked with NO operated accounts, which is every other surface in the
 * application (post detail, a thread, a notification embed) because resolving
 * that set costs an Oxy round trip nothing else may pay. There the writer clause
 * is the only thing standing between a person and their OWN unpublished writing.
 *
 * It also settles a real incoherence rather than adding a capability: `isOwner`
 * on the DTO already comes from `canManagePostWithoutLookup`, so before this the
 * two could disagree — the summary would have said "you own this post" about one
 * the same service refused to return.
 */
describe('the hydration ACL on an unpublished channel post', () => {
  const service = new PostHydrationService();

  async function hydrateAs(viewerId: string | undefined) {
    const post = await seedPost(scope, {
      oxyUserId: CHANNEL,
      authorship: [{ oxyUserId: CHANNEL, role: 'owner', status: 'accepted' }],
      writtenByOxyUserId: WRITER,
      status: 'scheduled',
      scheduledFor: later(60),
      content: { variants: [{ source: 'author', text: 'a queued story', tag: 'en' }] },
    });
    // No `operatedAccountIds` — the defaults every other caller hydrates with.
    return service.hydratePosts([post], { viewerId, maxDepth: 0 });
  }

  it('lets the WRITER read their own unpublished channel post', async () => {
    expect(await hydrateAs(WRITER)).toHaveLength(1);
  });

  it('refuses a colleague who operates the channel but did not write it', async () => {
    // Not a permission judgement — they DO operate it. It is that this surface
    // never asked Oxy, so it cannot know. The endpoint that does ask admits them
    // (see the read cases above), which is what keeps affordance ⊆ permission:
    // narrower without the answer, never wider.
    expect(await hydrateAs(COLLEAGUE)).toHaveLength(0);
  });

  it('refuses an outsider and an anonymous reader', async () => {
    expect(await hydrateAs(OUTSIDER)).toHaveLength(0);
    expect(await hydrateAs(undefined)).toHaveLength(0);
  });
});

/**
 * WHO QUEUED IT.
 *
 * The queue makes NO new disclosure: an entry names its writer exactly when the
 * published post would have, which is `channel.signPosts`. The mechanism is the
 * same one — these posts go through `PostHydrationService` like every other
 * listing — so there is no second consent gate here to drift from the first.
 *
 * Each case below asserts BOTH halves, because either alone is satisfiable by a
 * broken implementation: that the entry is present (so a suite cannot pass by
 * returning nothing) and that the writer is or is not named.
 */
describe('the shared editorial queue — who may see WHO QUEUED an entry', () => {
  it('names the writer to the team when the channel signs its posts', async () => {
    await setSignPosts(true);
    await seedScheduled({ owner: CHANNEL, writtenBy: WRITER });

    const page = await fetchQueue(COLLEAGUE);
    const entry = page.body?.posts?.[0];

    // The channel stays the signature; the writer is a SECOND author, drawn by
    // the byline the collaborative header already knows how to render.
    expect(entry?.user.id).toBe(CHANNEL);
    expect(entry?.authors.map((author) => [author.id, author.role])).toEqual([
      [CHANNEL, 'owner'],
      [WRITER, 'writer'],
    ]);
  });

  it('tells a member WHAT is queued and WHEN, but not WHO, when the channel does not sign', async () => {
    // THE CASE THE FEATURE LIVES OR DIES ON.
    //
    // A queue that says "scheduled by Ana" discloses authorship for a post that
    // has not published, and would do it for a channel that deliberately never
    // names anybody. `signPosts` protects anonymity FROM READERS — and a channel's
    // own members are readers of this surface, which is why the notification
    // inbox refuses the same disclosure to the same audience. So the shared queue
    // is genuinely shared, and genuinely anonymous, at the same time: the
    // collision this feature exists to prevent is answered by the CONTENT and the
    // TIME, neither of which is a name.
    await setSignPosts(false);
    const entry = await seedScheduled({
      owner: CHANNEL,
      writtenBy: WRITER,
      text: 'the Tuesday story',
    });

    const page = await fetchQueue(COLLEAGUE);

    // The entry IS there — the queue is shared. Without this the assertion below
    // would pass on a handler that had simply stopped returning anything.
    expect(idsOf(page)).toEqual([entry]);
    expect(page.body?.posts?.[0]?.authors.map((author) => author.id)).toEqual([CHANNEL]);
    // And the writer is nowhere in the payload, under any key. `writtenByOxyUserId`
    // is deliberately absent from every DTO; a queue must not be the exception.
    expect(JSON.stringify(page.body)).not.toContain(WRITER);
  });

  it('withholds the writer from a channel with no settings row at all', async () => {
    const entry = await seedScheduled({ owner: CHANNEL, writtenBy: WRITER });

    const page = await fetchQueue(COLLEAGUE);

    expect(idsOf(page)).toEqual([entry]);
    expect(JSON.stringify(page.body)).not.toContain(WRITER);
  });

  /**
   * THE TRUTHY-NON-BOOLEAN FIXTURE IS DELIBERATELY NOT HERE, and it is worth
   * saying why rather than leaving a reader to notice the gap.
   *
   * The ecosystem rule asks any `x === true` check for a fixture in the one shape
   * that tells it from `Boolean(x)` — a truthy non-boolean like `'false'` — since
   * `true`, `false` and absent all agree. `disclosesWriters` reads exactly that
   * way, and the fixture exists: `services/postHydrationChannelWriter.test.ts`
   * stages it and is mutation-tested on it.
   *
   * It cannot be reproduced HERE, because this suite's whole value is that the
   * settings row is REAL — and `user_settings.channel_account_sign_posts` is a
   * Postgres `boolean`, so the column itself refuses every value that would make
   * the strict and loose reads disagree. Writing one would mean going around the
   * schema, which would be testing a state the database cannot hold.
   *
   * The two suites are therefore doing different jobs on purpose: that one owns
   * the DECISION against arbitrary staged values, this one owns the QUERY that
   * fetches the real row and the SURFACE that honours it. Do not "complete" this
   * file by adding a fake row — it would make the settings read a stub again, and
   * a consent read that silently finds nothing reads as anonymous and passes.
   */

  it('does not name a non-signing channel’s writer even when they are already resolved', async () => {
    // Withholding the id from the identity batch is what usually makes disclosure
    // impossible, which leaves the byline's own check unfalsifiable. It stops
    // being unfalsifiable the moment the writer is in the batch for another
    // reason — and the most ordinary reason there is, on THIS surface, is that
    // they have a scheduled post of their own in the same queue.
    await setSignPosts(false);
    const channelEntry = await seedScheduled({ owner: CHANNEL, writtenBy: WRITER, inMinutes: 30 });
    const ownEntry = await seedScheduled({ owner: WRITER, inMinutes: 90 });

    const page = await fetchQueue(WRITER);

    expect(idsOf(page)).toEqual([channelEntry, ownEntry]);
    const channelPost = page.body?.posts?.find((post) => post.user.id === CHANNEL);
    expect(channelPost?.authors.map((author) => author.id)).toEqual([CHANNEL]);
    // Vacuity floor: the writer really was resolved in this batch (their own post
    // names them), so the assertion above is the byline refusing to name them and
    // not an identity that was merely unavailable.
    expect(page.body?.posts?.find((post) => post.user.id === WRITER)?.user.username).toBe(WRITER);
  });
});
