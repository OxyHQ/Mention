/**
 * Feed-quality LABELED set (Phase 7 eval harness).
 *
 * A small, hand-curated ground-truth set the offline eval (`evalFeedQuality.ts`)
 * scores the feed pipeline against. Each entry tags a real fediverse account (or a
 * specific post) as `junk` or `good` with a human-readable `reason`, and the
 * resolver joins it to the actual `Post` rows it authored so the classifier /
 * discovery gate / ranking can be recomputed over real content.
 *
 * Seeded with the five real For You junk accounts the user reported — all
 * federated, ~zero NATIVE engagement, several off-language — that share the same
 * DNA the discovery gate + v5 classifier target:
 *   1. shortcode/emoji-only (no real prose),
 *   2. an RSS news-mirror bot,
 *   3/4. legitimate humans but off-language (German),
 *   5. an off-language / off-interest webcomic (French).
 *
 * This module is PURE (no Mongoose import): the labels are data, and
 * {@link resolveLabeledPosts} takes its data access — INCLUDING how to read a
 * post's federated actor uri — as injected functions, so it is fully decoupled
 * from any concrete post shape and trivially unit-testable with in-memory mocks.
 * The eval script supplies the Mongo-backed dependencies over `CandidatePost`.
 */

export type FeedQualityLabel = 'junk' | 'good';

/**
 * One labeled entry. Exactly one of `acct` / `activityId` / `postId` identifies
 * the content:
 *   - `acct`       — a federated handle (`user@host`); resolves to that actor's
 *     recent posts (an account-level label, the common case).
 *   - `activityId` — a specific federated activity id (one post).
 *   - `postId`     — a specific Mongo post id (one post).
 */
export interface FeedQualityLabelEntry {
  label: FeedQualityLabel;
  reason: string;
  acct?: string;
  activityId?: string;
  postId?: string;
}

/** A lean federated-actor summary the resolver attaches for classification context. */
export interface LabeledActor {
  uri: string;
  acct: string;
  domain: string;
  /** AP actor type (`Person` / `Service` / `Application` / …) — feeds the bot-shape signal. */
  type: string;
  oxyUserId?: string;
}

/** A labeled entry joined to one of the posts it identifies. */
export interface LabeledPost<TPost> {
  label: FeedQualityLabel;
  reason: string;
  acct?: string;
  actor?: LabeledActor;
  post: TPost;
}

/**
 * Data access for {@link resolveLabeledPosts}, injected so the resolver stays pure
 * and decoupled from any concrete post shape. `TPost` is the caller's lean-post
 * type (the eval uses `CandidatePost`). The eval script supplies Mongo-backed
 * implementations.
 */
export interface LabelResolverDeps<TPost> {
  /** Resolve a federated actor by its `acct` (`user@host`), or `null`. */
  findActorByAcct(acct: string): Promise<LabeledActor | null>;
  /** Resolve a federated actor by its `uri`, or `null`. */
  findActorByUri(uri: string): Promise<LabeledActor | null>;
  /** Resolve up to `limit` recent posts authored by a federated actor. */
  findRecentPostsForActor(actor: LabeledActor, limit: number): Promise<TPost[]>;
  /** Resolve a single post by Mongo id, or `null`. */
  findPostById(postId: string): Promise<TPost | null>;
  /** Resolve a single post by federation `activityId`, or `null`. */
  findPostByActivityId(activityId: string): Promise<TPost | null>;
  /** Read a post's federated actor uri (so the resolver can attach the right actor). */
  actorUriOf(post: TPost): string | undefined;
  /** Cap on posts resolved per account-level (`acct`) label. Default {@link DEFAULT_MAX_POSTS_PER_ACCT}. */
  maxPostsPerAcct?: number;
}

/** Default cap on posts resolved per account-level label. */
export const DEFAULT_MAX_POSTS_PER_ACCT = 10;

/**
 * The seeded labeled set. Extend with `good` exemplars (and more junk shapes) as
 * the feed is tuned; the eval's gate precision becomes meaningful once `good`
 * entries exist to measure false rejections against.
 */
export const FEED_QUALITY_LABELS: FeedQualityLabelEntry[] = [
  {
    label: 'junk',
    acct: 'neobrown9_m@misskey.io',
    reason: 'shortcode-only: custom-emoji :shortcodes: with no real prose',
  },
  {
    label: 'junk',
    acct: 'denfaminicogamer@rss-mstdn.studiofreesia.com',
    reason: 'rss-bot: automated news mirror, zero native engagement',
  },
  {
    label: 'junk',
    acct: 'honkhase@chaos.social',
    reason: 'off-language (de): legitimate human but off the viewer language, zero native engagement',
  },
  {
    label: 'junk',
    acct: 'isurandil@mastodon.online',
    reason: 'off-language (de): off the viewer language, zero native engagement',
  },
  {
    label: 'junk',
    acct: 'davidrevoy@framapiaf.org',
    reason: 'off-language (fr) / off-interest: decent webcomic but not relevant to the viewer',
  },
];

/** Attach the resolving actor (by the post's federation actorUri) to a labeled post. */
async function toLabeledPost<TPost>(
  entry: FeedQualityLabelEntry,
  post: TPost,
  deps: LabelResolverDeps<TPost>,
): Promise<LabeledPost<TPost>> {
  const actorUri = deps.actorUriOf(post);
  const actor = actorUri ? (await deps.findActorByUri(actorUri)) ?? undefined : undefined;
  return { label: entry.label, reason: entry.reason, acct: entry.acct, actor, post };
}

/**
 * Resolve the labeled set into concrete {@link LabeledPost}s. Each entry is joined
 * via its most specific identifier (`postId` → `activityId` → `acct`); an entry
 * that resolves to nothing is skipped (best-effort). An `acct` entry can fan out
 * to several posts (its recent authored posts), capped by `maxPostsPerAcct`.
 */
export async function resolveLabeledPosts<TPost>(
  entries: readonly FeedQualityLabelEntry[],
  deps: LabelResolverDeps<TPost>,
): Promise<LabeledPost<TPost>[]> {
  const maxPerAcct = deps.maxPostsPerAcct ?? DEFAULT_MAX_POSTS_PER_ACCT;
  const resolved: LabeledPost<TPost>[] = [];

  for (const entry of entries) {
    if (entry.postId) {
      const post = await deps.findPostById(entry.postId);
      if (post) resolved.push(await toLabeledPost(entry, post, deps));
      continue;
    }
    if (entry.activityId) {
      const post = await deps.findPostByActivityId(entry.activityId);
      if (post) resolved.push(await toLabeledPost(entry, post, deps));
      continue;
    }
    if (entry.acct) {
      const actor = await deps.findActorByAcct(entry.acct);
      if (!actor) continue;
      const posts = await deps.findRecentPostsForActor(actor, maxPerAcct);
      for (const post of posts) {
        resolved.push({ label: entry.label, reason: entry.reason, acct: entry.acct, actor, post });
      }
    }
  }

  return resolved;
}
