import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AN EDIT IS A WRITE BOUNDARY TOO.
 *
 * A profile link the author pastes while EDITING has to become a mention on the
 * same terms as one pasted while composing — otherwise "paste a profile link,
 * get a mention" would be a rule with a hole in it that only shows up on the
 * second save, and the two paths would drift the moment either is touched.
 *
 * These pin the edit half at the real controller: the resolved id lands in the
 * post's stored `mentions`, and the body it saves carries the placeholder.
 *
 * ## Real rows, and the `markModified` assertion is GONE on purpose
 *
 * This suite mocked `models/Post` and handed `updatePost` a document double with
 * `save()` and `markModified()` spies. Both are inert now: `updatePost` reads
 * through `loadPostRecord` and writes through `replacePostContent`, so the
 * mocked model intercepted nothing and every case died on the 500 that came back
 * from a controller talking to a database the suite never connected — not on the
 * mention conversion it is about.
 *
 * `markModified('content')` is not a property that survived the port, and
 * asserting it would now be asserting a Mongoose mechanism rather than a rule.
 * The reason it mattered is preserved and is STRONGER here: Mongoose could write
 * the mention allowlist while silently dropping the body rewrite it depends on,
 * leaving a stored id with no placeholder behind it. Reading the row back asserts
 * exactly that pairing landed — `mentions` lives in `post_mentions` and the body
 * in `post_contents`, so a fold that reached one table and not the other fails
 * here. `posts.controller` writes the whole `content` column back rather than a
 * tracked subtree, which is why no `markModified` equivalent exists to call.
 *
 * Same seams as the sibling `controllers/profileLinkMentionReply.test.ts`: the
 * local-handle lookup (`resolveOxyUser`) and the stored-actor repository are
 * stubbed, since profile-link resolution has to be answerable without network or
 * Oxy I/O — everything else about the fold is the real code.
 */

const hoisted = vi.hoisted(() => ({
  isBlockedDomain: vi.fn((_host: string) => false),
  resolveOxyUser: vi.fn(),
  findActorByUri: vi.fn(),
  findActorByAcct: vi.fn(),
}));

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (rows: unknown[]) => rows) },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown user' } }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  createUserScopedOxyServices: vi.fn(() => undefined),
  getServiceOxyClient: vi.fn(() => ({})),
}));

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn().mockResolvedValue(undefined),
  emitRepostCreated: vi.fn().mockResolvedValue(undefined),
  emitTombstone: vi.fn(),
  postRecordUri: () => 'at://test',
  repostRecordUri: () => 'at://test',
}));

vi.mock('../../connectors/outboundFederation', () => ({
  federateAsResolvedActor: vi.fn(),
}));

// PARTIAL: the controller pulls the whole connector graph in, and `actor.service`
// reads `FEDERATION_ENABLED` off this module at import time — a bare object mock
// drops it and the suite fails to LOAD rather than to assert.
vi.mock('../../connectors/activitypub/constants', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isBlockedDomain: hoisted.isBlockedDomain,
  resolveOxyUser: hoisted.resolveOxyUser,
}));

// PARTIAL, and only the two point lookups `resolveProfileLinkIdentity` spends on
// a foreign profile link (uri first, then acct). Everything else the connector
// graph reads from this repository stays real, against the same database the
// posts are written to.
vi.mock('../../db/federation/actorRepository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/federation/actorRepository')>()),
  findActorByUri: hoisted.findActorByUri,
  findActorByAcct: hoisted.findActorByAcct,
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { updatePost } from '../../controllers/posts.controller';

const scope = serviceScope('profile-link-mention-edit');

const OWN_HOST = 'mention.earth';
const USER_ID = scope.user('author');
const ALICE_OXY_ID = scope.user('alice-local');

function buildRequest(postId: string, body: Record<string, unknown>) {
  return {
    params: { id: postId },
    query: {},
    headers: {},
    acceptsLanguages: () => [] as string[],
    body,
    user: { id: USER_ID },
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

/** The stored body and allowlist, which is what the handler is judged on. */
async function stored(postId: string): Promise<{ mentions: string[]; text: string }> {
  const row = await readPost(postId);
  return {
    mentions: row?.mentions ?? [],
    text: row?.content.variants?.[0]?.text ?? '',
  };
}

/** A freshly published post, well inside the 30-minute edit window. */
async function publishedPost(text: string, mentions: string[] = []) {
  return seedPost(scope, {
    oxyUserId: USER_ID,
    content: { variants: [{ source: 'author', text, tag: 'en' }] },
    mentions,
  });
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.isBlockedDomain.mockImplementation(
    (host: string) => host.toLowerCase().replace(/^www\./, '') === OWN_HOST,
  );
  hoisted.resolveOxyUser.mockImplementation(async (username: string) =>
    username === 'alice' ? { _id: ALICE_OXY_ID } : null,
  );
  hoisted.findActorByUri.mockResolvedValue(null);
  hoisted.findActorByAcct.mockResolvedValue(null);
});

describe('updatePost — a profile link pasted while editing becomes a mention', () => {
  it('stores the id and rewrites the saved body to the placeholder', async () => {
    const post = await publishedPost('nothing here yet');
    const { res, captured } = buildResponse();

    await updatePost(
      buildRequest(post.id, { content: { text: `now ask https://${OWN_HOST}/@alice` } }) as never,
      res as never,
    );

    expect(captured.status).toBeUndefined();
    // BOTH halves, from the two tables they live in: an id stored without the
    // placeholder behind it is what the old `markModified` assertion existed to
    // prevent, and hydration renders it as nothing.
    expect(await stored(post.id)).toEqual({
      text: `now ask [mention:${ALICE_OXY_ID}]`,
      mentions: [ALICE_OXY_ID],
    });
  });

  it('leaves a link it cannot resolve alone, and mentions nobody', async () => {
    const post = await publishedPost('nothing here yet');
    const { res } = buildResponse();

    await updatePost(
      buildRequest(post.id, { content: { text: 'see https://mastodon.social/@a-stranger' } }) as never,
      res as never,
    );

    expect(await stored(post.id)).toEqual({
      text: 'see https://mastodon.social/@a-stranger',
      mentions: [],
    });
  });

  it('drops a mention whose link the author REMOVED in the same edit', async () => {
    // The id was authorized by the previous save; the body no longer names her,
    // so reconciliation — which intersects the allowlist with the placeholders
    // actually present — must not carry it forward.
    const post = await publishedPost(`bye [mention:${ALICE_OXY_ID}]`, [ALICE_OXY_ID]);
    const { res } = buildResponse();

    await updatePost(
      buildRequest(post.id, { content: { text: 'never mind' } }) as never,
      res as never,
    );

    expect(await stored(post.id)).toEqual({ text: 'never mind', mentions: [] });
  });
});
