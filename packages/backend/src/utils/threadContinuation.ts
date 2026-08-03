/**
 * The TWO ways a link in a batch-composed thread may be authorized, and nothing
 * else, against the standing refusal that "a post published as another account
 * may not be a reply".
 *
 *   - {@link assertContinuesOwnThread} — **the account continues its OWN text.**
 *     One account for the whole thread, root included. This is the only route
 *     available when a CHANNEL is involved, and it is unchanged.
 *   - {@link assertAnswersOperatedAccount} — **two accounts the caller operates
 *     talk to each other.** A thread whose entries carry different accounts, and
 *     it is refused outright the moment a channel is one of them.
 *
 * THE SECOND IS A SECOND CASE, NOT A WIDENING OF THE FIRST, and keeping them
 * apart is the whole safety property. An entry whose account differs from its
 * parent's is mechanically account B REPLYING to account A's post — a
 * conversation between accounts. That is coherent between two organizations the
 * same person operates, and it is exactly what a channel may never be part of:
 * "no replies, ever" has no exception for a channel's own operators
 * (`utils/channelReplyGate`, five write sites). So the channel test below is not
 * a detail of the second case, it IS the second case's boundary, and it is
 * checked on BOTH ends — the parent's account and the publishing one. A channel
 * answering an organization is just as much a channel in a conversation as an
 * organization answering a channel.
 *
 * ------------------------------------------------------------------------
 *
 * {@link assertContinuesOwnThread}: "this post continues its own author's
 * thread".
 *
 * WHY THE EXCEPTION EXISTS. A thread is one text in several parts, not a
 * dialogue. The mechanism that makes the parts a thread is `parentPostId`, so
 * from the storage layer's point of view every continuation is a reply — but a
 * channel continuing its own announcement is exactly what a Telegram channel
 * does, and refusing it means an account may publish at most one paragraph at a
 * time. The refusal in `PostCreationService` exists to stop a CONVERSATION being
 * held under an account's name, and a post answering itself is not one.
 *
 * WHY IT IS THIS NARROW, AND NOT "THE AUTHOR MAY ACT FOR THE PARENT'S ACCOUNT".
 * That wider rule reads as the same thing and is not: it would let anybody who
 * operates a channel post a reply, as the channel, under any of that channel's
 * posts at any later time — which is a conversation between operators wearing the
 * channel's name, and is precisely what `utils/channelReplyGate` refuses at five
 * separate write sites (its docstring is explicit that there is "no exception for
 * the writer, and none for the channel's owner"). The distinction this module
 * draws is STRUCTURAL rather than a matter of intent:
 *
 *   1. the parent is authored by the SAME account this post will be,
 *   2. the parent belongs to the SAME thread this post declares, and
 *   3. that thread's ROOT is authored by that same account.
 *
 * All three are read back out of the database — nothing is taken from the
 * caller's word. A client can name any `parentPostId` and any `threadId` it
 * likes; what it cannot do is make a post it does not own answer to an author it
 * is not.
 *
 * AND THE UNLOCK IS NOT REACHABLE FROM THE PUBLIC REPLY ROUTES ANYWAY. Both
 * checks are consulted only when their own SERVICE-level parameter is set
 * (`CreatePostParams.continuesOwnThread` / `answersOperatedAccount`), and
 * `POST /posts` builds its params from an explicit whitelist of body fields that
 * names neither — so no request can ask for either. That is what keeps
 * "reply to anything as an organization" out of the public API: the second case
 * is a property of a thread being composed in one action, not a new reply
 * permission. The structural checks are what make the parameters safe to exist;
 * the parameters are what keep the checks off the ordinary reply paths. Neither
 * alone is the guard.
 */

import type { AccountKind } from '@oxyhq/contracts';
import mongoose from 'mongoose';
import { Post } from '../models/Post';
import {
  assertCanPublishAsAccount,
  PublishAsAccessError,
  resolveAccountKinds,
  type AccountMemberReader,
} from '../services/publishAsAccount';

