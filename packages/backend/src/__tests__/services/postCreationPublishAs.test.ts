import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountMember } from '@oxyhq/core';

/**
 * What `PostCreationService.create` DOES with the account it was told to publish
 * as — as distinct from whether it was allowed to, which is
 * `publishAsAccount.test.ts`.
 *
 * The rule that is easy to get wrong, and was: **`replyPermission: ['nobody']` is
 * keyed on the author being a CHANNEL, not on the post having been published as
 * somebody else.** "No replies, ever" is a property of channels — a newspaper, not
 * a group chat. An organization is an ordinary account: `utils/channelReplyGate`
 * reads the author's kind and lets replies through for one, so forcing `['nobody']`
 * on its posts would leave the persisted field and the server's own rule
 * disagreeing, and would silently close every organization's comments with no
 * setting anywhere to reopen them.
 *
 * ## What the Postgres port changed
 *
 * The suite this replaces swapped `models/Post` for a fake class and asserted on
 * the object handed to its constructor. That answered "was a document BUILT with
 * these fields?", which is a different question from "is that what the database
 * now holds" — it cannot see a column the writer forgot to map, and `lane_id` and
 * `channel_id` were silently never written for exactly that reason (see
 * `db/posts/postRecord.ts`). `create` now builds a `PostRecordInput` literal and
 * calls `insertPostRecord`, so every case below reads the STORED row back with
 * {@link readPost} and asserts on that.
 *
 * `postRecordInput` is still an explicit WHITELIST, so each of these fields is
 * written or not written by one line and a mistake there is silent — which is
 * what makes a round-trip assertion the only shape that can catch it.
 *
 * One assertion changed wording and not subject: `writtenByOxyUserId` is a real
 * column, always present, so an ordinary post records the writer as `null` rather
 * than omitting the key. "This post names no writer" is the same fact.
 */

const resolveUserSummaries = vi.hoisted(() => vi.fn());
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
  resolveUserSummaries,
}));

vi.mock('../../services/PostRecentReplierService', () => ({
  recordRecentReplierForPost: vi.fn(async () => undefined),
}));
vi.mock('../../services/postEnrichment', () => ({ enrichIngestedPosts: vi.fn() }));
vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn(async () => undefined),
  emitRepostCreated: vi.fn(async () => undefined),
}));

vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: vi.fn(() => ({})) }));
vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));
vi.mock('../../services/MediaMetadataService', () => ({
  mediaMetadataService: { enrichFromOxy: vi.fn(async (media: unknown[]) => media) },
  readPersistedMediaFields: vi.fn(() => ({})),
}));

import { PostType, PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { deletePostRecord } from '../../db/posts/postRepository';
import type { PostRecord } from '../../db/posts/postRecord';
import { clearServiceScope, readPost, readScopePosts, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { postCreationService } from '../../services/PostCreationService';
import { PublishAsAccessError } from '../../services/publishAsAccount';

const scope = serviceScope('post-creation-publish-as');

const WRITER = scope.user('writer');
const CHANNEL = scope.user('channel');
const ORGANIZATION = scope.user('org');
const SECOND_ORG = scope.user('org-2');
const SOMEONE_ELSE = scope.user('someone-else');

/**
 * The threads the two exceptions verify against — real rows, seeded once.
 *
 * They are seeded ONCE rather than per case because both checks read exactly two
 * ids (`inArray(posts.id, [parent, root])`), so a row no case names cannot
 * influence its answer. `ABSENT_*` is deliberately never seeded: a claim naming
 * ids with no rows behind them is what a fabricated claim looks like.
 */
const OWN_ROOT = 'pcpa-own-root';
const OWN_CONTINUATION = 'pcpa-own-continuation';
const STRANGERS_POST = 'pcpa-strangers-post';
const ORG_ROOT = 'pcpa-org-root';
const CHANNEL_ROOT = 'pcpa-channel-root';
const ABSENT_ROOT = 'pcpa-absent-root';

/** Ids of the seeded fixtures, so "nothing was written" can exclude them. */
const fixtureIds = new Set<string>();

async function seedRow(id: string, oxyUserId: string, threadId: string): Promise<void> {
  await seedPost(scope, {
    id,
    oxyUserId,
    authorship: [{ oxyUserId, role: 'owner', status: 'accepted' }],
    threadId,
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: id, tag: 'en' }] },
  });
  fixtureIds.add(id);
}

