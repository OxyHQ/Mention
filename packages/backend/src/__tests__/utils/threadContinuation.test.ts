import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

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
 * check that is not there.
 */

const find = vi.hoisted(() => vi.fn());
const resolveUserSummaries = vi.hoisted(() => vi.fn(async () => new Map()));

vi.mock('../../models/Post', () => ({
  Post: { find },
  POST_CLASSIFICATION_PENDING: 'pending',
}));

// The identity path behind account KINDS. The real `publishAsAccount` is used
// throughout — the second case's condition 4 delegates to its authorization gate,
// and stubbing that would leave the delegation untested.
vi.mock('../../services/PostHydrationService', () => ({ resolveUserSummaries }));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  assertAnswersOperatedAccount,
  assertContinuesOwnThread,
} from '../../utils/threadContinuation';
import { PublishAsAccessError } from '../../services/publishAsAccount';
import type { AccountMember } from '@oxyhq/core';

const CHANNEL = 'channel-account-1';
const OPERATOR = 'human-1';
const OTHER_ACCOUNT = 'org-account-1';

const ROOT = new mongoose.Types.ObjectId().toString();
const CONTINUATION_1 = new mongoose.Types.ObjectId().toString();
const FOREIGN_POST = new mongoose.Types.ObjectId().toString();
const FOREIGN_ROOT = new mongoose.Types.ObjectId().toString();

interface Row {
  _id: string;
  oxyUserId?: string;
  threadId?: string;
}

/** Seed the collection the assertion reads. */
function rowsAre(rows: Row[]): void {
  find.mockImplementation((filter: { _id: { $in: Array<string | null | undefined> } }) => {
    const wanted = new Set((filter._id.$in ?? []).map((id) => String(id)));
    const matched = rows.filter((row) => wanted.has(row._id));
    return { select: () => ({ lean: async () => matched }) };
  });
}

beforeEach(() => {
  find.mockReset();
  rowsAre([
    // The channel's own thread: a root and one continuation anchored on it.
    { _id: ROOT, oxyUserId: CHANNEL, threadId: ROOT },
    { _id: CONTINUATION_1, oxyUserId: CHANNEL, threadId: ROOT },
    // Somebody else's post, and somebody else's thread root.
    { _id: FOREIGN_POST, oxyUserId: OTHER_ACCOUNT, threadId: FOREIGN_ROOT },
    { _id: FOREIGN_ROOT, oxyUserId: OTHER_ACCOUNT, threadId: FOREIGN_ROOT },
  ]);
});

