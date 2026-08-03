/**
 * The ONE definition of "this post continues its own author's thread", which is
 * the single narrow exception to "a post published as another account may not be
 * a reply".
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
 * AND THE UNLOCK IS NOT REACHABLE FROM THE PUBLIC REPLY ROUTES ANYWAY. This check
 * is only consulted when `CreatePostParams.continuesOwnThread` is set, which is a
 * SERVICE-level parameter: `POST /posts` builds its params from an explicit
 * whitelist of body fields and never reads one, so no request can ask for it. The
 * three-part check above is what makes the parameter safe to exist; the parameter
 * is what keeps the check off the ordinary reply paths. Neither alone is the
 * guard.
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { PublishAsAccessError } from '../services/publishAsAccount';

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