/**
 * The rows the CODE UNDER TEST wrote — the seeded thread fixtures removed.
 *
 * Read from the table rather than counted at the writer, because "the refusal
 * came before anything was written" is a claim about the database. Every account
 * this suite uses is namespaced, so this sees this file's rows and no other's.
 */
async function writtenPosts(): Promise<Array<{ id: string }>> {
  return (await readScopePosts(scope)).filter((row) => !fixtureIds.has(row.id));
}

const ACT_AS_PERMISSIONS = ['account:read', 'account:act_as', 'members:read'];
const NO_ACT_AS_PERMISSIONS = ['account:read', 'members:read'];

function memberRow(permissions: string[]): AccountMember {
  return {
    _id: 'member-row',
    accountId: 'account',
    memberUserId: WRITER,
    role: 'editor',
    permissions,
    inherit: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const memberReader = {
  listAccountMembers: vi.fn(async (accountId: string) =>
    // A channel member with NO act_as, so the channel cases also prove the
    // permission is not being demanded where it cannot exist.
    accountId === CHANNEL ? [memberRow(NO_ACT_AS_PERMISSIONS)] : [memberRow(ACT_AS_PERMISSIONS)],
  ),
};

beforeAll(async () => {
  await connectPostgres();
  await clearServiceScope(scope);

  // The channel's own thread, plus a post of somebody else's for the claims that
  // must fail.
  await seedRow(OWN_ROOT, CHANNEL, OWN_ROOT);
  await seedRow(OWN_CONTINUATION, CHANNEL, OWN_ROOT);
  await seedRow(STRANGERS_POST, SOMEONE_ELSE, STRANGERS_POST);
  // One organization's thread, and a channel's, for the second exception.
  await seedRow(ORG_ROOT, ORGANIZATION, ORG_ROOT);
  await seedRow(CHANNEL_ROOT, CHANNEL, CHANNEL_ROOT);
});

afterAll(async () => {
  await clearServiceScope(scope);
  await closePostgres();
});

beforeEach(() => {
  memberReader.listAccountMembers.mockClear();
  resolveUserSummaries.mockReset();
  resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const kinds: Record<string, string> = {
      [CHANNEL]: 'channel',
      [ORGANIZATION]: 'organization',
      [SECOND_ORG]: 'organization',
      [SOMEONE_ELSE]: 'personal',
    };
    const map = new Map<string, { user: { id: string; kind?: string; name: object } }>();
    for (const id of ids) {
      if (kinds[id]) map.set(id, { user: { id, kind: kinds[id], name: {} } });
    }
    return map;
  });
});

afterEach(async () => {
  // Only what a case created — the seeded threads outlive the whole file.
  for (const row of (await writtenPosts()).reverse()) {
    await deletePostRecord(row.id, undefined);
  }
});

