import type { FeedPostSlice } from '@mention/shared-types/feed';
import type { HydratedPost, PostUser } from '@mention/shared-types/post';
import type { OpenPostPanel } from '@/components/Post/postEngagementContext';

// The props of a post row and the rule for when a row must redraw, shared by
// the JSX row (`PostItem`) and the Bloom-language row (`LanguagePostItem`) so
// the two compare, and therefore re-render, alike.

export interface PostItemProps {
  post: HydratedPost;
  isNested?: boolean;
  showPinned?: boolean;
  style?: object;
  onReply?: () => void;
  nestingDepth?: number;
  isThreadParent?: boolean;
  isThreadChild?: boolean;
  isThreadLastChild?: boolean;
  /** Incoming elbow from the parent of a nested reply. */
  replyBranch?: boolean;
  /**
   * When something is rendered flush below this post (e.g. a "Show this thread"
   * link), drop the container's bottom border + padding so the post connects to
   * it as one block. The element below then owns the single bottom separator.
   */
  attachedBelow?: boolean;
  /**
   * Drops the bottom separator alone (padding stays): a reply-branch row, whose
   * branch draws its own. The JSX row receives this as `style`; the language row
   * takes no raw style, so the feed says it by name as well.
   */
  hideSeparator?: boolean;
  /**
   * When this row is a PURE repost (boost) surfaced into a feed, the actor who
   * reposted it. The main post body is the ORIGINAL post (passed as `post`);
   * this renders a muted, tappable "Reposted by {displayName}" context row in
   * the avatar-gutter lane ABOVE the header — and above the Pinned/reply-context
   * rows (repost is the outermost reason). Because the original carries no
   * `boost`, the inline header boost glyph stays off, so this is the single
   * repost affordance (no duplicate indicator). Quote posts use `quotedPost`
   * nesting instead and never set this prop.
   */
  repostedBy?: PostUser;
  /**
   * Where `repostedBy` is drawn when a boosted reply is shown under its parent:
   * `headOnly` on the parent heading the slice (the "Reposted by" line, without
   * pairing the reposter's avatar with an author they are not), `shownAbove` on
   * the boosted reply (the avatar pairing, without repeating the line).
   */
  repostPlacement?: 'headOnly' | 'shownAbove';
  socialContext?: FeedPostSlice['socialContext'];
  /**
   * Render the FOCUSED post-detail variant: full-width body, the usual action bar,
   * the full absolute timestamp + engagement-stats rows, and a
   * non-tappable container. Passed ONLY by the post-detail screen for the focused
   * post — NOT by the replies list (replies stay in the compact feed variant). The
   * same `PostItem` renders feed AND detail; only this flag changes.
   */
  isPostDetail?: boolean;
  /** Position in the complete, loaded author thread; never the replies list. */
  threadPosition?: { index: number; total: number };
  /**
   * When this item is rendered inside a feed, the feed's descriptor. Opening
   * the post detail from the feed reports a `click` interaction attributed to
   * this feed. Absent for non-feed renders (post detail, nested previews).
   */
  feedDescriptor?: string;
  /**
   * Thread "unit" wiring (feed rows only). All rows of one thread share the
   * same `sliceKey`; `isThread` is true when this row is part of a multi-post
   * thread, and `threadOpenId` is the thread's root post id. Together they make
   * the whole thread behave as one unit: hovering any post highlights every
   * post of the thread (via the shared `threadHoverStore`), and tapping any
   * post opens the thread at `threadOpenId`. Absent/false for standalone posts.
   */
  sliceKey?: string;
  threadOpenId?: string;
  isThread?: boolean;
  /**
   * Notified right before a tap opens the post detail. A pure observer — it does
   * NOT replace the navigation (use it to record that the row was opened, e.g.
   * the search screen committing its query to the search history).
   */
  onOpen?: () => void;
  /** Feed-level dispatch, read once per feed instead of once per mounted row. */
  openPostEngagement?: OpenPostPanel | null;
}

/**
 * The props that place a post in its row rather than describe it. Checked on
 * BOTH paths below: the fast path used to trust an unchanged `post` reference
 * alone, so a row whose thread position, booster or pin changed around the same
 * post object — which FlashList recycling and a re-sliced page both produce —
 * kept drawing the old connector lines and "Reposted by".
 */
