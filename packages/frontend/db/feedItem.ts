import type {
  HydratedPost,
  HydratedPostSummary,
} from '@mention/shared-types';
import type { FeedItem } from './schema';

type TransformOptions = {
  skipRelated?: boolean;
};

/**
 * Add the small set of local rendering/cache fields to the canonical hydrated
 * post contract.
 *
 * This is deliberately not a wire-format normalizer. Every active post endpoint
 * returns HydratedPost/HydratedPostSummary, so accepting `_id`, flat identity
 * fields, top-level viewer flags, or legacy stats here would hide a backend
 * contract regression and could retain another viewer's state.
 */
/**
 * Every key this converter deliberately handles.
 *
 * The list below is not documentation — it is a build gate. `toFeedItem` carries
 * fields one at a time on purpose (a spread would let a legacy cached shape's
 * aliases back in, which `canonicalFeedItem.test.ts` pins), and that shape has a
 * failure mode with no natural detector: every optional field on the DTO can be
 * omitted from the returned literal WITHOUT a type error, and `PostItem` reads
 * `storePost ?? post`, so the cached copy wins and the field is missing on every
 * feed surface while the API response still carries it.
 *
 * It has bitten twice — `replyContext` once, then `lane` and `channel` together,
 * the second time rendering channel posts as "Unknown user" in production.
 *
 * So: add a field to `HydratedPost` and this stops compiling until it is named
 * here AND carried below. That is the whole point; do not widen it to `string`.
 *
 * Removing one is the same class of change and needs the same care: a key that
 * stops being persisted has to move `SCHEMA_VERSION` with it, or every client
 * keeps answering from disk with a payload that still carries it.
 */
type HandledPostKey =
  | 'id' | 'content' | 'attachments' | 'linkPreviews' | 'user' | 'authors'
  | 'authorship' | 'engagement' | 'viewerState' | 'permissions' | 'metadata'
  | 'lane' | 'parentPostId' | 'replyContext'
  | 'originalPost' | 'quotedPost' | 'boost' | 'context';

type UnhandledPostKey = Exclude<keyof HydratedPost, HandledPostKey>;

// Fails to compile naming the offending key when `HydratedPost` grows a field
// that `toFeedItem` does not carry.
const _allPostKeysHandled: [UnhandledPostKey] extends [never] ? true : UnhandledPostKey = true;
void _allPostKeysHandled;

export function toFeedItem(
  post: HydratedPost | HydratedPostSummary,
  options: TransformOptions = {},
): FeedItem {
  const hydrated: HydratedPost = post;
  const mediaIds = post.attachments.media?.map((item) => item.id) ?? [];

  const originalPost = !options.skipRelated && hydrated.originalPost
    ? toFeedItem(hydrated.originalPost, { skipRelated: true })
    : null;
  const quotedPost = !options.skipRelated && hydrated.quotedPost
    ? toFeedItem(hydrated.quotedPost, { skipRelated: true })
    : null;
  const boost = hydrated.boost
    ? {
        ...hydrated.boost,
        originalPost: hydrated.boost.originalPost
          ? toFeedItem(hydrated.boost.originalPost, { skipRelated: true })
          : null,
      }
    : null;

  return {
    id: post.id,
    content: post.content,
    attachments: post.attachments,
    linkPreviews: post.linkPreviews,
    user: post.user,
    authors: post.authors,
    authorship: post.authorship,
    engagement: post.engagement,
    viewerState: post.viewerState,
    permissions: post.permissions,
    metadata: post.metadata,
    parentPostId: post.parentPostId,
    // Carried through explicitly, like every other field here. Drop it and a post
    // that came off this converter renders as a top-level post while the same
    // post rendered straight from the API shows "Replying to @…" — the local
    // cache would be the only surface silently missing its reply context.
    replyContext: post.replyContext,
    // Same rule, and the stakes are higher than the reply context above.
    // `PostItem` reads `storePost ?? post`, so the cached copy WINS — a field
    // dropped here is missing on every feed surface while the raw API response
    // still carries it, and it is optional on `HydratedPost`, so the omission
    // type-checks cleanly and no test that ignores it can see it.
    lane: post.lane,
    originalPost,
    quotedPost,
    boost,
    context: hydrated.context,
    date: post.metadata.createdAt,
    mediaIds,
    allMediaIds: mediaIds,
  };
}
