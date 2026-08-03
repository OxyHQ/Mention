import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountMember } from '@oxyhq/core';
import type { OxyAuthRequest } from '@oxyhq/core/server';

/**
 * `POST /posts/thread` — publishing individual entries of a BEAST batch as
 * accounts the caller operates.
 *
 * Three things this path has to get right, and each has failed in a plausible
 * design:
 *
 *  1. **Per ENTRY, and beast mode only.** A beast batch is n independent posts,
 *     so entry 1 may come from a channel and entry 2 from an organization. A
 *     THREAD is a chain of replies, and a reply can never be published as another
 *     account, so the whole request is refused there instead of silently applying
 *     the root's identity to posts that cannot carry it.
 *  2. **Refused BEFORE anything is written.** Half a batch cannot be undone in one
 *     action, so an entry naming an account the caller may not use must not leave
 *     the earlier entries published.
 *  3. **One membership call per distinct account, not one per post.** The real
 *     gate runs here (only `PostCreationService.create` is stubbed), so the count
 *     of `listAccountMembers` calls is a real measurement rather than a proxy.
 */

const listAccountMembers = vi.hoisted(() => vi.fn());
const resolveUserSummaries = vi.hoisted(() => vi.fn());
const createMentionNotifications = vi.hoisted(() => vi.fn(async () => undefined));
const emit = vi.hoisted(() => vi.fn());

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => ({ emit }),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (objs: object[]) => objs) },
  resolveUserSummaries,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  // The caller's own bearer-scoped Oxy client, which is what the gate reads
  // membership with. One shared spy so the call COUNT across the whole request is
  // observable — that is the assertion behind "resolve each account once".
  createUserScopedOxyServices: vi.fn(() => ({ listAccountMembers })),
}));

