/**
 * MTN dual-write emitter — the ONE place that decides WHETHER and WHAT to emit
 * for each native write, so every call site is a clean, isolated one-liner.
 *
 * Dual-write contract (Workstream B / B1):
 *  - Postgres stays AUTHORITATIVE. Record emission is a best-effort SIDE-EFFECT that
 *    NEVER blocks the response and NEVER changes endpoint output.
 *  - Emission is gated on a LOCAL author: `federation == null && oxyUserId`.
 *    Federated/remote-authored content NEVER emits (those records belong to the
 *    origin instance, not Mention).
 *  - A POST is additionally gated on being PUBLISHED and PUBLIC. A record is
 *    readable on the public atproto bridge, so a draft or a private /
 *    followers-only post must never reach the chain at all.
 *  - Every emit is wrapped so it cannot throw to the caller (it logs on failure).
 *    Callers still place the call inside their existing `Promise.allSettled`
 *    side-effect block.
 *
 * Feeds/hydration/ranking do NOT read `MentionSignedRecord` in this phase — the
 * chain is written-only until the B2 source-of-truth pivot.
 */

import type { PostRecord } from '../../db/posts/postRecord';
import {
  PostVisibility,
  MENTION_POST_COLLECTION,
  MENTION_LIKE_COLLECTION,
  MENTION_REPOST_COLLECTION,
  MENTION_TOMBSTONE_COLLECTION,
  MENTION_BOOKMARK_COLLECTION,
  createPostUri,
  createLikeUri,
  createRepostUri,
  createBookmarkUri,
  type MtnFacet,
} from '@mention/shared-types';
import { logger } from '../../utils/logger';
import { signAndAppend } from './MentionRecordService';
import {
  buildPostRecord,
  buildLikeRecord,
  buildRepostRecord,
  buildTombstoneRecord,
  buildBookmarkRecord,
  resolvePostRecordEmbeds,
  type ReplyContext,
} from './mentionRecordBuilders';

/** True when a post is authored by a LOCAL Mention user (eligible to emit). */
function isLocalAuthored(
  post: Pick<PostRecord, 'federation' | 'oxyUserId'>,
): post is Pick<PostRecord, 'federation' | 'oxyUserId'> & { oxyUserId: string } {
  return post.federation == null && typeof post.oxyUserId === 'string' && post.oxyUserId.length > 0;
}

/** True when a post is safe to publish to public MTN/atproto read surfaces. */
function isPublicPublishedPost(post: Pick<PostRecord, 'status' | 'visibility'>): boolean {
  return post.status === 'published' && post.visibility === PostVisibility.PUBLIC;
}

/**
 * Project a typed lexicon payload onto the envelope's opaque `record` shape
 * (`Record<string, unknown>`) without a cast. A TS `interface` has no implicit
 * index signature, so it is not directly assignable to `Record<string, unknown>`;
 * rebuilding it from its own entries yields a genuine `Record<string, unknown>`.
 * The payload is plain JSON, so this is a faithful, lossless projection.
 */
function toRecordPayload(payload: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload));
}

interface DurableEmissionIdentity {
  idempotencyKey?: string;
  issuedAt?: Date | number;
}

function emissionDate(value: Date | number | undefined): Date | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value : new Date(value);
}

/**
 * Run `work` fully isolated: it never throws to the caller and never blocks
 * (callers await it inside a `Promise.allSettled`, but a throw here is still
 * swallowed + logged so a bug can never surface as a request failure).
 */
