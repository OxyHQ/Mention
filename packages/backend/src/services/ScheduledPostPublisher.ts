import { Post } from '../models/Post';
import { logger } from '../utils/logger';
import { postCreationService } from './PostCreationService';

/**
 * ScheduledPostPublisher — publishes scheduled posts whose time has arrived.
 *
 * A post created with `status: 'scheduled'` and a future `scheduledFor` is saved
 * WITHOUT running any publish side-effects (collaborator invites, MTN dual-write,
 * notifications, real-time feed emit, federation) — those are all deferred to the
 * moment it actually goes live. This publisher sweeps for due scheduled posts and
 * drives each one through `PostCreationService.publishScheduledPost`, which flips
 * the status to `published` and runs the exact same publish pipeline a fresh
 * post runs.
 *
 * Driven on a 60s cadence by {@link FeedJobScheduler}, which is itself only
 * started on the elected scheduler leader — so this sweep runs on exactly one
 * backend task. Each post is isolated (`Promise.allSettled`) so one failing post
 * never sinks the batch, and an in-flight guard prevents overlapping sweeps if a
 * batch runs long.
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
      const duePosts = await Post.find({
        status: 'scheduled',
        scheduledFor: { $lte: now },
      })
        .sort({ scheduledFor: 1 })
        .limit(this.BATCH_SIZE);

      if (duePosts.length === 0) {
        return 0;
      }

      const results = await Promise.allSettled(
        duePosts.map((post) => postCreationService.publishScheduledPost(post)),
      );

      let published = 0;
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          published += 1;
        } else {
          logger.error('ScheduledPostPublisher: failed to publish scheduled post', {
            postId: String(duePosts[i]?._id),
            error: result.reason,
          });
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
}

export const scheduledPostPublisher = new ScheduledPostPublisher();
