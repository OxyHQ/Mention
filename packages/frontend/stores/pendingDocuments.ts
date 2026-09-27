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

/** How many times each post has been asked for. */
const attempts = new Map<string, number>();
/** When each waiting id is due to be asked for. */
const dueAt = new Map<string, number>();
const inFlight = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(postId: string, delayMs: number): void {
  dueAt.set(postId, Date.now() + delayMs);
  armTimer();
}

function armTimer(): void {
  if (timer || dueAt.size === 0) return;
  const next = Math.min(...dueAt.values());
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, Math.max(0, next - Date.now()));
}

function applyAnswer(postId: string, entry: PostDocumentsResponse['posts'][string] | undefined): void {
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
    attempts.set(postId, (attempts.get(postId) ?? 0) + 1);
  }
  armTimer();
  if (ids.length === 0) return;

  let answer: PostDocumentsResponse | null = null;
  try {
    answer = await feedService.getPostDocuments(ids);
  } catch (error) {
    logger.debug('Pending link cards could not be fetched', { count: ids.length, error });
  }

  for (const postId of ids) {
    inFlight.delete(postId);
    const entry = answer?.posts[postId];
    if (answer) applyAnswer(postId, entry);

    const stillPending = answer ? entry?.documentsPending === true : true;
    const retryDelay = RETRY_DELAYS_MS[(attempts.get(postId) ?? 1) - 1];
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
 * Safe to call on every render: an id already waiting, in flight, or out of
 * retries is not asked for again.
 */
export function requestPendingDocuments(postId: string): void {
  if (!postId || dueAt.has(postId) || inFlight.has(postId)) return;
  const asked = attempts.get(postId) ?? 0;
  if (asked > RETRY_DELAYS_MS.length) return;
  schedule(postId, asked === 0 ? FIRST_ASK_DELAY_MS : RETRY_DELAYS_MS[asked - 1]);
}

/**
 * Watch every post the cache stores and ask for the cards of the pending ones.
 * Mounted once at the app root; returns the unsubscribe.
 */
export function registerPendingDocuments(): () => void {
  return onPostsStored((posts) => {
    for (const post of posts) {
      if (post.documentsPending === true && post.id) requestPendingDocuments(String(post.id));
      // A boost or quote carries its embedded post, whose cards are its own.
      const nested = [post.quotedPost, post.originalPost, post.boost?.originalPost];
      for (const embedded of nested) {
        if (embedded?.documentsPending === true && embedded.id) requestPendingDocuments(String(embedded.id));
      }
    }
  });
}

/** Test seam: forget every scheduled and in-flight ask. */
export function resetPendingDocumentsForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  attempts.clear();
  dueAt.clear();
  inFlight.clear();
}
