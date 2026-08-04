import { and, asc, eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../db/postgres';
import { pollOptions, pollVotes, polls } from '../db/schema/polls';

/**
 * Why a vote could not be recorded. Callers map these to their own surface: the
 * HTTP controller to status codes, the ActivityPub inbox to a debug log + drop.
 */
export type PollVoteFailureReason =
  | 'poll_not_found'
  | 'poll_ended'
  | 'option_not_found'
  | 'already_voted';

/**
 * One choice with the voters that picked it.
 *
 * Mongo held `votes: [String]` INSIDE each option subdocument and the API
 * published exactly that, so the array survives on the wire even though the rows
 * now live in `poll_votes`. Order is vote order, which is what `$push` gave.
 */
export interface PollOptionRecord {
  id: string;
  text: string;
  votes: string[];
}

/**
 * A poll and its options, reassembled from the three tables.
 *
 * This is the storage-neutral shape both the HTTP controller and the federation
 * path work with. `polls.controller.ts` turns it into the response body (which
 * still carries `_id` and the Mongoose-named `created_at`/`updated_at`).
 */
export interface PollRecord {
  id: string;
  question: string;
  postId: string | null;
  createdBy: string;
  endsAt: Date;
  isMultipleChoice: boolean;
  isAnonymous: boolean;
  createdAt: Date;
  updatedAt: Date;
  options: PollOptionRecord[];
}

export type PollVoteResult =
  | { ok: true; poll: PollRecord }
  | { ok: false; reason: PollVoteFailureReason };

/**
 * Load a poll with its options and votes.
 *
 * Lives here rather than in the controller because the vote path has to re-read
 * the poll it just wrote in order to answer with it, and the two readers must
 * not be able to disagree about ordering or about how an option with no votes is
 * represented (an empty array, never a missing key).
 *
 * Takes a {@link DatabaseOrTransaction} so the post-vote read happens INSIDE the
 * voting transaction — a plain `Database` handle would run on another connection
 * and could observe the poll without the vote that was just recorded.
 */
export async function loadPollRecord(
  db: DatabaseOrTransaction,
  pollId: string,
): Promise<PollRecord | null> {
  const [poll] = await db.select().from(polls).where(eq(polls.id, pollId)).limit(1);
  if (!poll) return null;

  const options = await db
    .select({ id: pollOptions.id, text: pollOptions.text })
    .from(pollOptions)
    .where(eq(pollOptions.pollId, pollId))
    .orderBy(asc(pollOptions.position));

  // `poll_votes.poll_id` is denormalized from the option precisely so this is one
  // indexed read rather than a fan-out per option.
  const votes = await db
    .select({ optionId: pollVotes.optionId, userId: pollVotes.userId })
    .from(pollVotes)
    .where(eq(pollVotes.pollId, pollId))
    .orderBy(asc(pollVotes.createdAt), asc(pollVotes.id));

  const votersByOption = new Map<string, string[]>(options.map((option) => [option.id, []]));
  for (const vote of votes) {
    votersByOption.get(vote.optionId)?.push(vote.userId);
  }

  return {
    id: poll.id,
    question: poll.question,
    postId: poll.postId,
    createdBy: poll.createdBy,
    endsAt: poll.endsAt,
    isMultipleChoice: poll.isMultipleChoice,
    isAnonymous: poll.isAnonymous,
    createdAt: poll.createdAt,
    updatedAt: poll.updatedAt,
    options: options.map((option) => ({
      id: option.id,
      text: option.text,
      votes: votersByOption.get(option.id) ?? [],
    })),
  };
}

/** Picks the option a caller meant out of a poll's ordered option list. */
type OptionSelector = (options: Array<{ id: string; text: string }>) => { id: string } | undefined;

/**
 * The SINGLE authority for recording a vote on a poll — shared by the local HTTP
 * vote route (`polls.controller`) and the inbound ActivityPub poll vote handler
 * (`inbox.service` — a remote Mastodon `Create(Note)` with a `name` on our
 * `Question`). Both resolve a voter and an option and then land here, so
 * dedup/one-per-voter, closed-poll rejection, and single-vs-multiple-choice
 * semantics live in ONE place and can never diverge between the two paths.
 *
 * ## Where the atomicity comes from now
 *
 * Mongo got it from a single guarded `findOneAndUpdate`: the filter carried the
 * dedup predicate, so a concurrent double-vote or a redelivered federated vote
 * could never double-count.
 *
 * As rows, the two rules are NOT equally protected by the schema:
 *
 * - **multiple-choice** ("not already on THIS option") is exactly
 *   `poll_votes_option_id_user_id_key`, so the constraint alone would do.
 * - **single-choice** ("has not voted on ANY option of this poll") has no
 *   constraint to lean on — `db/schema/polls.ts` describes a partial unique
 *   index for it, but none is declared. See the migration report; the schema is
 *   shared and is not this batch's to edit.
 *
 * So the whole vote runs in one transaction that takes a row lock on the poll
 * (`select … for update`) before reading the guard. Concurrent voters on one
 * poll serialize on that row — the same contention profile Mongo's
 * document-level update had — and the read-then-insert can no longer interleave.
 * The lock is taken uniformly rather than only on the single-choice branch: one
 * code path is worth more than a saved lock on a poll that is already the row
 * every vote touches.
 */
class PollVoteService {
  /** Record a vote identified by the option's id (the local HTTP vote route). */
  async recordVoteByOptionId(
    pollId: string,
    optionId: string,
    voterId: string,
  ): Promise<PollVoteResult> {
    return this.record(pollId, voterId, (options) =>
      options.find((option) => option.id === optionId),
    );
  }

  /**
   * Record a vote identified by the option's TEXT (the inbound ActivityPub path:
   * a Mastodon poll vote references the chosen option by `name`, not by our id).
   */
  async recordVoteByOptionText(
    pollId: string,
    optionText: string,
    voterId: string,
  ): Promise<PollVoteResult> {
    return this.record(pollId, voterId, (options) =>
      options.find((option) => option.text === optionText),
    );
  }

  private async record(
    pollId: string,
    voterId: string,
    selectOption: OptionSelector,
  ): Promise<PollVoteResult> {
    return getDb().transaction(async (tx): Promise<PollVoteResult> => {
      const [poll] = await tx
        .select({
          id: polls.id,
          endsAt: polls.endsAt,
          isMultipleChoice: polls.isMultipleChoice,
        })
        .from(polls)
        .where(eq(polls.id, pollId))
        .limit(1)
        .for('update');
      if (!poll) return { ok: false, reason: 'poll_not_found' };
      if (new Date() > poll.endsAt) return { ok: false, reason: 'poll_ended' };

      const options = await tx
        .select({ id: pollOptions.id, text: pollOptions.text })
        .from(pollOptions)
        .where(eq(pollOptions.pollId, pollId))
        .orderBy(asc(pollOptions.position));

      const option = selectOption(options);
      if (!option) return { ok: false, reason: 'option_not_found' };

      // Single-choice: any vote on this poll blocks. Multiple-choice: only a
      // vote on THIS option blocks.
      const [alreadyVoted] = await tx
        .select({ id: pollVotes.id })
        .from(pollVotes)
        .where(
          poll.isMultipleChoice
            ? and(eq(pollVotes.optionId, option.id), eq(pollVotes.userId, voterId))
            : and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, voterId)),
        )
        .limit(1);
      if (alreadyVoted) return { ok: false, reason: 'already_voted' };

      await tx.insert(pollVotes).values({
        optionId: option.id,
        pollId,
        userId: voterId,
      });

      const updated = await loadPollRecord(tx, pollId);
      // Unreachable while the row lock above is held; answering `poll_not_found`
      // rather than asserting keeps a lost poll from becoming a 500.
      return updated ? { ok: true, poll: updated } : { ok: false, reason: 'poll_not_found' };
    });
  }
}

export const pollVoteService = new PollVoteService();
export default pollVoteService;
