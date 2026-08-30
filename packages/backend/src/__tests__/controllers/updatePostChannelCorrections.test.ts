import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A channel post corrects in the open; a personal post keeps its window.
 *
 * The 30-minute window exists because rewriting text after people have read it
 * is a trust problem. A publication does not solve that by hiding — it corrects
 * openly and leaves a trail — so a CHANNEL post is editable for life and every
 * change to its body records what the post said before.
 *
 * That is a rule with two halves, and shipping only the first would be strictly
 * WORSE than the window it replaces: permanent editability with no trail is
 * exactly the silent rewrite the window was protecting against. So both halves
 * are pinned here, in both directions:
 *
 *  - a channel post is editable a day later, a personal post is NOT;
 *  - a body change to a published channel post records a correction, and an
 *    edit that changes no body — or touches a post nobody has read yet, or a
 *    personal post — records NOTHING.
 *
 * Every fixture is paired with its opposite on purpose. A suite where every post
 * is a channel post cannot tell "the window was lifted for channels" from "the
 * window was deleted", and a suite where every edit rewrites the body cannot
 * tell "a correction is recorded on a body change" from "a correction is
 * recorded on every save".
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
  federateAsResolvedActor: vi.fn(),
  listAccountMembers: vi.fn(),
}));

// A real member reader, because `postManagementRefusal` proves CURRENT channel
// membership against Oxy before this handler reaches its correction logic. Being
// named on the row as its writer is not authority — that column is written once
// and never revised — so a suite about the writer editing has to say who Oxy
// currently thinks they are. Every PERSON_ID case edits its own post and never
// reaches this.
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: hoisted.createScopedOxyClient,
  createUserScopedOxyServices: vi.fn(() => ({ listAccountMembers: hoisted.listAccountMembers })),
}));

/**
 * The account KIND reaches the handler through here.
 *
 * `isChannelAccount` → `resolveAccountKind` → `resolveAccountKinds` →
 * `resolveUserSummaries`, so mocking the identity read is what makes a post a
 * channel's — the same single path production uses, rather than a second stub of
 * the predicate that could answer differently from it.
 */
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hoisted.hydratePosts },
  resolveUserSummaries: hoisted.resolveUserSummaries,
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown user' } }),
}));

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

// The REAL module path the controller imports. A mock naming a path that does
// not resolve applies to nothing and leaves the live emitter running, which
// reads exactly like the branch not being taken.
vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: hoisted.emitPostCreated,
  emitTombstone: vi.fn(),
  postRecordUri: () => 'mtn://test',
}));

