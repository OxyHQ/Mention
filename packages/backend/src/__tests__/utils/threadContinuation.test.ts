import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `assertContinuesOwnThread` — the ONE exception to "a post published as another
 * account may not be a reply".
 *
 * The distinction every case here exists to draw is between **an account
 * continuing its own text** and **an account being used to hold a conversation**.
 * The second is what `utils/channelReplyGate` refuses at five write sites, in its
 * own words with "no exception for the writer, and none for the channel's owner"
 * — so an exception that cannot tell the two apart is not a narrower rule, it is
 * that gate switched off for anybody who operates the account.
 *
 * Three structural conditions, all read back from the database:
 *   1. the parent is authored by the SAME account,
 *   2. the parent is in the thread this post declares,
 *   3. that thread's ROOT is authored by that same account.
 *
 * Each has its own failing fixture below, because a check nothing can fail is a
 * check that is not there. Every refusal fixture is built so it fails on EXACTLY
 * the condition it names and satisfies the others — an earlier version of this
 * suite was green with a condition deleted, because every fixture happened to
 * fail a second one too.
 *
 * ## What the Postgres port changed
 *
 * The rows are REAL. The suite this replaces mocked `Post.find` and handed back
 * whatever array the test had just written down, so it could not tell a correct
 * query from one that silently matches nothing — and the module's whole job is
 * reading three facts back out of storage. Both functions now issue one
 * `inArray(posts.id, [parent, root])` read, so the fixtures are rows in the
 * `posts` table and the assertions are about what that query finds.
 *
 * The rows are seeded ONCE and shared, which is safe precisely because the read
 * names exactly two ids: a row no case names cannot influence its answer. Each
 * case therefore names the pair that isolates its own condition, rather than
 * rewriting a whole collection.
 *
 * Two behaviours genuinely changed with the port, and both are marked at their
 * own cases below: `ObjectId.isValid` is gone (see `@oxyhq/db`), so a malformed
 * id is no longer refused one branch EARLY — it names no row and is refused by
 * the same condition an unknown id always was.
 */

import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * `getDb`, counted.
 *
 * The real connection, wrapped — several cases assert the assertion refuses
 * WITHOUT asking the database anything, which is a property of the guard order
 * and is worth keeping now that the query is real. A stub would answer the
 * question "was a query built"; this answers "was the database reached", which
 * is what those cases have always been about.
 */
const dbReads = vi.hoisted(() => vi.fn());
vi.mock('../../db/postgres', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/postgres')>();
  return {
    ...actual,
    getDb: () => {
      dbReads();
      return actual.getDb();
    },
  };
});

const resolveUserSummaries = vi.hoisted(() => vi.fn(async () => new Map()));

// The identity path behind account KINDS. The real `publishAsAccount` is used
// throughout — the second case's condition 4 delegates to its authorization gate,
// and stubbing that would leave the delegation untested.
vi.mock('../../services/PostHydrationService', () => ({ resolveUserSummaries }));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import {
  assertAnswersOperatedAccount,
  assertContinuesOwnThread,
} from '../../utils/threadContinuation';
import { PublishAsAccessError } from '../../services/publishAsAccount';
import type { AccountMember } from '@oxyhq/core';

const scope = serviceScope('thread-continuation');

const CHANNEL = scope.user('channel');
const OPERATOR = scope.user('operator');
const OTHER_ACCOUNT = scope.user('org');
const STRANGER = scope.user('stranger');
const ORG_A = scope.user('org-a');
const ORG_B = scope.user('org-b');
/** An account Oxy answers nothing about — never present in a `kindsAre` map. */
const UNRESOLVABLE = scope.user('unresolvable');

/**
 * Post ids, spelled out rather than minted.
 *
 * They were `new mongoose.Types.ObjectId().toString()` and there is nothing left
 * that cares: `posts.id` is `text` holding a 24-char ObjectId hex for a
 * pre-cutover row and a uuid v7 for a new one, and no shape check survives
 * anywhere (`@oxyhq/db`). What DOES still matter is that they are unique across
 * the whole run — one database serves every file in parallel and this is a
 * primary key — hence the per-suite prefix.
 */