vi.mock('../../utils/notificationUtils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createMentionNotifications,
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const laneExists = vi.hoisted(() => vi.fn());
vi.mock('../../models/Lane', () => ({
  Lane: {
    exists: laneExists,
    findById: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
  },
}));

const create = vi.hoisted(() => vi.fn());
vi.mock('../../services/PostCreationService', () => ({
  postCreationService: { create },
}));

import mongoose from 'mongoose';
import { createThread } from '../../controllers/posts.controller';

const CALLER = 'caller-1';
const CHANNEL = 'channel-account-1';
const ORGANIZATION = 'org-account-1';
const FORBIDDEN_ORG = 'org-account-2';
const CALLER_LANE = new mongoose.Types.ObjectId().toString();

const EDITOR_PERMISSIONS = ['account:read', 'account:act_as', 'members:read'];
const VIEWER_PERMISSIONS = ['account:read', 'members:read'];

function member(overrides: Partial<AccountMember> = {}): AccountMember {
  return {
    _id: 'member-row',
    accountId: 'account',
    memberUserId: CALLER,
    role: 'editor',
    permissions: EDITOR_PERMISSIONS,
    inherit: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function req(body: Record<string, unknown>): OxyAuthRequest {
  return {
    user: { id: CALLER },
    query: {},
    headers: {},
    // Express content negotiation, which hydration reads for the response's
    // language preference. Absent, the controller throws and every assertion
    // below reads 500 for a reason that has nothing to do with publishing as.
    acceptsLanguages: () => [],
    body,
  } as unknown as OxyAuthRequest;
}

/** The `publishAsOxyUserId` each `create` call was given, in order. */
function requestedAccounts(): Array<string | null> {
  return create.mock.calls.map(([params]: [Record<string, unknown>]) =>
    (params.publishAsOxyUserId as string | null) ?? null,
  );
}

beforeEach(() => {
  create.mockReset();
  // Stands in for the real service, which resolves the author itself through the
  // gate. Mirroring that here (the named account when there is one) is what makes
  // the DOWNSTREAM assertions — the notification actor, the socket author —
  // measure the controller rather than the stub.
  create.mockImplementation(async (params: Record<string, unknown>) => {
    const oxyUserId = (params.publishAsOxyUserId as string | null) ?? (params.oxyUserId as string);
    const _id = new mongoose.Types.ObjectId();
    return {
      _id,
      oxyUserId,
      mentions: (params.mentions as string[]) ?? [],
      content: params.content,
      threadId: null,
      save: vi.fn(async () => undefined),
      toObject: () => ({ _id, oxyUserId, content: params.content }),
    };
  });

  listAccountMembers.mockReset();
  listAccountMembers.mockImplementation(async (accountId: string) => {
    if (accountId === CHANNEL) return [member({ role: 'viewer', permissions: VIEWER_PERMISSIONS })];
    if (accountId === ORGANIZATION) return [member({ role: 'editor', permissions: EDITOR_PERMISSIONS })];
    // An organization the caller is a member of but may not ACT AS.
    if (accountId === FORBIDDEN_ORG) return [member({ role: 'viewer', permissions: VIEWER_PERMISSIONS })];
    return [];
  });

  resolveUserSummaries.mockReset();
  resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const kinds: Record<string, string> = {
      [CHANNEL]: 'channel',
      [ORGANIZATION]: 'organization',
      [FORBIDDEN_ORG]: 'organization',
    };
    const map = new Map<string, { user: { id: string; kind?: string; name: object } }>();
    for (const id of ids) {
      if (kinds[id]) map.set(id, { user: { id, kind: kinds[id], name: {} } });
    }
    return map;
  });

  // A lane owned by the CALLER and by nobody else — which is the discriminator
  // for the pre-flight's author (see the lane suite below).
  laneExists.mockReset();
  laneExists.mockImplementation(async (filter: { ownerId?: string }) =>
    filter?.ownerId === CALLER ? { _id: CALLER_LANE } : null,
  );

  createMentionNotifications.mockClear();
  emit.mockClear();
});

describe('beast mode — each entry may come from a different account', () => {
  it('creates every entry, each carrying its own publishAsOxyUserId', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'beast',
        posts: [
          { content: { text: 'from the channel' }, publishAsOxyUserId: CHANNEL },
          { content: { text: 'from the org' }, publishAsOxyUserId: ORGANIZATION },
          { content: { text: 'from me' } },
        ],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    expect(requestedAccounts()).toEqual([CHANNEL, ORGANIZATION, null]);
  });

  it('hands the SAME memberReader to every create, so the gate cannot be routed around', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'beast',
        posts: [
          { content: { text: 'a' }, publishAsOxyUserId: ORGANIZATION },
          { content: { text: 'b' }, publishAsOxyUserId: ORGANIZATION },
        ],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    const readers = create.mock.calls.map(([params]: [Record<string, unknown>]) => params.memberReader);
    expect(readers[0]).toBeDefined();
    expect(readers[1]).toBe(readers[0]);
  });

  /**
   * The performance property, measured rather than assumed: twelve entries naming
   * ONE account cost ONE membership read. Without `cacheAccountMemberReads` the
   * pre-flight alone would make twelve.
   */
  it('reads each distinct account\'s members ONCE per request, not once per post', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'beast',
        posts: Array.from({ length: 12 }, (_unused, i) => ({
          content: { text: `entry ${i}` },
          publishAsOxyUserId: ORGANIZATION,
        })),
      }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    expect(create).toHaveBeenCalledTimes(12);
    expect(listAccountMembers.mock.calls.map(([id]: [string]) => id)).toEqual([ORGANIZATION]);
  });

  it('still reads once PER distinct account when a batch names several', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'beast',
        posts: [
          { content: { text: 'a' }, publishAsOxyUserId: ORGANIZATION },
          { content: { text: 'b' }, publishAsOxyUserId: CHANNEL },
          { content: { text: 'c' }, publishAsOxyUserId: ORGANIZATION },
          { content: { text: 'd' } },
        ],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    expect(listAccountMembers.mock.calls.map(([id]: [string]) => id).sort()).toEqual(
      [CHANNEL, ORGANIZATION].sort(),
    );
  });

  it('a channel entry needs no account:act_as — bare membership is the whole right', async () => {
    const res = makeRes();
    await createThread(
      req({ mode: 'beast', posts: [{ content: { text: 'a' }, publishAsOxyUserId: CHANNEL }] }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    expect(requestedAccounts()).toEqual([CHANNEL]);
  });
});

