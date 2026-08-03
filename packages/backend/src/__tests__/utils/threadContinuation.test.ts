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

vi.mock('../../models/Post', () => ({
  Post: { find },
  POST_CLASSIFICATION_PENDING: 'pending',
}));

import { assertContinuesOwnThread } from '../../utils/threadContinuation';
import { PublishAsAccessError } from '../../services/publishAsAccount';

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
