/** The inputs and per-request context shapes shared by every hydration module. */
import type { SafetyRequester } from '@oxy.so/contracts';
import type { PostAuthorshipEntry } from '@mention/shared-types';
import type { PostRecordFederation } from '../../../db/posts/postRecord';
import type {
  OxyClient,
  ViewerGraphContext,
  ViewerPrivacyContext,
} from '../../../utils/privacyHelpers';
import type { DEFAULT_PRIVACY } from '../../engagement/engagementCountPrivacy';
import type { OperatedAccountReader } from '../../accounts/publishAsAccount';
import type { RequestLanguages } from '../../../utils/viewerLanguage';
import type { PostMetadata, StoredPostContent } from '@mention/shared-types';

/**
 * A raw post plain-object as returned by `.lean()` or `.toObject()`.
 * Covers all fields accessed during hydration, including federated-only fields.
 */
export interface RawPost {
  _id?: unknown;
  id?: string;
  oxyUserId?: string;
  /**
   * The human who wrote a post published BY a `channel` account, recorded here
   * rather than in `authorship` (which would put the post back on their own
   * profile and their followers' timelines). Read only to decide the byline —
   * it never reaches a DTO field of its own.
   */
  writtenByOxyUserId?: string;
  authorship?: PostAuthorshipEntry[];
  /** The post's STORED content: renditions (`variants[0]` is the primary) + the shared media/article. */
  content?: Partial<StoredPostContent>;
  metadata?: Partial<PostMetadata>;
  /** AP federation metadata (federated posts only); `spoilerText` is the CW label. */
  federation?: PostRecordFederation;
  /**
   * Stage-A classification subdoc. Only the canonical multi-language array is
   * read during hydration (surfaced to the DTO as `metadata.languages`).
   */
  postClassification?: { languages?: string[]; sensitive?: boolean };
  stats?: {
    likesCount?: number;
    downvotesCount?: number;
    boostsCount?: number;
    commentsCount?: number;
    viewsCount?: number;
    savesCount?: number;
  };
  boostOf?: unknown;
  quoteOf?: unknown;
  /** The author's lane for this post — the `› Lane name` chip. Local curation only. */
  laneId?: string;
  /** The community the post was published in (an ActivityPub `Group`'s Oxy account). */
  communityOxyUserId?: string | null;
  originalPostId?: unknown;
  parentPostId?: unknown;
  threadId?: unknown;
  replyPermission?: string[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  /**
   * The stored top-level column (`posts.is_edited`), true once the BODY was
   * replaced. Declared here rather than reached through the index signature so
   * hydration reads a `boolean`, not an `unknown`. The sibling `editHistory`
   * column is deliberately NOT declared: hydration has no business reading it.
   */
  isEdited?: boolean;
  /** Corrections MADE to this post's body — see `post_corrections`. */
  correctionCount?: number;
  lastCorrectedAt?: unknown;
  hashtags?: string[];
  mentions?: unknown[];
  /** A `direct` post's recipients (Oxy user ids) — with its author, its only readers. */
  recipients?: unknown[];
  visibility?: string;
  status?: string;
  scheduledFor?: unknown;
  language?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  date?: unknown;
  /** Allow additional fields from lean/toObject results */
  [key: string]: unknown;
}

export interface HydrationOptions {
  /** Who Safety decides for, independent of display/ranking viewer IDs. */
  safetyRequester?: SafetyRequester;
  /** Only create/edit-source responses: nested references remain ordinary reads. */
  manageOwnPostIds?: readonly string[];
  viewerId?: string;
  oxyClient?: OxyClient; // Per-request OxyServices instance with user's auth token
  maxDepth?: number;
  includeLinkMetadata?: boolean;
  includeFullArticleBody?: boolean; // For feed, skip full article bodies
  includeFullMetadata?: boolean; // For feed, skip some metadata fields
  /**
   * When hydrating posts for public federation surfaces, referenced posts
   * (boost/quote originals) must not bypass their own publication controls.
   * Root posts are still supplied by the caller's query; this only constrains
   * graph expansion by id.
   */
  publicReferencesOnly?: boolean;
  /**
   * The viewer's already-resolved social graph, threaded from the feed context
   * (`loadViewerFeedContext`). When present, {@link buildViewerContext} populates
   * the viewer follows/followedBy sets from these ids and SKIPS the per-request
   * `getUserFollowing`/`getUserFollowers` Oxy round trips (the feed already
   * resolved them once, in parallel). When absent — every non-feed caller (post
   * detail, notifications, profile, search) — hydration falls back to the live
   * Oxy fetch, so those paths are unchanged. Both id lists are required together
   * (the feed always threads both) so the graph is applied atomically.
   */
  viewerGraph?: ViewerGraphContext;
  /**
   * The viewer's already-resolved Oxy privacy lists, threaded from the feed
   * controller's `UserPrivacyManager.loadPrivacyState`. Exactly the same
   * arrangement as {@link viewerGraph} above, for exactly the same reason: the
   * feed resolves these once, up front and in parallel with everything else, and
   * without threading them {@link buildViewerContext} asks Oxy the same two
   * questions again on EVERY hydration call the page makes.
   *
   * Measured on an authenticated For You page (which hydrates two to three
   * times): `getBlockedUsers` ran 3× and `getRestrictedUsers` 2× per request,
   * four of those five being byte-identical repeats of a list the controller had
   * already fetched. Each one is an HTTP round trip to Oxy on the critical path.
   *
   * Threading is what makes the fail-CLOSED contract survive, not something that
   * weakens it: these ids only exist because `getBlockedUserIds` /
   * `getRestrictedUserIds` already succeeded for this request, and those throw
   * rather than return an empty list when Oxy cannot answer. A caller that has
   * not resolved them omits this and keeps the live fetch — every non-feed path
   * (post detail, notifications, profile, search) is unchanged.
   *
   * Both lists are required together so the privacy state is applied atomically;
   * a half-threaded state would hydrate with real blocks and an empty restricted
   * set, which reads as "this viewer restricts nobody".
   */
  viewerPrivacy?: ViewerPrivacyContext;
  /**
   * The language preference carried by the REQUEST, from
   * {@link requestLanguageCandidates}: an explicit `?lang=` the reader picked,
   * which leads the variant-resolution ladder, and `Accept-Language`, which
   * comes LAST — below the viewer's Oxy account locales, so a device default
   * never outranks what a signed-in reader declared ({@link languageLadder}). A
   * caller with no request context (the OG renderer, MCP, a socket broadcast)
   * omits it and gets the post's primary language, which is what those surfaces
   * should show.
   */
  requestLanguages?: RequestLanguages;
  /**
   * The viewer's Oxy account locales, when the caller already resolved them (the
   * feed does, in `loadViewerFeedContext`). Absent → {@link buildViewerContext}
   * reads them itself, from Oxy with {@link oxyClient} (`loadViewerLanguages`).
   */
  viewerLanguages?: string[];
  /**
   * Count the posts that quote each hydrated post and expose them as
   * `engagement.quotes`. Off by default: there is no denormalized `quotesCount`
   * on `stats`, so this costs one extra aggregate over the `quoteOf` index per
   * hydration call — worth it on the post-detail endpoints that render the
   * number, wasted on every feed request that does not.
   */
  includeQuoteCounts?: boolean;
  /**
   * Attach the community note CrowdSource shows under each post, when there is
   * one.
   *
   * ON by default, because a note is part of what a reader sees and nearly every
   * caller here is rendering posts TO a reader. It costs one batched Redis read
   * per hydration — the lookup is cached per post, including a negative entry for
   * the overwhelming majority that have no note — and one CrowdSource call per 50
   * posts whose entries have expired. Where Mention cannot authenticate to
   * CrowdSource it costs nothing at all: there is no client, so nothing is asked.
   *
   * Pass `false` from the paths that hydrate a post the SAME request just wrote
   * or edited. A post that did not exist a moment ago cannot carry a note, and
   * asking about it would put a CrowdSource round trip on the posting path, where
   * the answer is known in advance.
   *
   * Only the posts the caller asked for are looked up. A boost original or a
   * quoted post pulled into the graph is not: the note belongs under the post
   * being read, and the app does not render one inside a nested row.
   */
  includeCommunityNotes?: boolean;
  /**
   * Accounts this viewer OPERATES — today, the channels they are an active member
   * of, as resolved by `listOperatedChannelIds`.
   *
   * A channel AUTHORS its own posts, so `oxyUserId` on a channel post is an
   * account NOBODY can be signed in as (`isDelegatedActAsEligibleKind` refuses a channel as
   * a session subject). The ACL's ownership test is an id comparison against that
   * author, so without this every unpublished channel post is unreadable by every
   * human alive — measured, including by the person who wrote it.
   *
   * Pass this when the caller has ALREADY resolved the set for its own reasons
   * (`getScheduledPosts` scopes its query with it, and feeding the query and the
   * ACL from one resolution is what keeps the two from disagreeing). Every other
   * caller passes {@link operatedAccountReader} instead and lets hydration decide
   * whether the round trip is worth making.
   *
   * Supplying it — even as an empty array — SUPPRESSES that decision: an explicit
   * answer is never second-guessed by a lazy one.
   *
   * It widens READ only. What a member may DO with the post they can now see is
   * still `postManagementRefusal`'s answer, asked per action on the write routes.
   */
  operatedAccountIds?: readonly string[];
  /**
   * How to resolve {@link operatedAccountIds} IF a post in this batch turns out
   * to need it — the caller's own Oxy client, since `GET /accounts` is anchored
   * on the authenticated operator and honours no service delegation.
   *
   * A capability rather than a value, because the answer costs an Oxy round trip
   * and almost nothing needs it. `mayNeedCurrentChannelAuthority` decides, off
   * columns already in hand: the post must be withheld from this viewer AND
   * authored by an account on somebody's behalf. A feed of published posts asks
   * Oxy nothing, an ordinary post-detail read asks nothing, and a channel's own
   * published posts ask nothing — the trip is made only for a withheld
   * account-authored post, which is the one case where the answer can change the
   * verdict.
   *
   * **Omitting it is fail-CLOSED, and that is the failure worth knowing about.**
   * A surface that can serve a withheld channel post and does not pass this
   * refuses that post to every human alive, including its own writer — the black
   * hole the stored-writer clause used to paper over. Every id-based surface that
   * can reach such a post passes it; the tests that pin this are behavioural, one
   * per surface, so a new surface that forgets shows up as a person unable to read
   * their own queued post rather than as a leak.
   */
  operatedAccountReader?: OperatedAccountReader;
}

export interface HydratedGraphNode {
  post: RawPost;
  depth: number;
}

export interface ViewerContext {
  viewerId?: string;
  /**
   * The viewer's ordered language preference — an explicit `?lang`, then the Oxy
   * account locales, then `Accept-Language` ({@link languageLadder}). This is
   * the ladder `resolveViewerTag` walks to pick which localized rendition of each
   * post to serve. Empty for an anonymous reader with no header (a crawler), which
   * resolves every post to its primary language.
   */
  languageCandidates: string[];
  blockedIds: Set<string>;
  restrictedIds: Set<string>;
  follows: Set<string>;
  followedBy: Set<string>;
  likedPosts: Set<string>;
  downvotedPosts: Set<string>;
  savedPosts: Set<string>;
  boostedPosts: Set<string>;
  /** Author IDs with private or followers_only profile visibility */
  privateProfileIds: Set<string>;
  /**
   * Accounts the viewer operates, from {@link HydrationOptions.operatedAccountIds}.
   * EMPTY on every caller that does not opt in, which is every caller but the
   * scheduled queue — see that option for why this is not resolved here.
   */
  operatedAccountIds: Set<string>;
}

export interface ExtendedViewerContext extends ViewerContext {
  _channelAuthorityResolved?: boolean;
  includeFullArticleBody?: boolean;
  includeFullMetadata?: boolean;
  _authorPrivacyCache?: Map<string, typeof DEFAULT_PRIVACY>;
}