describe('beast mode — a refused entry takes the WHOLE batch with it', () => {
  it('403s an organization the caller may not act as, before writing anything', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'beast',
        posts: [
          { content: { text: 'would have been published' } },
          { content: { text: 'b' }, publishAsOxyUserId: FORBIDDEN_ORG },
        ],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(403);
    // The half-batch this pre-flight exists to prevent: entry 0 is perfectly
    // valid, and must still not be written.
    expect(create).not.toHaveBeenCalled();
  });

  it('400s a personal account named by any entry, before writing anything', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'beast',
        posts: [
          { content: { text: 'a' } },
          { content: { text: 'b' }, publishAsOxyUserId: 'some-humans-account' },
        ],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('503s when the membership read fails, so the client can retry the whole batch', async () => {
    listAccountMembers.mockRejectedValue(new Error('oxy 500'));

    const res = makeRes();
    await createThread(
      req({ mode: 'beast', posts: [{ content: { text: 'a' }, publishAsOxyUserId: ORGANIZATION }] }),
      res as never,
    );

    expect(res.statusCode).toBe(503);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('the side effects follow the ENTRY\'s author, not the caller', () => {
  it('attributes a mention notification to the account the entry was published as', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'beast',
        posts: [{ content: { text: 'hi @someone' }, mentions: ['mentioned-1'], publishAsOxyUserId: CHANNEL }],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    expect(createMentionNotifications).toHaveBeenCalledTimes(1);
    // Third argument is the ACTOR. Naming the caller here would put a channel's
    // writer into the notification of a post the channel signed — the anonymity
    // `writtenByOxyUserId` exists to keep.
    expect(createMentionNotifications.mock.calls[0][2]).toBe(CHANNEL);
  });

  it('emits the following-feed update under the first entry\'s author', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'beast',
        posts: [
          { content: { text: 'a' }, publishAsOxyUserId: ORGANIZATION },
          { content: { text: 'b' } },
        ],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    const following = emit.mock.calls.find(
      ([, payload]: [string, { type?: string }]) => payload?.type === 'following',
    );
    expect(following?.[1]).toMatchObject({ authorId: ORGANIZATION });
  });

  it('CONTROL: an ordinary batch still attributes both to the caller', async () => {
    const res = makeRes();
    await createThread(
      req({ mode: 'beast', posts: [{ content: { text: 'hi' }, mentions: ['mentioned-1'] }] }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    expect(createMentionNotifications.mock.calls[0][2]).toBe(CALLER);
    const following = emit.mock.calls.find(
      ([, payload]: [string, { type?: string }]) => payload?.type === 'following',
    );
    expect(following?.[1]).toMatchObject({ authorId: CALLER });
  });
});

/**
 * THREAD mode names the account ONCE, for the whole thread.
 *
 * A thread is one text in several parts, so there is exactly one publisher by
 * construction — an identity that changed mid-thread is the incoherent case, and
 * that is the one refused. The continuations are stored as replies to their
 * predecessor, which is the only reason this needs `PostCreationService`'s
 * verified `continuesOwnThread` exception at all.
 */
describe('thread mode — one account for the whole thread', () => {
  it('applies the batch account to EVERY entry, root and continuations alike', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'thread',
        publishAsOxyUserId: CHANNEL,
        posts: [
          { content: { text: 'part one' } },
          { content: { text: 'part two' } },
          { content: { text: 'part three' } },
        ],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    expect(requestedAccounts()).toEqual([CHANNEL, CHANNEL, CHANNEL]);
  });

  it('marks only the CONTINUATIONS as continuing their own thread, never the root', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'thread',
        publishAsOxyUserId: CHANNEL,
        posts: [
          { content: { text: 'part one' } },
          { content: { text: 'part two' } },
          { content: { text: 'part three' } },
        ],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    const marks = create.mock.calls.map(
      ([params]: [Record<string, unknown>]) => params.continuesOwnThread === true,
    );
    // The root is a root: it has no parent, so it needs no exception — and one
    // granted there would be an exception with nothing to verify against.
    expect(marks).toEqual([false, true, true]);
  });

  it('chains each continuation to its predecessor under the SAME thread root', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'thread',
        publishAsOxyUserId: CHANNEL,
        posts: [
          { content: { text: 'part one' } },
          { content: { text: 'part two' } },
          { content: { text: 'part three' } },
        ],
      }),
      res as never,
    );

    const calls = create.mock.calls.map(([params]: [Record<string, unknown>]) => params);
    const rootId = String((await create.mock.results[0].value)._id);
    const secondId = String((await create.mock.results[1].value)._id);
    expect(calls[1]).toMatchObject({ parentPostId: rootId, threadId: rootId });
    expect(calls[2]).toMatchObject({ parentPostId: secondId, threadId: rootId });
  });

  it('authorizes the account ONCE for the whole thread', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'thread',
        publishAsOxyUserId: ORGANIZATION,
        posts: Array.from({ length: 8 }, (_unused, i) => ({ content: { text: `part ${i}` } })),
      }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    expect(create).toHaveBeenCalledTimes(8);
    expect(listAccountMembers.mock.calls.map(([id]: [string]) => id)).toEqual([ORGANIZATION]);
  });

  it('refuses the whole thread when the account is not the caller\'s to use', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'thread',
        publishAsOxyUserId: FORBIDDEN_ORG,
        posts: [{ content: { text: 'a' } }, { content: { text: 'b' } }],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('400s a PER-ENTRY account in thread mode, and asks Oxy nothing', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'thread',
        posts: [
          { content: { text: 'root' }, publishAsOxyUserId: ORGANIZATION },
          { content: { text: 'continuation' } },
        ],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(listAccountMembers).not.toHaveBeenCalled();
  });

  it('CONTROL: a thread naming no account marks no continuation and stays the caller\'s', async () => {
    const res = makeRes();
    await createThread(
      req({ mode: 'thread', posts: [{ content: { text: 'a' } }, { content: { text: 'b' } }] }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    expect(requestedAccounts()).toEqual([null, null]);
    // The marker rides with the CHAIN, not with the account — an ordinary
    // self-thread carries it too and `create` simply never consults it, because
    // no account was named.
    const marks = create.mock.calls.map(
      ([params]: [Record<string, unknown>]) => params.continuesOwnThread === true,
    );
    expect(marks).toEqual([false, true]);
  });
});