const ROOT = 'threadcont-root';
const CONTINUATION_1 = 'threadcont-continuation-1';
const FOREIGN_POST = 'threadcont-foreign-post';
const FOREIGN_ROOT = 'threadcont-foreign-root';
const OTHER_ROOT = 'threadcont-other-root';
const STRANGERS_REPLY = 'threadcont-strangers-reply';
const GRAFTED = 'threadcont-grafted';
const NO_SUCH_POST = 'threadcont-no-such-post';

const A_ROOT = 'threadans-a-root';
const A_SECOND = 'threadans-a-second';
const B_SECOND = 'threadans-b-second';
const CALLER_ROOT = 'threadans-caller-root';
const CHANNEL_ROOT = 'threadans-channel-root';
const IN_CHANNEL_THREAD = 'threadans-in-channel-thread';
const ELSEWHERE = 'threadans-elsewhere';
const UNKNOWN_ROOT = 'threadans-unknown-root';
const IN_UNKNOWN_THREAD = 'threadans-in-unknown-thread';

/**
 * One stored post: an id, an author and the thread it belongs to.
 *
 * Nothing else is read by either function under test, so nothing else is stated.
 * A ROOT anchors the thread on its own id — the same self-anchor `createThread`
 * writes — and `thread_id` is a real foreign key, so a row must be seeded after
 * the root it names.
 */
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
}

beforeAll(async () => {
  await connectPostgres();
  await clearServiceScope(scope);

  // --- assertContinuesOwnThread ---
  // The channel's own thread: a root and one continuation anchored on it.
  await seedRow(ROOT, CHANNEL, ROOT);
  await seedRow(CONTINUATION_1, CHANNEL, ROOT);
  // Somebody else's thread, its root and a post of theirs inside it.
  await seedRow(FOREIGN_ROOT, OTHER_ACCOUNT, FOREIGN_ROOT);
  await seedRow(FOREIGN_POST, OTHER_ACCOUNT, FOREIGN_ROOT);
  // A THIRD PARTY's reply sitting inside that same thread — the fixture that
  // isolates condition 1, since conditions 2 and 3 both pass for it.
  await seedRow(STRANGERS_REPLY, STRANGER, FOREIGN_ROOT);
  // The channel's own post, grafted onto somebody else's thread — isolates
  // condition 3, since 1 and 2 both pass.
  await seedRow(GRAFTED, CHANNEL, FOREIGN_ROOT);
  // A second thread of the channel's, so a real parent and a real thread of the
  // same account can still fail to belong together — isolates condition 2.
  await seedRow(OTHER_ROOT, CHANNEL, OTHER_ROOT);

  // --- assertAnswersOperatedAccount ---
  await seedRow(A_ROOT, ORG_A, A_ROOT);
  await seedRow(A_SECOND, ORG_A, A_ROOT);
  await seedRow(B_SECOND, ORG_B, A_ROOT);
  await seedRow(CALLER_ROOT, OPERATOR, CALLER_ROOT);
  await seedRow(CHANNEL_ROOT, CHANNEL, CHANNEL_ROOT);
  await seedRow(IN_CHANNEL_THREAD, ORG_A, CHANNEL_ROOT);
  await seedRow(ELSEWHERE, ORG_A, ELSEWHERE);
  await seedRow(UNKNOWN_ROOT, UNRESOLVABLE, UNKNOWN_ROOT);
  await seedRow(IN_UNKNOWN_THREAD, ORG_A, UNKNOWN_ROOT);
});

afterAll(async () => {
  await clearServiceScope(scope);
  await closePostgres();
});

beforeEach(() => {
  // The seed above reached the database; the counter belongs to the case.
  dbReads.mockClear();
});

describe('assertContinuesOwnThread — what it ADMITS', () => {
  it('admits the first continuation, whose parent IS the root', async () => {
    await expect(
      assertContinuesOwnThread({ parentPostId: ROOT, threadId: ROOT, authorId: CHANNEL }),
    ).resolves.toBeUndefined();
    // The vacuity floor for every `expect(dbReads).not.toHaveBeenCalled()` below:
    // a counter that never increments would let all of them pass while measuring
    // nothing, which is exactly the shape those assertions exist to rule out.
    expect(dbReads).toHaveBeenCalled();
  });

  it('admits a later link, whose parent is anchored on the root', async () => {
    await expect(
      assertContinuesOwnThread({ parentPostId: CONTINUATION_1, threadId: ROOT, authorId: CHANNEL }),
    ).resolves.toBeUndefined();
  });
});

