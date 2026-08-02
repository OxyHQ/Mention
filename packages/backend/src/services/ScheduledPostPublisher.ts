import { and, asc, eq, lte } from 'drizzle-orm';
import { findPostRecords } from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import { posts } from '../db/schema/posts';
import { logger } from '../utils/logger';
import { postCreationService } from './PostCreationService';
import { orderScheduledChains } from './scheduledChain';

/**
 * ScheduledPostPublisher — publishes scheduled posts whose time has arrived.
 *
 * A post created with `status: 'scheduled'` and a future `scheduledFor` is saved
 * WITHOUT running any publish side-effects (collaborator invites, MTN dual-write,
 * notifications, real-time feed emit, federation) — those are all deferred to the
 * moment it actually goes live. This publisher sweeps for due scheduled posts and
 * drives each one through `PostCreationService.claimAndPublishScheduledPost`,
 * which claims the post out of `status: 'scheduled'` and then runs the exact same
 * publish pipeline a fresh post runs.
 *
 * Driven on a 60s cadence by {@link FeedJobScheduler}, which is itself only
 * started on the elected scheduler leader — so this sweep runs on exactly one
 * backend task. An in-flight guard prevents overlapping sweeps if a batch runs
 * long.
 *
 * **A scheduled THREAD publishes as one unit, parent first.** Its continuations
 * are replies to one another and all carry the same `scheduledFor`, so a flat
 * `Promise.allSettled` over the due set would race them and could put a reply on
 * screen before the post it answers. The due set is therefore grouped into
 * chains (`orderScheduledChains`): chains run concurrently and are isolated from
 * each other, but the posts WITHIN a chain run in sequence, and a chain stops at
 * its first failure so nothing downstream of a post that did not publish can
 * publish either. Independent posts — a beast batch, a lone scheduled post — are
 * single-element chains, so they keep exactly the concurrency they had.
 *
 * The ordering here is for liveness: it makes a thread arrive whole, in order,
 * on one tick. It is NOT what makes the invariant safe — the claim itself
 * refuses a post whose parent has not published, which holds under any
 * interleaving and under a partial failure. See `services/scheduledChain.ts`.
 */
class ScheduledPostPublisher {
  /** Max scheduled posts published per sweep — bounds a single tick's work. */
  private readonly BATCH_SIZE = 100;

  /** Guard so a slow sweep never overlaps the next 60s tick. */
  private running = false;

  /**
   * Publish every scheduled post whose `scheduledFor` is now in the past.
   * Returns the number of posts successfully published. Never throws.
   */
  async publishDuePosts(now: Date = new Date()): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      // `scheduled_for` is NOT NULL for every row this predicate can match (the
      // partial index `posts_scheduled_idx` is built on exactly this status), so
      // the ascending sort has no NULL ordering to disagree with Mongo about.
      const duePosts = await findPostRecords(
        and(eq(posts.status, 'scheduled'), lte(posts.scheduledFor, now)),
        { orderBy: [asc(posts.scheduledFor)], limit: this.BATCH_SIZE },
      );

      if (duePosts.length === 0) {
        return 0;
      }

      // Chains are independent of one another, so one thread failing must not
      // hold up anybody else's posts.
      const results = await Promise.allSettled(
        orderScheduledChains(duePosts).map((chain) => this.publishChain(chain)),
      );

      let published = 0;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          published += result.value;
        } else {
          // `publishChain` already handles and logs a post that fails, so this
          // arm is only reachable if the chain walk itself threw.
          logger.error('ScheduledPostPublisher: a scheduled chain failed', result.reason);
        }
      }

      if (published > 0) {
        logger.info(`ScheduledPostPublisher: published ${published} scheduled post(s)`);
      }
      return published;
    } catch (error) {
      logger.error('ScheduledPostPublisher: sweep failed', error);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Publish one chain in order, and stop at the first post that does not go out.
   *
   * Claiming each post before publishing it is the point. The sweep is
   * leader-gated so it never races ITSELF — but it does race the author, who can
   * publish the same post early from the composer between the `find` above and
   * the write. The claim is a conditional update on `status: 'scheduled'`, so
   * whichever side gets there first is the only one that publishes.
   *
   * Stopping the chain on a failure — including a lost claim — is what keeps a
   * partial failure from becoming a broken thread. The remaining posts stay
   * `scheduled` and due, so the next sweep retries them from where this one
   * stopped; until then they are simply not visible, which is the safe half of
   * the trade. (A lost claim usually means the author published that post early,
   * in which case the tail would be publishable — but re-deriving that costs a
   * read per post to buy at most 60 seconds, so the chain just waits.)
   */
  private async publishChain(chain: PostRecord[]): Promise<number> {
    let published = 0;
    for (const post of chain) {
      const postId = post.id;
      try {
        const result = await postCreationService.claimAndPublishScheduledPost({ postId });
        if (result === null) {
          // Not an error: somebody else claimed it first, or it is still behind
          // a parent that has not published.
          break;
        }
        published += 1;
      } catch (error) {
        logger.error('ScheduledPostPublisher: failed to publish scheduled post', {
          postId,
          remainingInChain: chain.length - chain.indexOf(post) - 1,
          error,
        });
        break;
      }
    }
    return published;
  }
}

export const scheduledPostPublisher = new ScheduledPostPublisher();
