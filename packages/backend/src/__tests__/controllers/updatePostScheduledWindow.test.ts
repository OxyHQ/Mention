import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 30-minute edit window, and the ONE case it does not apply to.
 *
 * The window exists because readers have already seen a PUBLISHED post, so
 * rewriting one indefinitely is a trust problem. A SCHEDULED post has no
 * readers, so the window would only make a post scheduled for next week
 * uneditable half an hour after it was written.
 *
 * Carving that exception out is exactly the kind of change that quietly widens
 * into "nothing is ever locked", so the published rule is pinned here in both
 * directions — inside the window it saves, outside it 403s — alongside the
 * scheduled carve-out. If a change ever lets a published post be edited a day
 * later, the `published` cases below fail by name.
 *
 * The carve-out is also asserted to be SERVER-decided: the request body cannot
 * select it, and a post that publishes between the read and the write is
 * refused rather than edited.
 */
vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

const hoisted = vi.hoisted(() => ({
  hydratePosts: vi.fn(),
  createScopedOxyClient: vi.fn(),
  resolveUserSummaries: vi.fn(),
  resolveCollaboratorRefs: vi.fn(),
  attachCollaborators: vi.fn(),
  autoAcceptInvites: vi.fn(),
  notifyPendingInvites: vi.fn(),
  emitPostCreated: vi.fn(),
  listAccountMembers: vi.fn(),
}));

/**
 * The post is a REAL ROW, and so is the chain around it.
 *
 * The stub this replaces had to reproduce three separate things the handler
 * asks the database: the owner-scoped load, the "did it publish while I was
 * editing?" re-read, and the chain walk. Each of those is a predicate the port
 * had to translate, and a stub that answers them from its own arrays cannot
 * tell a correct translation from one that matches nothing — which is what a
 * silently un-rescheduled thread looks like.
 */
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: hoisted.createScopedOxyClient,
  // A real member reader, because the CHANNEL case below is authorized through
  // `postManagementRefusal` rather than by owning the row. Every other case in
  // this file edits its own post, which `canManagePostWithoutLookup` settles
  // before any account read — so none of them reaches this.
  createUserScopedOxyServices: vi.fn(() => ({
    listAccountMembers: (accountId: string) => hoisted.listAccountMembers(accountId),
  })),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hoisted.hydratePosts },
  resolveUserSummaries: hoisted.resolveUserSummaries,
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown user' } }),
}));

// `PostCollaborationService`, capital P — the module the controller actually
// imports. This mock named a lowercase path and therefore applied to nothing:
// the real service ran, and every `hoisted.*` collaborator spy below was
// permanently uncalled, which reads identically to the branch not being taken.
vi.mock('../../services/PostCollaborationService', () => ({
  postCollaborationService: {
    resolveCollaboratorRefs: hoisted.resolveCollaboratorRefs,
    attachCollaborators: hoisted.attachCollaborators,
    autoAcceptInvites: hoisted.autoAcceptInvites,
    notifyPendingInvites: hoisted.notifyPendingInvites,
  },
  CollabValidationError: class extends Error {},
  CollabStateError: class extends Error {},
}));

// `MentionRecordEmitter`, the module the controller actually imports. This mock
// named `services/mtn/postRecords`, the path the emitter was renamed AWAY from —
// and `vi.mock` keys on a RESOLVED id, so a mock naming a module that does not
// exist matches nothing and reports nothing. The real emitter ran on every edit
// below (`resolvePostRecordEmbeds` batches an Oxy asset lookup before the
// env gate can turn the write into a no-op), while `hoisted.emitPostCreated`
// stayed permanently uncalled — which is indistinguishable from a stub that is
// working. The assertions on that spy are what stop it going quiet again.
vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: hoisted.emitPostCreated,
  emitTombstone: vi.fn(),
  postRecordUri: () => 'at://test',
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { claimScheduledPost } from '../../db/posts/postRepository';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { updatePost } from '../../controllers/posts.controller';

const scope = serviceScope('update-post-scheduled-window');
const USER_ID = scope.user('author');

const HOUR_MS = 60 * 60 * 1000;

/** The post under edit. Assigned by `seedTarget`, before any request is built. */
let POST_ID = '';