/**
 * Throw unless this post genuinely continues `authorId`'s own thread.
 *
 * Refuses with the same {@link PublishAsAccessError} the plain reply refusal
 * uses, so the HTTP layer needs no new mapping and a caller cannot tell "you may
 * not reply as that account" from "that is not your thread" — which is the right
 * amount to say, since both answers mean the same thing to a legitimate client.
 *
 * `threadId` is the thread's ROOT post id (that is what `createThread` anchors a
 * self-thread on: the root sets `threadId = its own _id`, and every continuation
 * carries the same value). A continuation whose parent IS the root is therefore
 * the ordinary case, and one deeper in the chain has `parent.threadId` equal to
 * it — both are accepted, and nothing else is.
 */
export async function assertContinuesOwnThread(params: {
  parentPostId: string | null | undefined;
  threadId: string | null | undefined;
  authorId: string | null;
}): Promise<void> {
  const refuse = (): never => {
    throw new PublishAsAccessError(400, 'A reply cannot be published as another account');
  };

  const { parentPostId, threadId, authorId } = params;
  if (!authorId || !parentPostId || !threadId) refuse();
  if (
    !mongoose.Types.ObjectId.isValid(String(parentPostId)) ||
    !mongoose.Types.ObjectId.isValid(String(threadId))
  ) {
    refuse();
  }

  // ONE query for both rows. The root is fetched even when it IS the parent,
  // because the third condition is about the thread's origin and reading it off
  // the parent would make a chain inherit its own claim.
  const rows = await Post.find({ _id: { $in: [parentPostId, threadId] } })
    .select('oxyUserId threadId')
    .lean<Array<{ _id: mongoose.Types.ObjectId; oxyUserId?: string; threadId?: string }>>();

  const byId = new Map(rows.map((row) => [String(row._id), row]));
  const parent = byId.get(String(parentPostId));
  const root = byId.get(String(threadId));

  // A MISSING row needs no check of its own: `authorId` is non-empty by the guard
  // above, so an absent parent or root reads as `''` in conditions 1 and 3 and is
  // refused there. An explicit `if (!parent || !root)` was written here first and
  // removed after mutation-testing proved nothing could distinguish its presence
  // from its absence — a line that cannot fail is a line that reads as a guard
  // while guarding nothing. The two "does not exist" tests still pin the
  // BEHAVIOUR, which is what matters.

  // 1. The parent is this account's own post. NOT "an account the author may act
  //    for" — a stranger's reply sitting inside this account's own thread would
  //    satisfy every other condition here, and answering it is a conversation.
  if (String(parent?.oxyUserId ?? '') !== authorId) refuse();
  // 2. The parent is in the thread this post declares — either its root, or a
  //    link already anchored on it.
  if (String(parentPostId) !== String(threadId) && String(parent?.threadId ?? '') !== String(threadId)) {
    refuse();
  }
  // 3. The thread was STARTED by this account. Without it, an account could
  //    graft its own post onto somebody else's thread and call the result a
  //    continuation.
  if (String(root?.oxyUserId ?? '') !== authorId) refuse();
}

/**
 * Throw unless this post may answer, as `authorId`, another account's post in the
 * SAME batch-composed thread — the second case, for a thread whose entries carry
 * different accounts.
 *
 * FOUR conditions, and the two channel ones are the reason this function is
 * separate from {@link assertContinuesOwnThread} rather than a relaxed flag on it:
 *
 *   1. the parent is in the thread this post declares (the same structural anchor
 *      the first case uses — what keeps this about a thread being composed rather
 *      than about replying to anything),
 *   2. the PARENT's account is not a channel,
 *   3. the PUBLISHING account is not a channel, and
 *   4. the caller may act for the parent's account too, on the authority that
 *      account's kind demands — which is the same gate the publishing account
 *      already went through, asked a second time about the other end.
 *
 * Condition 3 is not implied by condition 2 and dropping it is the subtler
 * mistake: a channel answering an organization is a channel in a conversation
 * just as much as the reverse. Both are checked, from the account graph, never
 * from the request.
 *
 * Condition 4 is what stops this being "an account you operate may reply to
 * anybody". Both ends of the exchange have to be yours; a thread that reaches
 * outside the caller's own accounts is a conversation with a third party, which
 * is an ordinary reply and goes through the ordinary reply routes.
 *
 * An UNRESOLVABLE account kind refuses. This is the opposite direction from
 * `utils/channelReplyGate`'s fail-soft, and deliberately so: there, answering
 * "unknown" as "channel" would refuse every reply on the site during an identity
 * outage; here, answering it as "not a channel" would admit the one thing this
 * function exists to refuse, and the cost of being wrong is a thread that has to
 * be posted again.
 */