vi.mock('../../connectors/outboundFederation', () => ({
  federateAsResolvedActor: hoisted.federateAsResolvedActor,
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { listPostCorrections } from '../../db/posts/postCorrectionsRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { getPostCorrections } from '../../controllers/posts/readPosts';
import { updatePost } from '../../controllers/posts/updatePost';

const scope = serviceScope('update-post-channel-corrections');
/** The channel ACCOUNT — the author of a channel post, which nobody signs in as. */
const CHANNEL_ID = scope.user('channel');
/** The human who writes for it, and who is signed in for every request here. */
const WRITER_ID = scope.user('writer');
/** An ordinary person posting as themselves. */
const PERSON_ID = scope.user('person');

const HOUR_MS = 60 * 60 * 1000;
/** Well past the window, so anything that saves does so by the rule, not by luck. */
const LONG_AGO = () => new Date(Date.now() - 26 * HOUR_MS);

let POST_ID = '';

/** Teach the identity read what kind each account is. */
function setAccountKinds(kinds: Record<string, string>): void {
  hoisted.resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const map = new Map();
    for (const id of ids) {
      const kind = kinds[id];
      if (kind) map.set(id, { user: { id, kind } });
    }
    return map;
  });
}

/**
 * A published CHANNEL post: authored by the channel, written by the human.
 *
 * `writtenByOxyUserId` records who wrote it and is never revised, so it is not
 * what lets them edit it — the ACTIVE membership staged in `beforeEach` is. Both
 * are here because a correction is made by a current member who is also, in this
 * fixture, the original writer.
 */
async function seedChannelPost(overrides: Partial<PostRecordInput> = {}): Promise<void> {
  const record = await seedPost(scope, {
    oxyUserId: CHANNEL_ID,
    writtenByOxyUserId: WRITER_ID,
    status: 'published',
    createdAt: LONG_AGO(),
    content: { variants: [{ tag: 'en', source: 'author', text: 'as published' }] },
    ...overrides,
  });
  POST_ID = record.id;
}

/** The same post, authored by a person — the control for every channel case. */
async function seedPersonalPost(overrides: Partial<PostRecordInput> = {}): Promise<void> {
  const record = await seedPost(scope, {
    oxyUserId: PERSON_ID,
    status: 'published',
    createdAt: LONG_AGO(),
    content: { variants: [{ tag: 'en', source: 'author', text: 'as published' }] },
    ...overrides,
  });
  POST_ID = record.id;
}

async function storedText(): Promise<string | undefined> {
  return (await readPost(POST_ID))?.content.variants?.[0]?.text;
}

async function storedSummary(): Promise<{ correctionCount: number; lastCorrectedAt: Date | null }> {
  const post = await readPost(POST_ID);
  return {
    correctionCount: post?.correctionCount ?? -1,
    lastCorrectedAt: post?.lastCorrectedAt ?? null,
  };
}

function buildRequest(body: Record<string, unknown>, userId: string) {
  return {
    params: { id: POST_ID },
    query: {},
    headers: {},
    acceptsLanguages: () => [] as string[],
    body,
    user: { id: userId },
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
  // Oxy still names the writer as an active member, which is what admits them to
  // this route at all — see the mock of `createUserScopedOxyServices` above. The
  // departed-writer half is `channelPostManagementAuthority`'s subject, not this
  // file's; here it is a precondition so the correction rules can be the subject.
  hoisted.listAccountMembers.mockResolvedValue([{ memberUserId: WRITER_ID, status: 'active' }]);
  setAccountKinds({ [CHANNEL_ID]: 'channel', [PERSON_ID]: 'personal', [WRITER_ID]: 'personal' });
});

afterEach(async () => {
  await clearServiceScope(scope);
});

describe('the edit window', () => {
  it('does NOT bind a channel post — a publication corrects what it published', async () => {
    await seedChannelPost();
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'corrected a day later' } }, WRITER_ID) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(await storedText()).toBe('corrected a day later');
  });

  it('STILL binds a personal post — that rule exists for a different reason', async () => {
    await seedPersonalPost();
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'rewritten a day later' } }, PERSON_ID) as never, res as never);

    expect(captured.status).toBe(403);
    expect(await storedText()).toBe('as published');
  });

  it('binds a personal post whose author cannot be resolved at all', async () => {
    // `isChannelAccount` fails SOFT to false, and here that means the window
    // APPLIES: during an identity outage a late edit is refused rather than
    // allowed. Refusing an edit is the recoverable direction; allowing an
    // unbounded rewrite is not.
    await seedPersonalPost();
    hoisted.resolveUserSummaries.mockRejectedValue(new Error('Oxy is down'));
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'rewritten during an outage' } }, PERSON_ID) as never, res as never);

    expect(captured.status).toBe(403);
    expect(await storedText()).toBe('as published');
  });

  it('still lets a personal post be fixed INSIDE its window', async () => {
    await seedPersonalPost({ createdAt: new Date(Date.now() - 60_000) });
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'quick typo fix' } }, PERSON_ID) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(await storedText()).toBe('quick typo fix');
  });
});