/**
 * The post under edit, as a row.
 *
 * `created_at` is deliberately WELL outside the 30-minute window, so any case
 * that saves does so because of the carve-out and not because it happened to be
 * fresh.
 */
async function seedTarget(overrides: Partial<PostRecordInput> = {}): Promise<void> {
  const record = await seedPost(scope, {
    oxyUserId: USER_ID,
    status: 'published',
    createdAt: new Date(Date.now() - 26 * HOUR_MS),
    content: { variants: [{ tag: 'en', source: 'author', text: 'original' }] },
    ...overrides,
  });
  POST_ID = record.id;
}

/** The stored post as it now stands — what "did it save?" is asked of. */
function stored() {
  return readPost(POST_ID);
}

/** Its body, so a refused edit can be told from an applied one. */
async function storedText(): Promise<string | undefined> {
  return (await stored())?.content.variants?.[0]?.text;
}

function buildRequest(body: Record<string, unknown>, user: { id: string } | undefined = { id: USER_ID }) {
  return {
    params: { id: POST_ID },
    query: {},
    headers: {},
    acceptsLanguages: () => [] as string[],
    body,
    ...(user ? { user } : {}),
  };
}

function buildResponse() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  POST_ID = '';
  hoisted.createScopedOxyClient.mockReturnValue(undefined);
  hoisted.hydratePosts.mockImplementation(async () => [{ id: POST_ID }]);
  hoisted.resolveCollaboratorRefs.mockResolvedValue(undefined);
});

afterEach(async () => {
  await clearServiceScope(scope);
});

describe('updatePost — the 30-minute window still binds a PUBLISHED post', () => {
  it('REFUSES an edit to a published post outside the window', async () => {
    await seedTarget({ status: 'published' });
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'rewritten a day later' } }) as never, res as never);

    expect(captured.status).toBe(403);
    expect(await storedText()).toBe('original');
    // A refusal emits nothing. Its negative control is the INSIDE-the-window
    // case below, which asserts the same spy DOES fire — without it, "never
    // called" is also what an orphaned mock reports.
    expect(hoisted.emitPostCreated).not.toHaveBeenCalled();
  });

  /**
   * `status` is `NOT NULL DEFAULT 'published'` here, so the legacy "no explicit
   * status" row the Mongo version modelled cannot exist — the default IS the
   * answer, and it is the same one. Asserted through the default rather than
   * through an absent field.
   */
  it('REFUSES an edit to a post that took the published default', async () => {
    await seedTarget({});
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'rewritten' } }) as never, res as never);

    expect(captured.status).toBe(403);
    expect(await storedText()).toBe('original');
  });

  it('ALLOWS an edit to a published post INSIDE the window (the rule is a window, not a ban)', async () => {
    await seedTarget({ status: 'published', createdAt: new Date(Date.now() - 60_000) });
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'quick fix' } }) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(await storedText()).toBe('quick fix');
    // The MTN dual-write re-emits the record under the SAME rkey, carrying the
    // EDITED body — the chain is append-only and materialization is
    // last-writer-wins, so an emit of the pre-edit record would silently
    // publish the old text forever. Also the one assertion that fails when the
    // emitter mock stops intercepting.
    expect(hoisted.emitPostCreated).toHaveBeenCalledTimes(1);
    expect(hoisted.emitPostCreated.mock.calls[0]?.[0]).toMatchObject({
      id: POST_ID,
      content: { variants: [expect.objectContaining({ text: 'quick fix' })] },
    });
  });

  it('cannot be talked out of the window by the request body', async () => {
    await seedTarget({ status: 'published' });
    const { res, captured } = buildResponse();

    // A client claiming the post is scheduled must change nothing: the carve-out
    // reads the STORED status.
    await updatePost(
      buildRequest({ content: { text: 'nice try' }, status: 'scheduled', scheduledFor: new Date(Date.now() + HOUR_MS).toISOString() }) as never,
      res as never,
    );

    expect(captured.status).toBe(403);
    expect(await storedText()).toBe('original');
  });
});