describe('PostCreationService.create — publishing as another account', () => {
  it('authors the post as the CHANNEL and records the writer outside authorship', async () => {
    const created = await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'from the channel' },
      publishAsOxyUserId: CHANNEL,
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const stored = await readPost(created.id);
    expect(stored?.oxyUserId).toBe(CHANNEL);
    expect(stored?.writtenByOxyUserId).toBe(WRITER);
    expect(stored?.authorship).toEqual([expect.objectContaining({ oxyUserId: CHANNEL, role: 'owner' })]);
  });

  it('authors the post as the ORGANIZATION the same way', async () => {
    const created = await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'from the org' },
      publishAsOxyUserId: ORGANIZATION,
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const stored = await readPost(created.id);
    expect(stored?.oxyUserId).toBe(ORGANIZATION);
    expect(stored?.writtenByOxyUserId).toBe(WRITER);
    expect(stored?.authorship).toEqual([
      expect.objectContaining({ oxyUserId: ORGANIZATION, role: 'owner' }),
    ]);
  });

  it('forces replyPermission ["nobody"] on a CHANNEL post, over whatever was asked for', async () => {
    const created = await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'from the channel' },
      publishAsOxyUserId: CHANNEL,
      replyPermission: ['anyone'],
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    expect((await readPost(created.id))?.replyPermission).toEqual(['nobody']);
  });

  /**
   * The regression this suite exists for. Keyed on "published as somebody" rather
   * than on the author's kind, this comes back `['nobody']` — an organization that
   * can never be replied to, with no setting anywhere that reopens it, while
   * `channelReplyGate` happily admits the replies the client has stopped offering.
   */
  it('does NOT force ["nobody"] on an ORGANIZATION post — it is an ordinary post', async () => {
    const created = await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'from the org' },
      publishAsOxyUserId: ORGANIZATION,
      replyPermission: ['anyone'],
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    expect((await readPost(created.id))?.replyPermission).toEqual(['anyone']);
  });

  it('honours a NARROWER replyPermission on an organization post too', async () => {
    const created = await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'from the org' },
      publishAsOxyUserId: ORGANIZATION,
      replyPermission: ['followers'],
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    expect((await readPost(created.id))?.replyPermission).toEqual(['followers']);
  });

  it('defaults an organization post to ["anyone"], like any other post', async () => {
    const created = await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'from the org' },
      publishAsOxyUserId: ORGANIZATION,
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    expect((await readPost(created.id))?.replyPermission).toEqual(['anyone']);
  });

  it('CONTROL: an ordinary post is unaffected and records no writer', async () => {
    const created = await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'just me' },
      replyPermission: ['anyone'],
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const stored = await readPost(created.id);
    expect(stored?.oxyUserId).toBe(WRITER);
    expect(stored?.replyPermission).toEqual(['anyone']);
    // The column is always there; NULL is how "nobody else wrote this" is stored.
    expect(stored?.writtenByOxyUserId).toBeNull();
  });

  it('refuses an account the caller may not act as, BEFORE writing anything', async () => {
    memberReader.listAccountMembers.mockResolvedValueOnce([memberRow(NO_ACT_AS_PERMISSIONS)]);

    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'not mine to sign' },
        publishAsOxyUserId: ORGANIZATION,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);

    expect(await writtenPosts()).toHaveLength(0);
  });

  it('still refuses a reply, a boost and a federated ingest', async () => {
    for (const extra of [
      { parentPostId: OWN_ROOT },
      { boostOf: STRANGERS_POST },
      { federation: { activityId: 'https://remote/1' } },
    ]) {
      await expect(
        postCreationService.create({
          oxyUserId: WRITER,
          content: { text: 'x' },
          publishAsOxyUserId: ORGANIZATION,
          memberReader,
          skipNotifications: true,
          ...extra,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }

    expect(await writtenPosts()).toHaveLength(0);
  });
});

/**
 * The narrow exception, at the layer that owns it.
 *
 * `continuesOwnThread` is a SERVICE parameter — `POST /posts` builds its params
 * from an explicit body whitelist and never names it, so no request can ask for
 * it (asserted separately in `postsControllerChannelReply.test.ts`). What these
 * pin is that the parameter grants nothing by itself: every case below sets it,
 * and only the genuine continuation is written.
 */
describe('PostCreationService.create — continuing the account\'s own thread', () => {
  it('writes a continuation of the channel\'s own thread, authored by the channel', async () => {
    const created = await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'part two' },
      publishAsOxyUserId: CHANNEL,
      parentPostId: OWN_ROOT,
      threadId: OWN_ROOT,
      continuesOwnThread: true,
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const stored = await readPost(created.id);
    expect(stored?.oxyUserId).toBe(CHANNEL);
    expect(stored?.parentPostId).toBe(OWN_ROOT);
    expect(stored?.writtenByOxyUserId).toBe(WRITER);
    // Still a channel post, so still unrepliable by anybody else — the exception
    // is about who may WRITE the continuation, never about who may answer it.
    expect(stored?.replyPermission).toEqual(['nobody']);
  });

  it('writes a continuation deeper in the chain too', async () => {
    const created = await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'part three' },
      publishAsOxyUserId: CHANNEL,
      parentPostId: OWN_CONTINUATION,
      threadId: OWN_ROOT,
      continuesOwnThread: true,
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    expect((await readPost(created.id))?.oxyUserId).toBe(CHANNEL);
  });

  /**
   * MUTATION GUARD. The exception must be the VERIFIED continuation and nothing
   * else. Replace `assertContinuesOwnThread` with "the author may act for the
   * parent's account" — the wider rule that reads as the same thing — and this
   * passes, which is a channel's replies reopened to everybody who operates it.
   */
  it('MUTATION GUARD: refuses a claimed continuation of SOMEBODY ELSE\'S post', async () => {
    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'not a continuation' },
        publishAsOxyUserId: CHANNEL,
        parentPostId: STRANGERS_POST,
        threadId: STRANGERS_POST,
        continuesOwnThread: true,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(await writtenPosts()).toHaveLength(0);
  });

  it('MUTATION GUARD: refuses a continuation claimed for a thread that does not exist', async () => {
    // `ABSENT_ROOT` names no row — which is what a fabricated claim looks like.
    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'invented thread' },
        publishAsOxyUserId: CHANNEL,
        parentPostId: ABSENT_ROOT,
        threadId: ABSENT_ROOT,
        continuesOwnThread: true,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(await writtenPosts()).toHaveLength(0);
  });

  it('CONTROL: the flag changes nothing for a reply that does not carry an account', async () => {
    const created = await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'an ordinary reply' },
      parentPostId: STRANGERS_POST,
      threadId: STRANGERS_POST,
      continuesOwnThread: true,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    // No account named ⇒ no publish-as gate, no continuation check, and the reply
    // is the writer's own exactly as before.
    expect((await readPost(created.id))?.oxyUserId).toBe(WRITER);
  });

  it('CONTROL: WITHOUT the flag, a reply naming an account is still refused', async () => {
    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'part two, but unmarked' },
        publishAsOxyUserId: CHANNEL,
        parentPostId: OWN_ROOT,
        threadId: OWN_ROOT,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(await writtenPosts()).toHaveLength(0);
  });
});