describe('assertContinuesOwnThread — what it REFUSES', () => {
  /**
   * CONDITION 1. The parent is somebody else's post. This is the plain "reply to
   * another account as my account" case, which is what the gate is for.
   */
  it('refuses a parent authored by another account', async () => {
    await expect(
      assertContinuesOwnThread({
        parentPostId: FOREIGN_POST,
        threadId: FOREIGN_ROOT,
        authorId: CHANNEL,
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  /**
   * CONDITION 1, ISOLATED — and the case that made it worth having.
   *
   * The fixture is a THIRD PARTY's reply sitting inside the account's own thread.
   * Conditions 2 and 3 both pass (the post really is in the thread, and the
   * account really did start it), so this is the ONLY shape that tells condition 1
   * apart from its absence — mutation-testing found the suite green without it,
   * because every other refusal fixture failed condition 3 as well.
   *
   * It is reachable, not hypothetical: an ORGANIZATION's posts take replies like
   * anybody's, so strangers' posts genuinely do end up under an organization's
   * thread root. Answering one, as the organization, is a conversation held under
   * the account's name — exactly what the exception must not become.
   */
  it('refuses a THIRD PARTY\'s post that sits inside the account\'s own thread', async () => {
    await expect(
      assertContinuesOwnThread({
        parentPostId: STRANGERS_REPLY,
        threadId: FOREIGN_ROOT,
        authorId: OTHER_ACCOUNT,
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  /**
   * CONDITION 2. Parent and declared thread are both the account's own, and they
   * still do not belong together — a client naming a real post of the account and
   * a real thread of the account, hoping the pair is not checked.
   */
  it('refuses a parent that is not in the declared thread', async () => {
    await expect(
      assertContinuesOwnThread({ parentPostId: ROOT, threadId: OTHER_ROOT, authorId: CHANNEL }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  /**
   * CONDITION 3. The parent IS the account's own post and it IS in the declared
   * thread — but the account did not start that thread; it was grafted onto
   * somebody else's. Without this condition an account that once replied
   * somewhere could keep answering in that conversation forever.
   */
  it('refuses a thread the account did not start, even with its own parent in it', async () => {
    await expect(
      assertContinuesOwnThread({ parentPostId: GRAFTED, threadId: FOREIGN_ROOT, authorId: CHANNEL }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  /**
   * THE MUTATION THE WHOLE MODULE EXISTS FOR, at its own layer. An OPERATOR of the
   * channel is not the channel: the exception is about a post continuing itself,
   * never about who is allowed to speak for the account. Widening condition 1 from
   * "the parent is this account's own post" to "the author may act for the
   * parent's account" makes this pass, and that is the channel's replies reopened
   * to its operators.
   */
  it('MUTATION GUARD: refuses when the AUTHOR is the operator rather than the account', async () => {
    await expect(
      assertContinuesOwnThread({ parentPostId: ROOT, threadId: ROOT, authorId: OPERATOR }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  it('refuses a parent that does not exist', async () => {
    await expect(
      assertContinuesOwnThread({ parentPostId: NO_SUCH_POST, threadId: ROOT, authorId: CHANNEL }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  it('refuses a thread root that does not exist', async () => {
    await expect(
      assertContinuesOwnThread({ parentPostId: ROOT, threadId: NO_SUCH_POST, authorId: CHANNEL }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  it.each([
    ['no threadId', { parentPostId: ROOT, threadId: null, authorId: CHANNEL }],
    ['no parentPostId', { parentPostId: null, threadId: ROOT, authorId: CHANNEL }],
    ['no author', { parentPostId: ROOT, threadId: ROOT, authorId: null }],
  ])('refuses with %s, and asks the database nothing', async (_label, args) => {
    await expect(assertContinuesOwnThread(args)).rejects.toBeInstanceOf(PublishAsAccessError);
    expect(dbReads).not.toHaveBeenCalled();
  });

  /**
   * A MALFORMED ID IS STILL REFUSED — one branch later than it used to be.
   *
   * `ObjectId.isValid` guards stood in front of this read and are deleted per
   * `@oxyhq/db`: `posts.id` is `text`, so an id of any shape simply names no row
   * and is refused by conditions 1 and 3 with an absent parent and root. That is
   * the same answer the guard produced, so this case keeps its subject and loses
   * only the "asks the database nothing" half — which was a property of the
   * guard, not of the rule. Worth pinning explicitly, because the guard's other
   * legacy was worse: kept, it would have answered "not valid" for every uuid v7
   * this instance now mints.
   */
  it.each([
    ['a malformed parent id', { parentPostId: 'not-an-objectid', threadId: ROOT, authorId: CHANNEL }],
    ['a malformed thread id', { parentPostId: ROOT, threadId: 'not-an-objectid', authorId: CHANNEL }],
  ])('refuses %s, which now names no row rather than failing a shape check', async (_label, args) => {
    await expect(assertContinuesOwnThread(args)).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  it('answers 400, the same refusal a plain reply gets — the two are not worth distinguishing', async () => {
    await expect(
      assertContinuesOwnThread({ parentPostId: FOREIGN_POST, threadId: FOREIGN_ROOT, authorId: CHANNEL }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

/**
 * `assertAnswersOperatedAccount` — the SECOND case: two accounts the caller
 * operates, talking to each other inside one composed thread.
 *
 * Four conditions, and every refusal fixture below is built so it fails on
 * EXACTLY the one it names — the others are satisfied. That discipline is not
 * decoration: an earlier version of the first case's suite was green with a
 * condition deleted, because every refusal fixture happened to fail a second
 * condition too, and a check nothing can isolate is a check that is not there.
 *
 *   1. the parent is in the declared thread,
 *   2. the PARENT's account is not a channel,
 *   3. the PUBLISHING account is not a channel,
 *   4. the caller may act for the parent's account too.
 */
describe('assertAnswersOperatedAccount — two operated accounts talking', () => {
  const ACT_AS = ['account:read', 'account:act_as', 'members:read'];
  const NO_ACT_AS = ['account:read', 'members:read'];

  function member(memberUserId: string, permissions: string[]): AccountMember {
    return {
      _id: 'row', accountId: 'acct', memberUserId, role: 'editor', permissions,
      inherit: true, status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  /** Every account the caller may act for, unless a test says otherwise. */
  function readerFor(actable: Record<string, string[]>) {
    return {
      listAccountMembers: async (accountId: string) =>
        actable[accountId] ? [member(OPERATOR, actable[accountId])] : [],
    };
  }

  const ALL_OPERATED = { [ORG_A]: ACT_AS, [ORG_B]: ACT_AS, [CHANNEL]: NO_ACT_AS };

  function kindsAre(byId: Record<string, string>): void {
    resolveUserSummaries.mockImplementation(async (ids: string[]) => {
      const map = new Map<string, { user: { id: string; kind?: string; name: object } }>();
      for (const id of ids) {
        if (byId[id]) map.set(id, { user: { id, kind: byId[id], name: {} } });
      }
      return map;
    });
  }

  beforeEach(() => {
    kindsAre({
      [ORG_A]: 'organization',
      [ORG_B]: 'organization',
      [CHANNEL]: 'channel',
      [OPERATOR]: 'personal',
    });
  });

  const base = {
    parentPostId: A_ROOT,
    threadId: A_ROOT,
    authorId: ORG_B,
    authorKind: 'organization' as const,
    callerId: OPERATOR,
  };

  it('admits organization B answering organization A in A\'s thread', async () => {
    await expect(
      assertAnswersOperatedAccount({ ...base, memberReader: readerFor(ALL_OPERATED) }),
    ).resolves.toBeUndefined();
  });

  it('admits an entry whose account MATCHES its parent but not the thread root', async () => {
    // [A, B, B] — the shape the own-thread exception cannot express, because its
    // third condition is about the root. Both ends are still B and A, both
    // operated, neither a channel.
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        parentPostId: B_SECOND,
        memberReader: readerFor(ALL_OPERATED),
      }),
    ).resolves.toBeUndefined();
  });

  it('admits an organization answering the CALLER\'s own post', async () => {
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        parentPostId: CALLER_ROOT,
        threadId: CALLER_ROOT,
        memberReader: readerFor(ALL_OPERATED),
      }),
    ).resolves.toBeUndefined();
  });

  /** CONDITION 1, isolated: both accounts operated, neither a channel. */
  it('refuses a parent that is not in the declared thread', async () => {
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        parentPostId: ELSEWHERE,
        memberReader: readerFor(ALL_OPERATED),
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  /**
   * CONDITION 2, isolated — MUTATION GUARD. The publishing account is a perfectly
   * ordinary organization the caller may act for, and the parent is genuinely in
   * the declared thread; the ONLY thing wrong is that the parent belongs to a
   * channel. This is literally "an organization replying to a channel's post",
   * which is the hole the whole boundary exists to close.
   */
  it('MUTATION GUARD: refuses answering a CHANNEL\'s post', async () => {
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        parentPostId: CHANNEL_ROOT,
        threadId: CHANNEL_ROOT,
        memberReader: readerFor(ALL_OPERATED),
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  /**
   * CONDITION 3, isolated — MUTATION GUARD. The mirror image, and the reason
   * checking the parent alone is not enough: here the PARENT is a fine
   * organization and the publisher is the channel. A channel answering an
   * organization is a channel in a conversation just the same.
   */
  it('MUTATION GUARD: refuses a CHANNEL doing the answering', async () => {
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        authorId: CHANNEL,
        authorKind: 'channel',
        memberReader: readerFor(ALL_OPERATED),
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  /**
   * CONDITION 2 again, via the ROOT rather than the parent — a channel at the head
   * of the thread with an organization's post as the immediate parent. Without the
   * root in the check, every entry after the first would escape the boundary by
   * chaining onto a non-channel predecessor.
   */
  it('refuses when the thread ROOT is a channel, whoever the immediate parent is', async () => {
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        parentPostId: IN_CHANNEL_THREAD,
        threadId: CHANNEL_ROOT,
        memberReader: readerFor(ALL_OPERATED),
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  /**
   * CONDITION 4, isolated: neither end is a channel and the parent really is in
   * the thread — the caller simply may not speak for the account being answered.
   * Without this, "an account you operate may reply to ANYBODY" is what ships.
   */
  it('refuses answering an account the caller may NOT act for', async () => {
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        memberReader: readerFor({ [ORG_B]: ACT_AS }),
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  it('refuses when the caller is a MEMBER of the answered account without account:act_as', async () => {
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        memberReader: readerFor({ [ORG_A]: NO_ACT_AS, [ORG_B]: ACT_AS }),
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  /**
   * Failing CLOSED on an unknown kind — the opposite direction from
   * `channelReplyGate`'s fail-soft, and deliberately: reading "unknown" as "not a
   * channel" here would admit the one thing this function refuses.
   */
  it('refuses when the parent account\'s kind will not resolve', async () => {
    kindsAre({ [ORG_B]: 'organization' });
    await expect(
      assertAnswersOperatedAccount({ ...base, memberReader: readerFor(ALL_OPERATED) }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  /**
   * The unknown-kind refusal, ISOLATED to the thread ROOT.
   *
   * An unresolvable PARENT is refused by condition 4 anyway (the authorization
   * gate refuses an account whose kind it cannot read), so a parent-side fixture
   * cannot tell the explicit unknown-kind check from its absence — mutation-
   * testing found exactly that. The ROOT never goes through condition 4, so this
   * is the only shape that pins it: parent fine, caller authorized for it, and
   * only the root's kind missing.
   */
  it('refuses when the thread ROOT\'s kind will not resolve, though the parent\'s does', async () => {
    kindsAre({ [ORG_A]: 'organization', [ORG_B]: 'organization' });
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        parentPostId: IN_UNKNOWN_THREAD,
        threadId: UNKNOWN_ROOT,
        memberReader: readerFor(ALL_OPERATED),
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  it('refuses a parent that does not exist', async () => {
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        parentPostId: NO_SUCH_POST,
        memberReader: readerFor(ALL_OPERATED),
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  it.each([
    ['no parentPostId', { parentPostId: null }],
    ['no threadId', { threadId: null }],
    ['no author', { authorId: null }],
  ])('refuses with %s, and asks the database nothing', async (_label, override) => {
    await expect(
      assertAnswersOperatedAccount({ ...base, ...override, memberReader: readerFor(ALL_OPERATED) }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
    expect(dbReads).not.toHaveBeenCalled();
  });

  /** See the matching case above: the id-shape guard is gone, the refusal is not. */
  it('refuses a malformed parent id, which now names no row rather than failing a shape check', async () => {
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        parentPostId: 'not-an-objectid',
        memberReader: readerFor(ALL_OPERATED),
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  it('refuses with no member reader at all — an MCP caller cannot compose one', async () => {
    await expect(
      assertAnswersOperatedAccount({ ...base, memberReader: undefined }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });
});
