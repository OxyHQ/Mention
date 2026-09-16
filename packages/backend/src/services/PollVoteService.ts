import { and, asc, count, eq } from 'drizzle-orm';
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

/** The poll's own columns — everything about it EXCEPT its options and votes. */
const POLL_HEADER_COLUMNS = {
  id: polls.id,
  question: polls.question,
  postId: polls.postId,
  createdBy: polls.createdBy,
  endsAt: polls.endsAt,
  isMultipleChoice: polls.isMultipleChoice,
  isAnonymous: polls.isAnonymous,
  createdAt: polls.createdAt,
  updatedAt: polls.updatedAt,
} as const;

/** A poll's own row, with no option or vote data — cheap enough to read before deciding an ACL. */
export interface PollHeader {
  id: string;
  question: string;
  postId: string | null;
  createdBy: string;
  endsAt: Date;
  isMultipleChoice: boolean;
  isAnonymous: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** One option's tally, with no voter identities attached. */
export interface PollOptionSummary {
  id: string;
  text: string;
  voteCount: number;
}

/**
 * A poll as a specific viewer may see it: the header, every option's COUNT
 * (never its voters), and that viewer's own selection.
 */
export interface PollSummary extends PollHeader {
  options: PollOptionSummary[];
  /** The option ids THIS viewer voted for. Never another voter's. */
  viewerSelectedOptionIds: string[];
}

export type PollVoteResult =
  | { ok: true; poll: PollSummary }
  | { ok: false; reason: PollVoteFailureReason };

/** Read a poll's own row. No options, no votes — the minimum an ACL needs. */
export async function loadPollHeader(
  db: DatabaseOrTransaction,
  pollId: string,
): Promise<PollHeader | null> {
  const [header] = await db
    .select(POLL_HEADER_COLUMNS)
    .from(polls)
    .where(eq(polls.id, pollId))
    .limit(1);
  return header ?? null;
}

/** A poll's options in author order. Bounded by option count, never by vote count. */
async function loadPollOptions(
  db: DatabaseOrTransaction,
  pollId: string,
): Promise<Array<{ id: string; text: string }>> {
  return db
    .select({ id: pollOptions.id, text: pollOptions.text })
    .from(pollOptions)
    .where(eq(pollOptions.pollId, pollId))
    .orderBy(asc(pollOptions.position));
}

/**
 * Per-option vote counts and one viewer's own selection — an aggregate and a
 * viewer-scoped read, NEITHER of which materializes another voter's identity
 * in the application. Both are bounded by option count and by this viewer's
 * own vote count; neither grows with the poll's total voter count the way
 * reconstructing every option's voter array in Node used to.
 */
async function loadPollVoteSummary(
  db: DatabaseOrTransaction,
  pollId: string,
  viewerId: string,
): Promise<{ counts: Map<string, number>; viewerOptionIds: string[] }> {
  // Sequential, not `Promise.all`: a transaction's connection processes one
  // statement at a time, and this same function runs inside `record`'s
  // transaction as well as against a plain pooled handle.
  const countRows = await db
    .select({ optionId: pollVotes.optionId, voteCount: count() })
    .from(pollVotes)
    .where(eq(pollVotes.pollId, pollId))
    .groupBy(pollVotes.optionId);
  const viewerRows = await db
    .select({ optionId: pollVotes.optionId })
    .from(pollVotes)
    .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, viewerId)));

  return {
    counts: new Map(countRows.map((row) => [row.optionId, row.voteCount])),
    viewerOptionIds: viewerRows.map((row) => row.optionId),
  };
}

/** Merge a header, its options and a vote summary into one {@link PollSummary}. No I/O. */
function composePollSummary(
  header: PollHeader,
  options: Array<{ id: string; text: string }>,
  counts: Map<string, number>,
  viewerOptionIds: string[],
): PollSummary {
  return {
    ...header,
    options: options.map((option) => ({
      id: option.id,
      text: option.text,
      voteCount: counts.get(option.id) ?? 0,
    })),
    viewerSelectedOptionIds: viewerOptionIds,
  };
}

/**
 * The full poll a specific viewer would see: header, per-option counts, and
 * that viewer's own selection. The general-purpose read — `getPoll`,
 * `createPoll` and `updatePollPostId` all use this; `record` below builds its
 * own success value inline because it already holds the header and options
 * from earlier in the same transaction.
 */
export async function loadPollSummary(
  db: DatabaseOrTransaction,
  pollId: string,
  viewerId: string,
): Promise<PollSummary | null> {
  const header = await loadPollHeader(db, pollId);
  if (!header) return null;
  const options = await loadPollOptions(db, pollId);
  const { counts, viewerOptionIds } = await loadPollVoteSummary(db, pollId, viewerId);
  return composePollSummary(header, options, counts, viewerOptionIds);
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
 *
 * ## What runs under the lock, and why it got shorter
 *
 * The header select now grabs every column `PollHeader` needs (not just the
 * three the guard reads), so the row this transaction already locked can also
 * serve as the success response's header — no second full-poll reload after
 * the insert. What DOES still run under the lock is `loadPollVoteSummary`: the
 * counts it returns must reflect the vote this same transaction just wrote, so
 * reading them after `COMMIT` could race a concurrent read. It is bounded by
 * option count and by this voter's own vote count, never by total voters, so
 * it does not reintroduce the cost this replaces.
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
      const [header] = await tx
        .select(POLL_HEADER_COLUMNS)
        .from(polls)
        .where(eq(polls.id, pollId))
        .limit(1)
        .for('update');
      if (!header) return { ok: false, reason: 'poll_not_found' };
      if (new Date() > header.endsAt) return { ok: false, reason: 'poll_ended' };

      const options = await loadPollOptions(tx, pollId);
      const option = selectOption(options);
      if (!option) return { ok: false, reason: 'option_not_found' };

      // Single-choice: any vote on this poll blocks. Multiple-choice: only a
      // vote on THIS option blocks.
      const [alreadyVoted] = await tx
        .select({ id: pollVotes.id })
        .from(pollVotes)
        .where(
          header.isMultipleChoice
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

      const { counts, viewerOptionIds } = await loadPollVoteSummary(tx, pollId, voterId);
      return { ok: true, poll: composePollSummary(header, options, counts, viewerOptionIds) };
    });
  }
}

export const pollVoteService = new PollVoteService();
export default pollVoteService;
