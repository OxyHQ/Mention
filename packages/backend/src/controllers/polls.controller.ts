import { Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { isLiveEntityId } from '../db/ids';
import { isCheckViolation, isForeignKeyViolation } from '../db/pgErrors';
import { getDb } from '../db/postgres';
import { pollOptions, polls } from '../db/schema/polls';
import { posts } from '../db/schema/posts';
import { createError } from '../utils/error';
import { logger } from '../utils/logger';
import {
  loadPollRecord,
  pollVoteService,
  type PollRecord,
} from '../services/PollVoteService';
import { postHydrationService } from '../services/PostHydrationService';

/** Default poll lifetime when the client does not supply `endsAt`. */
const DEFAULT_POLL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The poll as it goes on the wire.
 *
 * Storage moved from one document with an embedded option array to three tables,
 * and NONE of that may reach a client: `frontend/services/pollService.ts` types
 * `_id` on the poll AND on every option, reads `opt.votes` as an array of voter
 * ids, and names the timestamps `created_at`/`updated_at` — which is what
 * `models/Poll.ts` asked Mongoose for (`timestamps: { createdAt: 'created_at',
 * updatedAt: 'updated_at' }`), not the camelCase every other model uses.
 *
 * `__v` is the one Mongoose artefact NOT reproduced: no reader has ever looked
 * at it, and `schema/CONVENTIONS.md` forbids carrying it into Postgres. Same
 * decision as the batch-0 `LabelService` port.
 *
 * `postId` is omitted when the poll is not yet attached to a post. Mongoose made
 * it `required`, so it was always present — but the value it carried in that
 * state was a `temp_…` placeholder, a write-order artefact the schema
 * deliberately stores as NULL (`db/schema/polls.ts`).
 *
 * A module function, NOT a method: Express registers handlers detached
 * (`router.get('/:id', pollsController.getPoll)`), so a handler reaching this
 * through `this` gets `undefined` at call time and throws — which is exactly
 * how `GET /polls/:id` and the success path of `POST /polls/:id/vote` came to
 * answer 500 in production (the vote was recorded, then the response blew up).
 */
function serializePoll(poll: PollRecord) {
  return {
    _id: poll.id,
    question: poll.question,
    options: poll.options.map((option) => ({
      _id: option.id,
      text: option.text,
      // Anonymous polls expose counts, never voter ids.
      votes: poll.isAnonymous ? option.votes.length : option.votes,
    })),
    ...(poll.postId === null ? {} : { postId: poll.postId }),
    createdBy: poll.createdBy,
    endsAt: poll.endsAt,
    isMultipleChoice: poll.isMultipleChoice,
    isAnonymous: poll.isAnonymous,
    created_at: poll.createdAt,
    updated_at: poll.updatedAt,
  };
}

/**
 * Whether a client-supplied post id is the composer's pre-post placeholder.
 *
 * The composer creates a poll before the post exists and patches the real id in
 * afterwards via `POST /polls/:id/update-post`. Mongo stored the placeholder;
 * `polls.post_id` is a real nullable foreign key, so the placeholder becomes
 * NULL and the column means exactly "not attached yet".
 */
function isTemporaryPostId(value: string): boolean {
  return value.startsWith('temp_');
}

/**
 * A 400 body shaped like the one Mongoose's `ValidationError` branch produced.
 *
 * There is no `ValidationError` in Postgres. The Mongoose validators this
 * replaces were application behaviour with no schema counterpart (`required` on
 * `question`/`postId`/`endsAt`/each option's `text`, and the `Mixed` `postId`
 * shape validator), so they are re-applied at the call site — the rule in
 * `db/schema/CONVENTIONS.md`. `details` is dropped: it was `error.errors`, a
 * Mongoose-internal map with nothing to derive it from.
 */
function validationError(res: Response, message: string) {
  return res.status(400).json({ error: 'Validation Error', message });
}

/**
 * Apply the owning post's canonical read ACL before exposing a poll subresource.
 * An unattached poll is a composer intermediate and is visible only to its
 * creator; once attached, the post gate covers status, visibility, follows,
 * blocks, profile privacy, and collaborators in one place.
 */
async function canViewerAccessPoll(poll: PollRecord, viewerId: string): Promise<boolean> {
  if (poll.postId === null) return poll.createdBy === viewerId;
  try {
    return await postHydrationService.canViewerReadPostId(poll.postId, viewerId);
  } catch (error) {
    // Fails CLOSED, the same way `ContentRoomLifecycle` treats this gate: it
    // needs the viewer's blocks from Oxy, so an Oxy outage makes the question
    // unanswerable, and an unanswerable ACL is not a yes. Caught HERE rather
    // than at the three call sites so a refusal cannot become a 500 at one of
    // them and a 404 at the others — and, on the vote path, so the throw
    // cannot escape before the write is refused.
    logger.warn('Refusing poll access: visibility check failed', {
      pollId: poll.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function pollNotFound(res: Response) {
  // Do not disclose whether a poll exists behind an inaccessible post.
  return res.status(404).json({ error: 'Not found', message: 'Poll not found' });
}

class PollsController {
  async createPoll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { question, options, postId, endsAt, isMultipleChoice, isAnonymous } = req.body;
      const userId = req.user?.id;

      // Debug logging for authentication
      logger.debug('[Polls] createPoll auth debug:', {
        hasUser: !!req.user,
        userKeys: req.user ? Object.keys(req.user) : [],
        userId: userId,
        userIdType: typeof userId
      });

      if (!userId) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'User ID not found in request'
        });
      }

      // Validate required fields
      if (!question || !options || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Question and at least 2 options are required'
        });
      }

      // Mongoose refused an empty option text (`required` treats `''` as
      // missing) and a `text` column does not. Re-applied here, or a poll can be
      // created with a blank choice nobody can label.
      const optionTexts: string[] = [];
      for (const option of options) {
        if (typeof option !== 'string' || option.length === 0) {
          return validationError(res, 'Every poll option must be a non-empty string');
        }
        optionTexts.push(option);
      }

      // `postId` stays REQUIRED, as the Mongoose schema had it: the composer
      // always sends one (a `temp_…` placeholder before the post exists), and
      // dropping the requirement would let a poll be created that nothing can
      // ever reach.
      if (typeof postId !== 'string' || postId.length === 0) {
        return validationError(res, 'postId is required');
      }

      // Mongoose cast `endsAt`; an uncastable value was a `ValidationError`.
      const resolvedEndsAt =
        endsAt === undefined || endsAt === null
          ? new Date(Date.now() + DEFAULT_POLL_DURATION_MS)
          : new Date(endsAt as string | number | Date);
      if (Number.isNaN(resolvedEndsAt.getTime())) {
        return validationError(res, 'endsAt is not a valid date');
      }

      logger.debug('[Polls] creating poll', {
        postIdType: typeof postId,
        isTemporaryPost: isTemporaryPostId(postId),
      });

      // A real post id is checked for existence + ownership. The `try/catch`
      // that used to wrap this returned 400 'Invalid post ID format' and existed
      // ONLY to convert a Mongoose `CastError`; a `text` id that names no row
      // reaches the 404 below, which is the more useful of the two answers.
      const attachedPostId = isTemporaryPostId(postId) ? null : postId;
      if (attachedPostId !== null) {
        const [post] = await getDb()
          .select({ oxyUserId: posts.oxyUserId })
          .from(posts)
          .where(eq(posts.id, attachedPostId))
          .limit(1);
        if (!post) {
          return res.status(404).json({
            error: 'Not found',
            message: 'Post not found'
          });
        }
        if (post.oxyUserId !== userId) {
          return res.status(403).json({
            error: 'Forbidden',
            message: 'You can only create polls for your own posts'
          });
        }
      }

      try {
        // One transaction: a poll whose options failed to insert is a poll
        // nobody can vote in, and Mongo could not produce that state because
        // the options were part of the same document.
        const poll = await getDb().transaction(async (tx) => {
          const [row] = await tx
            .insert(polls)
            .values({
              question,
              postId: attachedPostId,
              createdBy: userId,
              endsAt: resolvedEndsAt,
              isMultipleChoice: isMultipleChoice || false,
              isAnonymous: isAnonymous || false,
            })
            .returning();

          await tx.insert(pollOptions).values(
            optionTexts.map((text, position) => ({
              pollId: row.id,
              // The author's order IS the render order; Mongo got it from the
              // array and Postgres has to store it.
              position,
              text,
            })),
          );

          // `metadata.pollId` and `content.pollId` were two mirrors of one fact
          // in Mongo; the schema keeps a single `posts.content_poll_id`.
          if (attachedPostId !== null) {
            await tx
              .update(posts)
              .set({ contentPollId: row.id })
              .where(eq(posts.id, attachedPostId));
          }

          const record = await loadPollRecord(tx, row.id);
          if (!record) throw new Error(`Poll ${row.id} vanished inside its own transaction`);
          return record;
        });

        res.status(201).json({
          success: true,
          data: serializePoll(poll)
        });
      } catch (error: unknown) {
        logger.error('[Polls] Error creating poll:', error);
        // The post was there a moment ago and is not now — the same condition
        // the pre-check answers 404 for, observed one statement later.
        if (isForeignKeyViolation(error)) {
          return res.status(404).json({ error: 'Not found', message: 'Post not found' });
        }
        // Unnamed on purpose: every CHECK on `polls`/`poll_options` is
        // application-controlled, so this is a backstop that keeps a
        // schema-level rejection answering 400 (what the Mongoose validator
        // did) instead of 500. A named check would make the branch dead.
        if (isCheckViolation(error)) {
          return validationError(res, 'Poll failed validation');
        }
        next(createError(500, 'Error creating poll'));
      }
    } catch (error) {
      logger.error('[Polls] Error in createPoll:', error);
      next(createError(500, 'Error creating poll'));
    }
  }

  async getPoll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;

      // A 400 for a malformed poll id is a documented contract of these routes
      // (`db/ids.ts` names them), so the guard is WIDENED to both live id shapes
      // rather than deleted. It rejects; it never decides what to query.
      if (!id || !isLiveEntityId(id)) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Invalid poll ID'
        });
      }

      const poll = await loadPollRecord(getDb(), id);
      const viewerId = req.user?.id;
      if (!poll || !viewerId || !(await canViewerAccessPoll(poll, viewerId))) return pollNotFound(res);

      res.json({
        success: true,
        data: serializePoll(poll)
      });
    } catch (error) {
      logger.error('[Polls] Error fetching poll:', error);
      next(createError(500, 'Error fetching poll'));
    }
  }

  async vote(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const { optionId } = req.body;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'User ID not found in request'
        });
      }

      if (!id || !isLiveEntityId(id) || !optionId) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Valid poll ID and option ID are required'
        });
      }

      const poll = await loadPollRecord(getDb(), id);
      if (!poll || !(await canViewerAccessPoll(poll, userId))) return pollNotFound(res);

      // Record the vote through the shared service (the SAME atomic dedup path the
      // inbound ActivityPub poll-vote handler uses), then map its result to HTTP.
      const result = await pollVoteService.recordVoteByOptionId(id, String(optionId), userId);
      if (result.ok) {
        return res.json({ success: true, data: serializePoll(result.poll) });
      }

      switch (result.reason) {
        case 'poll_not_found':
          return res.status(404).json({ error: 'Not found', message: 'Poll not found' });
        case 'poll_ended':
          return res.status(400).json({ error: 'Invalid request', message: 'This poll has ended' });
        case 'option_not_found':
          return res.status(404).json({ error: 'Not found', message: 'Option not found' });
        case 'already_voted':
          return res.status(400).json({ error: 'Invalid request', message: 'You have already voted in this poll' });
      }
    } catch (error) {
      logger.error('[Polls] Error voting in poll:', error);
      next(createError(500, 'Error voting in poll'));
    }
  }

  async getResults(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;

      if (!id || !isLiveEntityId(id)) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Invalid poll ID'
        });
      }

      const poll = await loadPollRecord(getDb(), id);
      const viewerId = req.user?.id;
      if (!poll || !viewerId || !(await canViewerAccessPoll(poll, viewerId))) return pollNotFound(res);

      // Calculate results
      const totalVotes = poll.options.reduce((sum, option) => sum + option.votes.length, 0);
      const results = poll.options.map(option => ({
        id: option.id,
        text: option.text,
        votes: option.votes.length,
        percentage: totalVotes > 0 ? (option.votes.length / totalVotes) * 100 : 0
      }));

      res.json({
        success: true,
        data: {
          id: poll.id,
          question: poll.question,
          results,
          totalVotes,
          endsAt: poll.endsAt,
          isEnded: new Date() > poll.endsAt,
          isAnonymous: poll.isAnonymous
        }
      });
    } catch (error) {
      logger.error('[Polls] Error fetching poll results:', error);
      next(createError(500, 'Error fetching poll results'));
    }
  }

  async deletePoll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'User ID not found in request'
        });
      }

      if (!id || !isLiveEntityId(id)) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Invalid poll ID'
        });
      }

      const [poll] = await getDb()
        .select({ id: polls.id, createdBy: polls.createdBy, postId: polls.postId })
        .from(polls)
        .where(eq(polls.id, id))
        .limit(1);
      if (!poll) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Poll not found'
        });
      }

      // Check if user is the poll creator
      if (poll.createdBy !== userId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You can only delete your own polls'
        });
      }

      // Unlinking the post and deleting the poll are one unit now. Mongo did
      // them as two writes, and a `temp_` postId made the FIRST one throw a
      // `CastError` — so deleting a never-attached poll answered 500. A NULL
      // `post_id` simply skips the update.
      await getDb().transaction(async (tx) => {
        if (poll.postId !== null) {
          await tx
            .update(posts)
            .set({ contentPollId: null })
            .where(eq(posts.id, poll.postId));
        }
        // `poll_options` and `poll_votes` cascade from here.
        await tx.delete(polls).where(eq(polls.id, poll.id));
      });

      res.json({
        success: true,
        message: 'Poll deleted successfully'
      });
    } catch (error) {
      logger.error('[Polls] Error deleting poll:', error);
      next(createError(500, 'Error deleting poll'));
    }
  }

  async updatePollPostId(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const id = req.params.id as string;
      const { postId } = req.body;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'User ID not found in request'
        });
      }

      // Both ids are a documented 400 on this route ("Valid poll ID and post ID
      // are required"), so both guards widen rather than disappear.
      if (
        !id ||
        !isLiveEntityId(id) ||
        typeof postId !== 'string' ||
        !isLiveEntityId(postId)
      ) {
        return res.status(400).json({
          error: 'Invalid request',
          message: 'Valid poll ID and post ID are required'
        });
      }

      // Find the poll
      const [poll] = await getDb()
        .select({ id: polls.id, createdBy: polls.createdBy })
        .from(polls)
        .where(eq(polls.id, id))
        .limit(1);
      if (!poll) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Poll not found'
        });
      }

      // Check if user is the poll creator
      if (poll.createdBy !== userId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You can only update your own polls'
        });
      }

      // Check if post exists
      const [post] = await getDb()
        .select({ oxyUserId: posts.oxyUserId })
        .from(posts)
        .where(eq(posts.id, postId))
        .limit(1);
      if (!post) {
        return res.status(404).json({
          error: 'Not found',
          message: 'Post not found'
        });
      }

      // Check if user is the post owner
      if (post.oxyUserId !== userId) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'You can only update polls for your own posts'
        });
      }

      // Both directions of the link move together — the poll pointing at the
      // post and the post pointing at the poll.
      const updated = await getDb().transaction(async (tx) => {
        await tx.update(polls).set({ postId }).where(eq(polls.id, poll.id));
        await tx.update(posts).set({ contentPollId: poll.id }).where(eq(posts.id, postId));
        const record = await loadPollRecord(tx, poll.id);
        if (!record) throw new Error(`Poll ${poll.id} vanished inside its own transaction`);
        return record;
      });

      res.json({
        success: true,
        data: serializePoll(updated)
      });
    } catch (error) {
      logger.error('[Polls] Error updating poll post ID:', error);
      next(createError(500, 'Error updating poll post ID'));
    }
  }
}

export default new PollsController();
