import {
  PublishAsAccessError,
  assertCanPublishAsAccount,
  type AccountMemberReader,
} from './publishAsAccount';

/**
 * The parts of a post that decide who may manage it.
 *
 * Deliberately narrow: every caller already has these two columns, and taking
 * the whole document would invite a rule that reads something else.
 */
export interface ManageablePost {
  /** The account the post is AUTHORED BY. For a channel post, the channel. */
  oxyUserId?: string | null;
  /** The human who wrote it, set only when an account authored on their behalf. */
  writtenByOxyUserId?: string | null;
}

/**
 * Whether the viewer LOOKS like somebody who may manage this post, answered
 * without asking Oxy anything.
 *
 * Two cases, both free: you authored it yourself, or the post RECORDS you as
 * having written it for an account that authored it on your behalf.
 *
 * **Its only remaining caller is the DTO** — `viewerState.isOwner` and the
 * `PostPermissions` flags beside it, which are what the client's post menu is
 * drawn from. It is not the ACL (`canViewerReadPost` resolves current authority)
 * and it is not the write gate ({@link postManagementRefusal} does the same),
 * and the reason it may not grow into either is that it runs once per post per
 * hydration: anything it consults has to be already in hand, and "am I one of
 * the OTHER people who operate this account" is a membership question only Oxy
 * can answer.
 *
 * **So it is a HINT, and the second clause is why it can be wrong.**
 * `writtenByOxyUserId` is written once at creation and never revised, so it goes
 * on naming somebody after they leave the channel. That makes it evidence of
 * historical authorship rather than of current authority — good enough to decide
 * whether to draw a menu, not good enough to decide whether to honour it.
 *
 * The two disagreements it leaves are both bounded, and they run in opposite
 * directions:
 *
 *  - a CO-OPERATOR who did not write the post is not offered the menu but is
 *    accepted by the route. Affordance ⊂ permission — the direction the house
 *    rule prefers, since a missing button is smaller than one that refuses.
 *  - a DEPARTED writer is still offered the menu and is refused by the route.
 *    That is the direction the rule warns about, and it is accepted here
 *    deliberately; {@link postManagementRefusal} carries the argument.
 */
export function canManagePostWithoutLookup(
  post: ManageablePost,
  viewerId: string | undefined,
): boolean {
  if (!viewerId) return false;
  if (post.oxyUserId && String(post.oxyUserId) === viewerId) return true;
  return Boolean(post.writtenByOxyUserId) && String(post.writtenByOxyUserId) === viewerId;
}

/** An HTTP refusal, ready for the handler to answer with. */
export interface PostManagementRefusal {
  status: number;
  message: string;
}

/**
 * `null` when `callerId` may manage this post — delete it, edit it, pin it, move
 * it between lanes, change its settings, read its insights, publish it early —
 * otherwise the refusal to answer with.
 *
 * The rule is "whoever may publish as the authoring account may manage what it
 * published". It reuses {@link assertCanPublishAsAccount} rather than
 * re-deriving membership, so the authority for writing as an account and the
 * authority for managing what was written cannot drift apart — and so a kind Oxy
 * adds later is refused here for the same reason it is refused there.
 *
 * ## Why the stored writer is not a second rule
 *
 * A channel post carries the human who wrote it in `writtenByOxyUserId`, free
 * and already in hand, and this gate used to admit them on that alone. It is the
 * wrong column for the question. It is written once, at creation, and never
 * again — not when a colleague rewrites the post, and not when its writer leaves
 * the channel. So it kept answering "yes" for a removed member, over the
 * channel's embargoed queue, for as long as they held the post id: they could
 * delete the story, rewrite it under the channel's byline, pin it, move it
 * between the channel's lanes and read its private engagement figures, with
 * nothing asked of Oxy anywhere. Historical authorship is not current authority,
 * so the proof has to be current, and only Oxy's account graph holds it.
 *
 * The same reasoning already governs the READ side (`PostHydrationService`
 * resolves current authority before serving a withheld channel post), and every
 * management route now answers to it too. There is no per-route opt-out: the
 * cheap free path would be reintroduced one defensible call site at a time, and
 * the routes it would be reintroduced on are the destructive ones.
 *
 * **Cost.** Authoring the post yourself is still free and is checked first,
 * which is every ordinary post — no query, no round trip. What now pays a
 * membership read is the case where the caller is NOT the authoring account:
 * a co-operator, and (newly) the post's stored writer. Both are account-authored
 * posts on a request somebody initiated, never a feed hydration.
 *
 * **A refusal is a 404, not a 403.** These routes have always answered 404 for a
 * post the caller may not touch, so the response cannot be used to discover that
 * somebody else's post exists. The one exception is an Oxy OUTAGE: 503 says "try
 * again", where a 404 would tell an operator their post had vanished.
 *
 * Returning the refusal rather than throwing it is what keeps that mapping in
 * one place. Seven handlers ask this question, and a `catch` at each of them is
 * seven chances to answer a refusal with the wrong status.
 *
 * ## The divergence from `viewerState.isOwner`, stated rather than hidden
 *
 * The DTO's `isOwner` is still {@link canManagePostWithoutLookup}, so a departed
 * writer is drawn a post menu whose every action this gate now answers 404 to.
 * That is the direction AGENTS.md warns about — affordance ⊄ permission — and it
 * is accepted here because the alternative is worse in both size and kind.
 *
 * Making the two agree means either asking Oxy during hydration, which is the
 * round trip the read path exists to avoid and would land on every feed, or
 * dropping the writer clause from `isOwner`. The second is not symmetrical with
 * this change: a channel AUTHORS its own posts, so with that clause gone
 * `isOwner` is false for every human alive on every channel post, on every
 * surface that has not resolved the operated-account set — which is all of them
 * except the editorial queue. That trades a stale menu shown to people who have
 * LEFT a channel for no menu at all shown to the people currently running it.
 *
 * The residual error is also the least bad one available. `isOwner` is a
 * snapshot of a permission a THIRD PARTY can revoke — the channel's owner
 * removing a member — so no cached DTO can be right about it without asking; the
 * only question is what happens when it is stale. Before this it was stale and
 * OBEYED, and the story was destroyed. Now it is stale and refused.
 */
export async function postManagementRefusal(params: {
  post: ManageablePost;
  callerId: string;
  memberReader: AccountMemberReader | undefined;
}): Promise<PostManagementRefusal | null> {
  // The one free path, and the only one: the caller IS the account that authored
  // the post. Nothing about it can go stale — it is a comparison between the
  // row's own owner and the authenticated subject of this request.
  if (Boolean(params.post.oxyUserId) && String(params.post.oxyUserId) === params.callerId) {
    return null;
  }

  const authorId = params.post.oxyUserId ? String(params.post.oxyUserId) : '';
  if (!authorId) return NOT_FOUND;

  try {
    await assertCanPublishAsAccount({
      publishAsOxyUserId: authorId,
      callerId: params.callerId,
      memberReader: params.memberReader,
    });
    return null;
  } catch (error) {
    // 503 is the only status that survives: it means Oxy could not answer, and
    // an operator retrying is the right outcome. Every genuine refusal — not a
    // member, no `account:act_as`, an account nothing can be published as —
    // collapses to the 404 these routes already answer, so the reply is the same
    // whether the post belongs to somebody else or does not exist.
    if (error instanceof PublishAsAccessError && error.status === 503) {
      return { status: 503, message: error.message };
    }
    return NOT_FOUND;
  }
}

const NOT_FOUND: PostManagementRefusal = { status: 404, message: 'Post not found' };
