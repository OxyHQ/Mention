import { MAX_POST_DOCUMENTS_BATCH } from '@mention/shared-types/post';
import type { PostDocumentsResponse } from '@mention/shared-types';
import { logger } from '@oxy.so/core/logger';
import { feedService } from '@/services/feedService';
import { usePostsStore } from './postsStore';
import { onPostsStored } from '@/db/postObservers';

/**
 * LINK CARDS THAT WERE NOT READY ON THE FIRST READ.
 *
 * A feed or post read answers with the cards Clarity already has, and never
 * waits for the rest (issue #1140). A post whose link Clarity is still indexing
 * therefore arrives with `documentsPending` and no card for that link: typically
 * a remote profile's older posts, the first time anyone here opens it. Before
 * this, that empty `documents` was treated as final and cached, so the post
 * never got its card until something happened to refetch it.
 *
 * Every post the local cache stores with `documentsPending` is passed to
 * {@link requestPendingDocuments} ({@link registerPendingDocuments}, mounted once
 * at the app root) — no per-row hook, so a feed row costs nothing extra.
 * Ids are gathered into ONE `POST /posts/documents` call (the server holds it
 * open for a few seconds while Clarity finishes), and each answer is written
 * back through `updatePostEverywhere`, so every surface showing that post, and
 * its cached copy, gets the card. A post still pending is asked for again after a
 * longer pause, a bounded number of times; after that its cards are left for the
 * next ordinary read.
 */

/** Gather the ids a screenful of posts reports before asking. */
const FIRST_ASK_DELAY_MS = 1_500;

/** The pauses before asking again for a post that is still pending. */
const RETRY_DELAYS_MS = [5_000, 15_000] as const;

/** Ids due within this window of the earliest one go out in the same call. */
const BATCH_WINDOW_MS = 1_000;

/**
 * How many times each post has been asked for, and for which VERSION of the
 * post (`metadata.updatedAt`). An edit can add a link, so an edited post starts
 * a fresh budget instead of inheriting one a previous version used up.
 */
const attempts = new Map<string, { version: string; count: number }>();
/** When each waiting id is due to be asked for. */
const dueAt = new Map<string, number>();
const inFlight = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** When the armed timer fires, so a sooner deadline can take its place. */
let timerDue = Infinity;
/**
 * Bumped by {@link resetPendingDocuments} (an account switch). An answer that
 * arrives for an older generation belongs to the previous viewer and is dropped
 * rather than written into the next viewer's posts.
 */
let generation = 0;

function schedule(postId: string, delayMs: number): void {
  dueAt.set(postId, Date.now() + delayMs);
  armTimer();
}

function armTimer(): void {
  if (dueAt.size === 0) return;
  const next = Math.min(...dueAt.values());
  // A new, sooner post must not wait behind a retry's longer deadline.
  if (timer && next >= timerDue) return;
  if (timer) clearTimeout(timer);
  timerDue = next;
  timer = setTimeout(
    () => {
      timer = null;
      timerDue = Infinity;
      void flush();
    },
    Math.max(0, next - Date.now()),
  );
}

function attemptsFor(postId: string): number {
  return attempts.get(postId)?.count ?? 0;
}

function applyAnswer(
  postId: string,
  entry: PostDocumentsResponse['posts'][string] | undefined,
): void {
  usePostsStore.getState().updatePostEverywhere(postId, (prev) => ({
    ...prev,
    // An id the server did not answer for is one this viewer may not read (or
    // that is gone): stop asking, and keep whatever cards the post already had.
    documents: entry ? entry.documents : prev.documents,
    documentsPending: entry?.documentsPending === true ? true : undefined,
  }));
}

async function flush(): Promise<void> {
  const cutoff = Date.now() + BATCH_WINDOW_MS;
  const ids = [...dueAt.entries()]
    .filter(([, due]) => due <= cutoff)
    .sort(([, a], [, b]) => a - b)
    .slice(0, MAX_POST_DOCUMENTS_BATCH)
    .map(([postId]) => postId);
  for (const postId of ids) {
    dueAt.delete(postId);
    inFlight.add(postId);
    const entry = attempts.get(postId);
    if (entry) entry.count += 1;
  }
  armTimer();
  if (ids.length === 0) return;
  const askedIn = generation;

  let answer: PostDocumentsResponse | null = null;
  try {
    answer = await feedService.getPostDocuments(ids);
  } catch (error) {
    logger.debug('Pending link cards could not be fetched', { count: ids.length, error });
  }
  // The viewer changed while this was in flight: these are the previous
  // viewer's cards, and the state they were counted in is already gone.
  if (askedIn !== generation) return;

  for (const postId of ids) {
    inFlight.delete(postId);
    const entry = answer?.posts[postId];
    if (answer) applyAnswer(postId, entry);

    const stillPending = answer ? entry?.documentsPending === true : true;
    const retryDelay = RETRY_DELAYS_MS[(attemptsFor(postId) || 1) - 1];
    if (stillPending && retryDelay !== undefined) {
      schedule(postId, retryDelay);
    } else if (!answer) {
      // Out of retries without ever reaching the server: stop asking for now, and
      // leave the flag so the next ordinary read of the post decides afresh.
      attempts.delete(postId);
    }
  }
}

/**
 * Ask, soon, for the cards of a post whose read came back `documentsPending`.
 * Safe to call on every store write: an id already waiting, in flight, or out of
 * retries for this `version` of the post is not asked for again.
 */
export function requestPendingDocuments(postId: string, version = ''): void {
  if (!postId || dueAt.has(postId) || inFlight.has(postId)) return;
  const known = attempts.get(postId);
  if (!known || known.version !== version) attempts.set(postId, { version, count: 0 });
  const asked = attemptsFor(postId);
  if (asked > RETRY_DELAYS_MS.length) return;
  schedule(postId, asked === 0 ? FIRST_ASK_DELAY_MS : RETRY_DELAYS_MS[asked - 1]);
}

/** The version a stored post is at, for {@link requestPendingDocuments}. */
function versionOf(post: { metadata?: { updatedAt?: unknown } }): string {
  const updatedAt = post.metadata?.updatedAt;
  return typeof updatedAt === 'string' ? updatedAt : '';
}

/**
 * Watch every post the cache stores and ask for the cards of the pending ones.
 * Mounted once at the app root; returns the unsubscribe.
 */
export function registerPendingDocuments(): () => void {
  return onPostsStored((posts) => {
    for (const post of posts) {
      if (post.documentsPending === true && post.id)
        requestPendingDocuments(String(post.id), versionOf(post));
      // A boost or quote carries its embedded post, whose cards are its own.
      const nested = [post.quotedPost, post.originalPost, post.boost?.originalPost];
      for (const embedded of nested) {
        if (embedded?.documentsPending === true && embedded.id) {
          requestPendingDocuments(String(embedded.id), versionOf(embedded));
        }
      }
    }
  });
}

/**
 * Forget every scheduled and in-flight ask. Called on an account switch, so the
 * previous viewer's answers are dropped when they land; also the test seam.
 */
export function resetPendingDocuments(): void {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = null;
  timerDue = Infinity;
  attempts.clear();
  dueAt.clear();
  inFlight.clear();
}