describe('assertContinuesOwnThread — what it ADMITS', () => {
  it('admits the first continuation, whose parent IS the root', async () => {
    await expect(
      assertContinuesOwnThread({ parentPostId: ROOT, threadId: ROOT, authorId: CHANNEL }),
    ).resolves.toBeUndefined();
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
    const OWN_ROOT = new mongoose.Types.ObjectId().toString();
    const STRANGERS_REPLY = new mongoose.Types.ObjectId().toString();
    rowsAre([
      { _id: OWN_ROOT, oxyUserId: OTHER_ACCOUNT, threadId: OWN_ROOT },
      // A stranger replied into that thread — so it carries the account's own
      // threadId while belonging to somebody else.
      { _id: STRANGERS_REPLY, oxyUserId: 'a-stranger', threadId: OWN_ROOT },
    ]);

    await expect(
      assertContinuesOwnThread({
        parentPostId: STRANGERS_REPLY,
        threadId: OWN_ROOT,
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
    const OTHER_ROOT = new mongoose.Types.ObjectId().toString();
    rowsAre([
      { _id: ROOT, oxyUserId: CHANNEL, threadId: ROOT },
      { _id: OTHER_ROOT, oxyUserId: CHANNEL, threadId: OTHER_ROOT },
    ]);

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
    const GRAFTED = new mongoose.Types.ObjectId().toString();
    rowsAre([
      { _id: FOREIGN_ROOT, oxyUserId: OTHER_ACCOUNT, threadId: FOREIGN_ROOT },
      { _id: GRAFTED, oxyUserId: CHANNEL, threadId: FOREIGN_ROOT },
    ]);

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
    const MISSING = new mongoose.Types.ObjectId().toString();
    await expect(
      assertContinuesOwnThread({ parentPostId: MISSING, threadId: ROOT, authorId: CHANNEL }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  it('refuses a thread root that does not exist', async () => {
    const MISSING = new mongoose.Types.ObjectId().toString();
    await expect(
      assertContinuesOwnThread({ parentPostId: ROOT, threadId: MISSING, authorId: CHANNEL }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  it.each([
    ['no threadId', { parentPostId: ROOT, threadId: null, authorId: CHANNEL }],
    ['no parentPostId', { parentPostId: null, threadId: ROOT, authorId: CHANNEL }],
    ['no author', { parentPostId: ROOT, threadId: ROOT, authorId: null }],
    ['a malformed parent id', { parentPostId: 'not-an-objectid', threadId: ROOT, authorId: CHANNEL }],
    ['a malformed thread id', { parentPostId: ROOT, threadId: 'not-an-objectid', authorId: CHANNEL }],
  ])('refuses with %s, and asks the database nothing', async (_label, args) => {
    await expect(assertContinuesOwnThread(args)).rejects.toBeInstanceOf(PublishAsAccessError);
    expect(find).not.toHaveBeenCalled();
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
  const ORG_A = 'org-a';
  const ORG_B = 'org-b';
  const A_ROOT = new mongoose.Types.ObjectId().toString();
  const A_SECOND = new mongoose.Types.ObjectId().toString();
  const CHANNEL_ROOT = new mongoose.Types.ObjectId().toString();
  const ELSEWHERE = new mongoose.Types.ObjectId().toString();

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
    kindsAre({ [ORG_A]: 'organization', [ORG_B]: 'organization', [CHANNEL]: 'channel', [OPERATOR]: 'personal' });
    rowsAre([
      { _id: A_ROOT, oxyUserId: ORG_A, threadId: A_ROOT },
      { _id: A_SECOND, oxyUserId: ORG_A, threadId: A_ROOT },
      { _id: CHANNEL_ROOT, oxyUserId: CHANNEL, threadId: CHANNEL_ROOT },
      { _id: ELSEWHERE, oxyUserId: ORG_A, threadId: ELSEWHERE },
    ]);
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
    rowsAre([
      { _id: A_ROOT, oxyUserId: ORG_A, threadId: A_ROOT },
      { _id: A_SECOND, oxyUserId: ORG_B, threadId: A_ROOT },
    ]);
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        parentPostId: A_SECOND,
        memberReader: readerFor(ALL_OPERATED),
      }),
    ).resolves.toBeUndefined();
  });

  it('admits an organization answering the CALLER\'s own post', async () => {
    rowsAre([{ _id: A_ROOT, oxyUserId: OPERATOR, threadId: A_ROOT }]);
    await expect(
      assertAnswersOperatedAccount({ ...base, memberReader: readerFor(ALL_OPERATED) }),
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
    rowsAre([
      { _id: CHANNEL_ROOT, oxyUserId: CHANNEL, threadId: CHANNEL_ROOT },
      { _id: A_SECOND, oxyUserId: ORG_A, threadId: CHANNEL_ROOT },
    ]);
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        parentPostId: A_SECOND,
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
    const UNKNOWN_ROOT = new mongoose.Types.ObjectId().toString();
    kindsAre({ [ORG_A]: 'organization', [ORG_B]: 'organization' });
    rowsAre([
      { _id: UNKNOWN_ROOT, oxyUserId: 'an-account-oxy-cannot-resolve', threadId: UNKNOWN_ROOT },
      { _id: A_SECOND, oxyUserId: ORG_A, threadId: UNKNOWN_ROOT },
    ]);

    await expect(
      assertAnswersOperatedAccount({
        ...base,
        parentPostId: A_SECOND,
        threadId: UNKNOWN_ROOT,
        memberReader: readerFor(ALL_OPERATED),
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  it('refuses a parent that does not exist', async () => {
    rowsAre([{ _id: A_ROOT, oxyUserId: ORG_A, threadId: A_ROOT }]);
    await expect(
      assertAnswersOperatedAccount({
        ...base,
        parentPostId: new mongoose.Types.ObjectId().toString(),
        memberReader: readerFor(ALL_OPERATED),
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });

  it.each([
    ['no parentPostId', { parentPostId: null }],
    ['no threadId', { threadId: null }],
    ['no author', { authorId: null }],
    ['a malformed parent id', { parentPostId: 'not-an-objectid' }],
  ])('refuses with %s, and asks the database nothing', async (_label, override) => {
    await expect(
      assertAnswersOperatedAccount({ ...base, ...override, memberReader: readerFor(ALL_OPERATED) }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
    expect(find).not.toHaveBeenCalled();
  });

  it('refuses with no member reader at all — an MCP caller cannot compose one', async () => {
    await expect(
      assertAnswersOperatedAccount({ ...base, memberReader: undefined }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });
});