export const rowPlacementEqual = (prevProps: PostItemProps, nextProps: PostItemProps): boolean =>
  prevProps.isNested === nextProps.isNested &&
  prevProps.nestingDepth === nextProps.nestingDepth &&
  prevProps.showPinned === nextProps.showPinned &&
  prevProps.isThreadParent === nextProps.isThreadParent &&
  prevProps.isThreadChild === nextProps.isThreadChild &&
  prevProps.isThreadLastChild === nextProps.isThreadLastChild &&
  prevProps.replyBranch === nextProps.replyBranch &&
  prevProps.attachedBelow === nextProps.attachedBelow &&
  prevProps.isPostDetail === nextProps.isPostDetail &&
  prevProps.threadPosition?.index === nextProps.threadPosition?.index &&
  prevProps.threadPosition?.total === nextProps.threadPosition?.total &&
  prevProps.feedDescriptor === nextProps.feedDescriptor &&
  prevProps.openPostEngagement === nextProps.openPostEngagement &&
  prevProps.sliceKey === nextProps.sliceKey &&
  prevProps.threadOpenId === nextProps.threadOpenId &&
  prevProps.isThread === nextProps.isThread &&
  // Same original post id can be reposted by different actors across rows;
  // compare the booster so a recycled row never shows a stale "Reposted by".
  prevProps.repostedBy?.id === nextProps.repostedBy?.id &&
  prevProps.repostPlacement === nextProps.repostPlacement &&
  prevProps.socialContext === nextProps.socialContext;

/** `PostItem`'s memo comparator: true when the row may keep what it drew. */
export function postItemPropsEqual(prevProps: PostItemProps, nextProps: PostItemProps): boolean {
  if (!rowPlacementEqual(prevProps, nextProps)) return false;
  // Fast path: same post reference.
  if (prevProps.post === nextProps.post) return true;

  const prev = prevProps.post;
  const next = nextProps.post;

  // The byline's membership, which nothing else here moves with. `authors`
  // changes for a post whose id, engagement and `updatedAt` are all unchanged:
  // a collaborator accepts an invite, or a channel account turns `signPosts`
  // on or off and its posts start (or stop) naming the human who wrote them.
  // Without this the row keeps the byline it first rendered until a reload.
  const prevAuthors = prev?.authors ?? [];
  const nextAuthors = next?.authors ?? [];
  if (prevAuthors.length !== nextAuthors.length) return false;
  for (let i = 0; i < prevAuthors.length; i++) {
    if (prevAuthors[i]?.id !== nextAuthors[i]?.id) return false;
    if (
      prevAuthors[i]?.kind !== nextAuthors[i]?.kind ||
      prevAuthors[i]?.character !== nextAuthors[i]?.character ||
      prevAuthors[i]?.color !== nextAuthors[i]?.color
    )
      return false;
  }

  // Compare identity and key engagement/viewer state
  return (
    prev?.id === next?.id &&
    prev?.user?.kind === next?.user?.kind &&
    prev?.user?.character === next?.user?.character &&
    prev?.user?.color === next?.user?.color &&
    // Hydration and access changes can add/remove an embedded post without
    // editing the quoting parent. Never retain a missing or revoked quote.
    prev?.quotedPost === next?.quotedPost &&
    prev?.quotedPostUnavailable === next?.quotedPostUnavailable &&
    prev?.originalPost === next?.originalPost &&
    prev?.boost === next?.boost &&
    prev?.viewerState?.isLiked === next?.viewerState?.isLiked &&
    prev?.viewerState?.isDownvoted === next?.viewerState?.isDownvoted &&
    prev?.viewerState?.isBoosted === next?.viewerState?.isBoosted &&
    prev?.viewerState?.isSaved === next?.viewerState?.isSaved &&
    prev?.engagement?.likes === next?.engagement?.likes &&
    prev?.engagement?.downvotes === next?.engagement?.downvotes &&
    prev?.engagement?.boosts === next?.engagement?.boosts &&
    prev?.engagement?.replies === next?.engagement?.replies &&
    prev?.metadata?.updatedAt === next?.metadata?.updatedAt &&
    // A lane move is not an edit — the server writes no `updatedAt` for it,
    // deliberately (`PATCH /posts/:id/lane` sets no `isEdited` and carries no
    // edit window). So the lane is compared on its own rather than riding an
    // implicit coupling to a timestamp that does not move with it.
    prev?.lane?.id === next?.lane?.id
  );
}