/**
 * The SECOND exception at the service layer — `answersOperatedAccount`.
 *
 * Same discipline as `continuesOwnThread` above: the parameter grants nothing.
 * Every case here sets it, and only the ones that survive
 * `assertAnswersOperatedAccount`'s verification are written. Without these
 * the whole wiring is untested — mutation-testing found the branch could be
 * deleted outright with the suite still green.
 */
describe('PostCreationService.create — one operated account answering another', () => {
  it('writes an organization\'s answer to another organization\'s post', async () => {
    const created: PostRecord = await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'B answers A' },
      publishAsOxyUserId: SECOND_ORG,
      parentPostId: ORG_ROOT,
      threadId: ORG_ROOT,
      answersOperatedAccount: true,
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const stored = await readPost(created.id);
    expect(stored?.oxyUserId).toBe(SECOND_ORG);
    expect(stored?.parentPostId).toBe(ORG_ROOT);
    // An organization's post is ordinary in every other respect — replies
    // included. Only a channel forces `['nobody']`.
    expect(stored?.replyPermission).toEqual(['anyone']);
  });

  /**
   * MUTATION GUARD. The parent belongs to a CHANNEL, and the publisher is an
   * organization the caller may act for — so every condition except the channel
   * one is satisfied. Accepting `answersOperatedAccount` without running the
   * verification writes this post, and what it writes is a reply to a channel.
   */
  it('MUTATION GUARD: refuses an organization answering a CHANNEL\'s post', async () => {
    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'answering the channel' },
        publishAsOxyUserId: SECOND_ORG,
        parentPostId: CHANNEL_ROOT,
        threadId: CHANNEL_ROOT,
        answersOperatedAccount: true,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(await writtenPosts()).toHaveLength(0);
  });

  /**
   * MUTATION GUARD, the other end. Here the parent is a fine organization and the
   * CHANNEL is doing the answering — refused by the publishing-account half of the
   * boundary, which a parent-only check would miss.
   */
  it('MUTATION GUARD: refuses a CHANNEL answering an organization\'s post', async () => {
    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'the channel answers' },
        publishAsOxyUserId: CHANNEL,
        parentPostId: ORG_ROOT,
        threadId: ORG_ROOT,
        answersOperatedAccount: true,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(await writtenPosts()).toHaveLength(0);
  });

  it('refuses a claimed answer to a thread that does not exist', async () => {
    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'invented' },
        publishAsOxyUserId: SECOND_ORG,
        parentPostId: ABSENT_ROOT,
        threadId: ABSENT_ROOT,
        answersOperatedAccount: true,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(await writtenPosts()).toHaveLength(0);
  });

  it('CONTROL: WITHOUT either flag, the same reply is refused', async () => {
    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'unmarked' },
        publishAsOxyUserId: SECOND_ORG,
        parentPostId: ORG_ROOT,
        threadId: ORG_ROOT,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(await writtenPosts()).toHaveLength(0);
  });
});