/**
 * The lane pre-flight has to measure each entry against the account that entry
 * will be AUTHORED BY, because `PostCreationService` certainly will. Measured
 * against the CALLER instead, a caller-owned lane on an account-published entry
 * sails through the pre-flight and is then refused mid-loop by the service — with
 * the earlier entries already written. That is precisely the half-batch the
 * pre-flight exists to prevent, so it is the one shape worth pinning.
 */
describe('the lane pre-flight follows the ENTRY\'s author', () => {
  it('404s a lane the CALLER owns on an entry published as an organization, before writing anything', async () => {
    const res = makeRes();
    await createThread(
      req({
        mode: 'beast',
        posts: [
          { content: { text: 'would have been published' } },
          { content: { text: 'b' }, laneId: CALLER_LANE, publishAsOxyUserId: ORGANIZATION },
        ],
      }),
      res as never,
    );

    expect(res.statusCode).toBe(404);
    expect(create).not.toHaveBeenCalled();
    // The lane was looked up under the ORGANIZATION, never the caller.
    expect(laneExists).toHaveBeenCalledWith(
      expect.objectContaining({ _id: CALLER_LANE, ownerId: ORGANIZATION }),
    );
  });

  it('CONTROL: the same lane on an entry the caller publishes as themselves is accepted', async () => {
    const res = makeRes();
    await createThread(
      req({ mode: 'beast', posts: [{ content: { text: 'b' }, laneId: CALLER_LANE }] }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    expect(laneExists).toHaveBeenCalledWith(
      expect.objectContaining({ _id: CALLER_LANE, ownerId: CALLER }),
    );
  });
});