describe('the correction trail', () => {
  it('records what a channel post said before, and counts it', async () => {
    await seedChannelPost();
    const { res } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'corrected' } }, WRITER_ID) as never, res as never);

    const trail = await listPostCorrections(POST_ID);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ revision: 1, previousText: 'as published' });

    const summary = await storedSummary();
    expect(summary.correctionCount).toBe(1);
    expect(summary.lastCorrectedAt).toBeInstanceOf(Date);
  });

  it('accumulates one entry per correction, oldest first', async () => {
    await seedChannelPost();

    await updatePost(buildRequest({ content: { text: 'second' } }, WRITER_ID) as never, buildResponse().res as never);
    await updatePost(buildRequest({ content: { text: 'third' } }, WRITER_ID) as never, buildResponse().res as never);

    expect((await listPostCorrections(POST_ID)).map((entry) => entry.previousText)).toEqual([
      'as published',
      'second',
    ]);
    expect(await storedText()).toBe('third');
    expect((await storedSummary()).correctionCount).toBe(2);
  });

  it('records NOTHING when the save changes no body', async () => {
    // The control that stops this becoming "every save is a correction". A save
    // that leaves the text alone is not a correction, and `isEdited` has never
    // counted one either.
    await seedChannelPost();
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'as published' } }, WRITER_ID) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(await listPostCorrections(POST_ID)).toEqual([]);
    expect((await storedSummary()).correctionCount).toBe(0);
  });

  it('records NOTHING for a personal post edited inside its window', async () => {
    // The trail is scoped to publications. A personal post's window is a grace
    // period whose whole premise is that the change lands before the post has
    // really been read; attaching a permanent public history to it would change
    // that bargain.
    await seedPersonalPost({ createdAt: new Date(Date.now() - 60_000) });
    const { res } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'quick typo fix' } }, PERSON_ID) as never, res as never);

    expect(await storedText()).toBe('quick typo fix');
    expect(await listPostCorrections(POST_ID)).toEqual([]);
    expect((await storedSummary()).correctionCount).toBe(0);
  });

  it('is what GET /posts/:id/corrections serves, oldest first', async () => {
    await seedChannelPost();
    await updatePost(buildRequest({ content: { text: 'second' } }, WRITER_ID) as never, buildResponse().res as never);
    await updatePost(buildRequest({ content: { text: 'third' } }, WRITER_ID) as never, buildResponse().res as never);

    const { res, captured } = buildResponse();
    // Anonymous on purpose: a publication's corrections are addressed to whoever
    // read the post, and most of them are not signed in.
    await getPostCorrections({ params: { id: POST_ID }, query: {}, headers: {}, acceptsLanguages: () => [] } as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(captured.body).toEqual({
      postId: POST_ID,
      total: 2,
      corrections: [
        { revision: 1, previousText: 'as published', correctedAt: expect.any(String) },
        { revision: 2, previousText: 'second', correctedAt: expect.any(String) },
      ],
    });
  });

  it('404s the trail of a post this viewer may not read', async () => {
    // The ACL is the POST's, reused rather than restated: hydration dropping the
    // post is the whole condition. A second implementation of "may this viewer
    // see this post" would be a second answer, and the wrong one would serve
    // superseded bodies of a post the viewer was just refused.
    await seedChannelPost();
    await updatePost(buildRequest({ content: { text: 'corrected' } }, WRITER_ID) as never, buildResponse().res as never);
    hoisted.hydratePosts.mockImplementation(async () => []);

    const { res, captured } = buildResponse();
    await getPostCorrections({ params: { id: POST_ID }, query: {}, headers: {}, acceptsLanguages: () => [] } as never, res as never);

    expect(captured.status).toBe(404);
    expect(captured.body).toEqual({ message: 'Post not available' });
  });

  it('404s a post that does not exist', async () => {
    const { res, captured } = buildResponse();
    await getPostCorrections(
      { params: { id: 'no-such-post-id' }, query: {}, headers: {}, acceptsLanguages: () => [] } as never,
      res as never,
    );

    expect(captured.status).toBe(404);
    expect(captured.body).toEqual({ message: 'Post not found' });
  });

  it('reports corrections MADE even when older versions are no longer retained', async () => {
    // The fixture that tells `post.correctionCount` from `corrections.length`.
    // Every other case here has as many rows as corrections, so both readings
    // agree on all of them and neither test could catch the substitution.
    //
    // This is the state retention leaves behind — a counter ahead of the rows —
    // staged directly rather than by making 50 real corrections, because what is
    // under test is which NUMBER the endpoint reports, not the eviction that
    // produced the gap (that is `db/postCorrectionsRepository.test.ts`).
    await seedChannelPost();
    await updatePost(buildRequest({ content: { text: 'corrected' } }, WRITER_ID) as never, buildResponse().res as never);
    await getDb().update(posts).set({ correctionCount: 87 }).where(eq(posts.id, POST_ID));

    const { res, captured } = buildResponse();
    await getPostCorrections({ params: { id: POST_ID }, query: {}, headers: {}, acceptsLanguages: () => [] } as never, res as never);

    expect(captured.body).toMatchObject({ total: 87 });
    // ...and the served rows really are fewer, so the two numbers are genuinely
    // different here rather than coincidentally equal.
    expect((captured.body as { corrections: unknown[] }).corrections).toHaveLength(1);
  });

  it('serves an empty trail for a post that was never corrected', async () => {
    await seedChannelPost();

    const { res, captured } = buildResponse();
    await getPostCorrections({ params: { id: POST_ID }, query: {}, headers: {}, acceptsLanguages: () => [] } as never, res as never);

    expect(captured.body).toEqual({ postId: POST_ID, total: 0, corrections: [] });
  });

  it('records NOTHING for a channel post nobody has read yet', async () => {
    // A scheduled post has not published. Rewriting it corrects nobody's
    // understanding of anything, so there is nothing to be accountable for.
    await seedChannelPost({
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 7 * 24 * HOUR_MS),
    });
    const { res, captured } = buildResponse();

    await updatePost(buildRequest({ content: { text: 'reworked before it goes out' } }, WRITER_ID) as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(await storedText()).toBe('reworked before it goes out');
    expect(await listPostCorrections(POST_ID)).toEqual([]);
    expect((await storedSummary()).correctionCount).toBe(0);
  });
});