export async function assertAnswersOperatedAccount(params: {
  parentPostId: string | null | undefined;
  threadId: string | null | undefined;
  authorId: string | null;
  authorKind: AccountKind | null;
  callerId: string | null;
  memberReader: AccountMemberReader | undefined;
}): Promise<void> {
  const refuse = (): never => {
    throw new PublishAsAccessError(400, 'A reply cannot be published as another account');
  };

  const { parentPostId, threadId, authorId, authorKind, callerId, memberReader } = params;
  if (!authorId || !parentPostId || !threadId) refuse();
  if (
    !mongoose.Types.ObjectId.isValid(String(parentPostId)) ||
    !mongoose.Types.ObjectId.isValid(String(threadId))
  ) {
    refuse();
  }

  // 3, first — it needs no query. The publishing account's kind was already
  // resolved by the authorization gate, so a channel is refused before anything
  // is read. `null` here means the post is the CALLER's own (the gate resolves no
  // kind when no account was named), which is not a channel by construction: a
  // channel has no login, so it can never be the authenticated subject.
  if (authorKind === 'channel') refuse();

  const rows = await Post.find({ _id: { $in: [parentPostId, threadId] } })
    .select('oxyUserId threadId')
    .lean<Array<{ _id: mongoose.Types.ObjectId; oxyUserId?: string; threadId?: string }>>();

  const byId = new Map(rows.map((row) => [String(row._id), row]));
  const parent = byId.get(String(parentPostId));
  const root = byId.get(String(threadId));

  // NO existence or emptiness guard here, and that is a measured decision rather
  // than an oversight. An absent parent or root reads as an empty account id,
  // `resolveAccountKinds` drops falsy ids, so the kind lookup below finds nothing
  // for it and refuses on the unknown-kind rule. Two such guards were written
  // here first — one of them with a comment asserting it was load-bearing in this
  // case — and mutation-testing showed nothing could tell either one's presence
  // from its absence. A line that reads as a guard while guarding nothing is
  // worse than no line, because the next reader budgets trust for it.
  const parentAuthorId = String(parent?.oxyUserId ?? '');

  // 1. The parent is in the declared thread — its root, or a link anchored on it.
  if (String(parentPostId) !== String(threadId) && String(parent?.threadId ?? '') !== String(threadId)) {
    refuse();
  }

  // 2, plus the ROOT for the same reason. A thread is one object: a channel
  // sitting at its head makes every later entry an answer to a channel, whichever
  // post is the immediate parent. One batched identity read for both.
  const rootAuthorId = String(root?.oxyUserId ?? '');
  const kinds = await resolveAccountKinds([parentAuthorId, rootAuthorId]);
  for (const accountId of [parentAuthorId, rootAuthorId]) {
    // An account the caller themselves owns resolves as `personal`; only an id
    // that resolves to NOTHING is unknown, and unknown refuses — see the note on
    // failing closed above.
    if (!kinds.has(accountId)) refuse();
    if (kinds.get(accountId) === 'channel') refuse();
  }

  // 4. The other end is the caller's to speak for as well. Reuses the ONE
  // authorization gate rather than re-deriving membership — including its early
  // return when the parent's account IS the caller's own, which is the ordinary
  // "I started the thread, my organization answers me" shape.
  await assertCanPublishAsAccount({
    publishAsOxyUserId: parentAuthorId,
    callerId,
    memberReader,
  });
}