async function isolate(label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    logger.error(`MentionRecordEmitter: ${label} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function requireAppend(
  label: string,
  work: () => ReturnType<typeof signAndAppend>,
): Promise<void> {
  const result = await work();
  // Disabled is a deliberate feature gate, not a transient delivery failure.
  if (result.ok || result.reason === 'disabled') return;
  throw new Error(`${label} append failed: ${result.reason}`);
}

/**
 * Emit an `app.mention.feed.post` record for a freshly-created LOCAL post (incl.
 * replies and quotes). Federated posts and missing-author posts are a no-op.
 *
 * @param reply Resolved reply context (root/parent owner ids) when the post is a
 *              reply; omitted for top-level posts.
 */
export async function emitPostCreated(
  post: PostRecord,
  options: { reply?: ReplyContext; facets?: MtnFacet[] } = {},
): Promise<void> {
  if (!isLocalAuthored(post) || !isPublicPublishedPost(post)) return;
  const authorOxyUserId = post.oxyUserId;
  await isolate('emitPostCreated', async () => {
    // Resolve every media item the post references — the shared set and each
    // author variant's override — to content-addressed blob refs (fileId →
    // sha256), in one batched lookup. Fail-soft inside the resolver: a lookup
    // error yields no embeds (the record is still emitted, just without media),
    // so this never blocks the record.
    const embeds = await resolvePostRecordEmbeds(post);
    await signAndAppend(
      authorOxyUserId,
      MENTION_POST_COLLECTION,
      post.id,
      toRecordPayload(buildPostRecord(post, { ...options, embeds })),
    );
  });
}

/**
 * Emit an `app.mention.feed.repost` record for a LOCAL boost. `boost` is the
 * boost Post (its `id` is the record key); `repostedPostOwnerOxyUserId` is the
 * owner of the boosted original (for the subject URI).
 */
export async function emitRepostCreated(
  boost: PostRecord,
  repostedPostId: string,
  repostedPostOwnerOxyUserId: string | undefined,
): Promise<void> {
  if (!isLocalAuthored(boost) || !repostedPostOwnerOxyUserId) return;
  const boosterOxyUserId = boost.oxyUserId;
  const ownerOxyUserId = repostedPostOwnerOxyUserId;
  await isolate('emitRepostCreated', async () => {
    await signAndAppend(
      boosterOxyUserId,
      MENTION_REPOST_COLLECTION,
      boost.id,
      toRecordPayload(buildRepostRecord({
        repostedPostId,
        repostedPostOwnerOxyUserId: ownerOxyUserId,
        createdAt: boost.createdAt,
      })),
    );
  });
}

/**
 * Emit an `app.mention.feed.like` record. The like record's `rkey` is the like's
 * own id (a `(liker, post)` composite key) so an unlike can tombstone it.
 */
export async function emitLikeCreated(args: {
  likerOxyUserId: string;
  likeRkey: string;
  likedPostId: string;
  likedPostOwnerOxyUserId: string | undefined;
}): Promise<void> {
  await isolate('emitLikeCreated', () => emitLikeCreatedStrict(args));
}

export async function emitLikeCreatedStrict(args: {
  likerOxyUserId: string;
  likeRkey: string;
  likedPostId: string;
  likedPostOwnerOxyUserId: string | undefined;
} & DurableEmissionIdentity): Promise<void> {
  const likedPostOwnerOxyUserId = args.likedPostOwnerOxyUserId;
  if (!likedPostOwnerOxyUserId) return;
  await requireAppend('emitLikeCreated', () => signAndAppend(
    args.likerOxyUserId,
    MENTION_LIKE_COLLECTION,
    args.likeRkey,
    toRecordPayload(buildLikeRecord({
      likedPostId: args.likedPostId,
      likedPostOwnerOxyUserId,
      createdAt: emissionDate(args.issuedAt),
    })),
    {
      idempotencyKey: args.idempotencyKey,
      issuedAt: args.issuedAt,
    },
  ));
}

/**
 * Emit an `app.mention.feed.tombstone` record that supersedes a previously
 * published record (an unlike, a delete, an unboost). `subjectUri` is the MTN
 * URI of the record being removed; `tombstoneRkey` is the deleted record's rkey
 * so the tombstone materializes as a last-writer-wins removal of that key.
 */
export async function emitTombstone(args: {
  authorOxyUserId: string;
  tombstoneRkey: string;
  subjectUri: string;
}): Promise<void> {
  await isolate('emitTombstone', () => emitTombstoneStrict(args));
}

export async function emitTombstoneStrict(args: {
  authorOxyUserId: string;
  tombstoneRkey: string;
  subjectUri: string;
} & DurableEmissionIdentity): Promise<void> {
  await requireAppend('emitTombstone', () => signAndAppend(
    args.authorOxyUserId,
    MENTION_TOMBSTONE_COLLECTION,
    args.tombstoneRkey,
    toRecordPayload(buildTombstoneRecord({
      subjectUri: args.subjectUri,
      createdAt: emissionDate(args.issuedAt),
    })),
    {
      idempotencyKey: args.idempotencyKey,
      issuedAt: args.issuedAt,
    },
  ));
}

/**
 * Emit an `app.mention.feed.bookmark` record (PRIVATE). The bookmark's `rkey` is
 * its own id so an unsave can tombstone it.
 */
export async function emitBookmarkCreated(args: {
  ownerOxyUserId: string;
  bookmarkRkey: string;
  bookmarkedPostId: string;
  bookmarkedPostOwnerOxyUserId: string | undefined;
}): Promise<void> {
  await isolate('emitBookmarkCreated', () => emitBookmarkCreatedStrict(args));
}

export async function emitBookmarkCreatedStrict(args: {
  ownerOxyUserId: string;
  bookmarkRkey: string;
  bookmarkedPostId: string;
  bookmarkedPostOwnerOxyUserId: string | undefined;
} & DurableEmissionIdentity): Promise<void> {
  const bookmarkedPostOwnerOxyUserId = args.bookmarkedPostOwnerOxyUserId;
  if (!bookmarkedPostOwnerOxyUserId) return;
  await requireAppend('emitBookmarkCreated', () => signAndAppend(
    args.ownerOxyUserId,
    MENTION_BOOKMARK_COLLECTION,
    args.bookmarkRkey,
    toRecordPayload(buildBookmarkRecord({
      bookmarkedPostId: args.bookmarkedPostId,
      bookmarkedPostOwnerOxyUserId,
      createdAt: emissionDate(args.issuedAt),
    })),
    {
      idempotencyKey: args.idempotencyKey,
      issuedAt: args.issuedAt,
    },
  ));
}

/* -------------------------------------------------------------------------- */
/*  URI helpers re-exposed for tombstone subjects (the deleted record's URI).  */
/* -------------------------------------------------------------------------- */

/** The MTN URI of a like record (the subject of its tombstone on unlike). */
export function likeRecordUri(likerOxyUserId: string, likeRkey: string): string {
  return createLikeUri(likerOxyUserId, likeRkey);
}

/** The MTN URI of a repost record (the subject of its tombstone on unboost). */
export function repostRecordUri(boosterOxyUserId: string, repostRkey: string): string {
  return createRepostUri(boosterOxyUserId, repostRkey);
}

/** The MTN URI of a post record (the subject of its tombstone on delete). */
export function postRecordUri(authorOxyUserId: string, postId: string): string {
  return createPostUri(authorOxyUserId, postId);
}

/** The MTN URI of a bookmark record (the subject of its tombstone on unsave). */
export function bookmarkRecordUri(ownerOxyUserId: string, bookmarkRkey: string): string {
  return createBookmarkUri(ownerOxyUserId, bookmarkRkey);
}