describe('updatePost — a SCHEDULED post is exempt', () => {
  it('ALLOWS an edit long past the window, because nobody has seen it', async () => {
    await seedTarget({ status: 'scheduled', scheduledFor: new Date(Date.now() + 7 * 24 * HOUR_MS) });
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'still editable next week' } }) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(await storedText()).toBe('still editable next week');
  });

  it('moves the publish time LATER', async () => {
    await seedTarget({ status: 'scheduled', scheduledFor: new Date(Date.now() + HOUR_MS) });
    const later = new Date(Date.now() + 5 * HOUR_MS);
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ scheduledFor: later.toISOString() }) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect((await stored())?.scheduledFor?.toISOString()).toBe(later.toISOString());
  });

  it('moves the publish time EARLIER', async () => {
    await seedTarget({ status: 'scheduled', scheduledFor: new Date(Date.now() + 5 * HOUR_MS) });
    const sooner = new Date(Date.now() + HOUR_MS);
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ scheduledFor: sooner.toISOString() }) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect((await stored())?.scheduledFor?.toISOString()).toBe(sooner.toISOString());
  });

  it('REFUSES a time in the past', async () => {
    const original = new Date(Date.now() + HOUR_MS);
    await seedTarget({ status: 'scheduled', scheduledFor: original });
    const { res, captured } = buildResponse();

    await updatePost(
      buildRequest({ scheduledFor: new Date(Date.now() - 60_000).toISOString() }) as never,
      res as never,
    );

    expect(captured.status).toBe(400);
    expect((await stored())?.scheduledFor?.toISOString()).toBe(original.toISOString());
  });

  it('REFUSES an unparseable time', async () => {
    await seedTarget({ status: 'scheduled', scheduledFor: new Date(Date.now() + HOUR_MS) });
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ scheduledFor: 'next tuesday-ish' }) as never, res as never);

    expect(captured.status).toBe(400);
    expect(await storedText()).toBe('original');
  });

  it('REFUSES to schedule a post that has already published', async () => {
    await seedTarget({ status: 'published', createdAt: new Date(Date.now() - 60_000) });
    const { res, captured } = buildResponse();

    await updatePost(
      buildRequest({ scheduledFor: new Date(Date.now() + HOUR_MS).toISOString() }) as never,
      res as never,
    );

    expect(captured.status).toBe(400);
    expect(await storedText()).toBe('original');
  });

  it('REFUSES to write when the post published between the read and the save', async () => {
    await seedTarget({ status: 'scheduled', scheduledFor: new Date(Date.now() + 30_000) });
    // The 60s publisher sweep takes it while the edit is being assembled. Staged
    // through `resolveCollaboratorRefs`, which the handler awaits AFTER the
    // carve-out is decided and BEFORE the late re-read — the exact window the
    // re-read exists to narrow.
    hoisted.resolveCollaboratorRefs.mockImplementation(async () => {
      await claimScheduledPost(POST_ID, USER_ID);
      return undefined;
    });
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'too late' } }) as never, res as never);

    expect(captured.status).toBe(409);
    expect(await storedText()).toBe('original');
  });
});

/**
 * A scheduled THREAD has ONE publish moment, not one per post.
 *
 * Its continuations are replies to one another and the author picked a time for
 * the thread, so moving any member moves the chain. Leaving the others behind
 * would not break the ordering invariant — a continuation whose parent is still
 * scheduled simply waits for it — but it would show the author a queue with
 * three different times for one thread and then publish it in dribs.
 */
