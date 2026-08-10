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
 * Whether the viewer may manage this post WITHOUT asking Oxy anything.
 *
 * Two cases, both free, and between them they cover every post anybody actually
 * manages: you authored it yourself, or you wrote it for an account that
 * authored it on your behalf.
 *
 * This is the predicate the READ path uses, and the reason it may not grow: it
 * runs once per post per hydration, so anything it consults has to be already in
 * hand. A third case — "I am one of the OTHER people who operate the authoring
 * account" — is a membership question only Oxy can answer, and putting it here
 * would put an Oxy round trip on the feed. The write path takes that cost
 * instead, on an action somebody actually initiated; see
 * {@link assertCanManagePost}.
 *
 * The consequence is deliberate and one-directional: a co-operator who did not
 * write the post is not OFFERED the menu, but would not be refused if they
 * reached the route. Affordance ⊆ permission — a button that is missing is a
 * smaller problem than a button that 403s.
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
 * it between lanes, change its settings — otherwise the refusal to answer with.
 *
 * The rule is "whoever may publish as the authoring account may manage what it
 * published", plus the writer of the post in their own right. It reuses
 * {@link assertCanPublishAsAccount} rather than re-deriving membership, so the
 * authority for writing as an account and the authority for managing what was
 * written cannot drift apart — and so a kind Oxy adds later is refused here for
 * the same reason it is refused there.
 *
 * **Cost.** Nothing is asked of Oxy on the two free paths above, which is every
 * ordinary post and every channel post managed by the person who wrote it. Only
 * a co-operator reaches the lookup, and only on a request they initiated — never
 * on the read path, where it would land on every feed hydration.
 *
 * **A refusal is a 404, not a 403.** These routes have always answered 404 for a
 * post the caller may not touch, so the response cannot be used to discover that
 * somebody else's post exists. The one exception is an Oxy OUTAGE: 503 says "try
 * again", where a 404 would tell an operator their post had vanished.
 *
 * Returning the refusal rather than throwing it is what keeps that mapping in
 * one place. Six handlers ask this question, and a `catch` at each of them is
 * six chances to answer a refusal with the wrong status.
 */
export async function postManagementRefusal(params: {
  post: ManageablePost;
  callerId: string;
  memberReader: AccountMemberReader | undefined;
  /** Require current authority over the authoring account, even for its stored writer. */
  requireAuthorAuthority?: boolean;
}): Promise<PostManagementRefusal | null> {
  const isAuthor =
    Boolean(params.post.oxyUserId) && String(params.post.oxyUserId) === params.callerId;
  if (
    isAuthor ||
    (!params.requireAuthorAuthority && canManagePostWithoutLookup(params.post, params.callerId))
  ) {
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