describe('updatePost — rescheduling moves the whole thread', () => {
  const ORIGINAL_TIME = () => new Date(Date.now() + HOUR_MS);
  let continuationIds: string[] = [];

  /** The target plus two continuations, all at the one time the author picked. */
  async function seedChain(options: { foreignTail?: boolean } = {}): Promise<void> {
    await seedTarget({ status: 'scheduled', scheduledFor: ORIGINAL_TIME() });
    const c1 = await seedPost(scope, {
      oxyUserId: USER_ID,
      status: 'scheduled',
      scheduledFor: ORIGINAL_TIME(),
      parentPostId: POST_ID,
    });
    const c2 = await seedPost(scope, {
      oxyUserId: options.foreignTail ? scope.user('someone-else') : USER_ID,
      status: 'scheduled',
      scheduledFor: ORIGINAL_TIME(),
      parentPostId: c1.id,
    });
    continuationIds = [c1.id, c2.id];
  }

  async function scheduledTimes(): Promise<Array<string | undefined>> {
    const records = await Promise.all(continuationIds.map((id) => readPost(id)));
    return records.map((record) => record?.scheduledFor?.toISOString());
  }

  it('carries the continuations to the new time', async () => {
    await seedChain();
    const later = new Date(Date.now() + 4 * HOUR_MS);
    const { res } = buildResponse();

    await updatePost(buildRequest({ scheduledFor: later.toISOString() }) as never, res as never);

    expect(await scheduledTimes()).toEqual([later.toISOString(), later.toISOString()]);
  });

  it('scopes the move to the caller\'s own still-scheduled posts', async () => {
    // The tail belongs to somebody else, so the chain walk never reaches it and
    // the move cannot touch it — the scoping is in the walk, not only in the write.
    await seedChain({ foreignTail: true });
    const original = (await readPost(continuationIds[1]))?.scheduledFor?.toISOString();
    const later = new Date(Date.now() + 4 * HOUR_MS);
    const { res } = buildResponse();

    await updatePost(buildRequest({ scheduledFor: later.toISOString() }) as never, res as never);

    expect(await scheduledTimes()).toEqual([later.toISOString(), original]);
  });

  it('moves nothing for a lone scheduled post', async () => {
    const original = ORIGINAL_TIME();
    await seedTarget({ status: 'scheduled', scheduledFor: original });
    continuationIds = [];
    const later = new Date(Date.now() + 2 * HOUR_MS);
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ scheduledFor: later.toISOString() }) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect((await stored())?.scheduledFor?.toISOString()).toBe(later.toISOString());
  });

  it('moves nothing when the edit changed no time at all', async () => {
    await seedChain();
    const before = await scheduledTimes();
    const { res } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'reworded' } }) as never, res as never);

    expect(await scheduledTimes()).toEqual(before);
    expect(await storedText()).toBe('reworded');
  });

  /**
   * A CHANNEL'S thread, moved by a member who is not its owner.
   *
   * The chain is walked as the post's OWNER, never as the caller, and a channel
   * is the one case where those differ: a channel AUTHORS its own posts and no
   * session can ever be one. Scoped to the caller, the descendant query matched
   * nothing, so the edited post moved alone and its continuations stayed where
   * they were — silently producing the exact split queue this whole block exists
   * to prevent, with no error and nothing in the response to suggest it.
   *
   * The caller's RIGHT to be here is a separate question, already settled by
   * `postManagementRefusal` above; this is only about which account's chain the
   * walk names.
   */
  it('carries a CHANNEL’s continuations, walked as the channel and not the caller', async () => {
    const channel = scope.user('channel');
    const member = scope.user('channel-member');
    hoisted.resolveUserSummaries.mockResolvedValue(
      new Map([[channel, { user: { id: channel, username: 'thechannel', kind: 'channel' } }]]),
    );
    hoisted.listAccountMembers.mockResolvedValue([
      {
        _id: `member-${channel}-${member}`,
        accountId: channel,
        memberUserId: member,
        role: 'editor',
        permissions: ['account:read', 'account:act_as'],
        inherit: true,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await seedTarget({
      oxyUserId: channel,
      writtenByOxyUserId: scope.user('some-writer'),
      status: 'scheduled',
      scheduledFor: ORIGINAL_TIME(),
    });
    const continuation = await seedPost(scope, {
      oxyUserId: channel,
      status: 'scheduled',
      scheduledFor: ORIGINAL_TIME(),
      parentPostId: POST_ID,
    });
    continuationIds = [continuation.id];

    const later = new Date(Date.now() + 4 * HOUR_MS);
    const { res, captured } = buildResponse();

    await updatePost(
      buildRequest({ scheduledFor: later.toISOString() }, { id: member }) as never,
      res as never,
    );

    expect(captured.status).toBeUndefined();
    expect((await stored())?.scheduledFor?.toISOString()).toBe(later.toISOString());
    expect(await scheduledTimes()).toEqual([later.toISOString()]);
  });
});
