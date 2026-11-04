/**
 * The ONE writer of a poll and its options.
 *
 * A poll is two tables — `polls` plus the ordered `poll_options` rows — and
 * every path that creates one has to write both, atomically. That guarantee
 * has to be stated, and stating it once is what keeps the
 * composer, the thread composer and `POST /polls` from drifting into three
 * different shapes of the same write. They already had: the thread composer
 * passed bare option strings and an `endTime` field the schema never had.
 *
 * ## Why `postId` is attached afterwards rather than passed in
 *
 * The composer creates the poll BEFORE the post, because the post record embeds
 * the poll id (`posts.content_poll_id`). `polls.post_id` is therefore a NULLABLE
 * foreign key — null until the post exists — and {@link attachPollToPost} sets
 * it once the post has an id.
 *
 * What must NOT come back is a `temp_` placeholder
 * (`postId: 'temp_' + Date.now()`): against a real foreign key it is not a
 * workaround but a failed write. See the `db/schema/polls.ts` docblock.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { invalidate as invalidatePostDetailCache } from '../../services/postDetailCache';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { pollOptions, polls } from '../schema/polls';
import { posts } from '../schema/posts';

export interface CreatePollInput {
  question: string;
  /** Option labels in the author's order; that order IS the render order. */
  options: string[];
  createdBy: string;
  endsAt: Date;
  isMultipleChoice?: boolean;
  isAnonymous?: boolean;
  /** Set only when the post already exists; otherwise attach it afterwards. */
  postId?: string | null;
  /**
   * A federated poll's origin tallies, aligned with `options`. Omitted for a
   * local poll, whose tally is its `poll_votes` rows.
   */
  federatedVoteCounts?: readonly number[];
}

/**
 * Insert a poll and its options in one transaction.
 *
 * @returns The new poll's id.
 */
export async function createPollWithOptions(
  input: CreatePollInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<string> {
  // `.transaction()` on a transaction opens a SAVEPOINT, so a caller that
  // already holds one keeps its atomicity and a caller that does not gets a
  // transaction of its own. Either way the options cannot land without the poll.
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(polls)
      .values({
        question: input.question,
        postId: input.postId ?? null,
        createdBy: input.createdBy,
        endsAt: input.endsAt,
        isMultipleChoice: input.isMultipleChoice ?? false,
        isAnonymous: input.isAnonymous ?? false,
      })
      .returning({ id: polls.id });

    if (input.options.length > 0) {
      await tx.insert(pollOptions).values(
        input.options.map((text, position) => ({
          pollId: row.id,
          position,
          text,
          federatedVoteCount: input.federatedVoteCounts?.[position] ?? null,
        })),
      );
    }

    return row.id;
  });
}

/**
 * Point a not-yet-attached poll at the post that now embeds it.
 *
 * Scoped to `post_id is null` so this can only ever CLAIM an unattached poll —
 * a repeated call, or a second post naming someone else's poll id, cannot move
 * a poll that already belongs to a post.
 *
 * @returns Whether a poll was attached.
 */
export async function attachPollToPost(
  pollId: string,
  postId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const attached = await db
    .update(polls)
    .set({ postId })
    .where(and(eq(polls.id, pollId), isNull(polls.postId)))
    .returning({ id: polls.id });
  return attached.length > 0;
}

/**
 * A remote poll's choices as its origin publishes them — an ActivityPub
 * `Question`'s options (`oneOf`, or `anyOf` when several may be chosen), each
 * with its tally, and its deadline (`closed` once ended, `endTime` while open).
 */
export interface FederatedPollChoices {
  options: ReadonlyArray<{ text: string; votes: number }>;
  isMultipleChoice: boolean;
  endsAt: Date;
}

/** A remote poll as stored: its choices plus the question (the post's body). */
export interface FederatedPollInput extends FederatedPollChoices {
  question: string;
}

/**
 * Overwrite a federated poll's tallies and deadline with the origin's, when the
 * stored poll still has the same choices. Returns false when the choices differ
 * (an edit replaced them), which leaves the poll untouched for the caller to
 * replace.
 */
async function refreshFederatedPoll(
  tx: DatabaseOrTransaction,
  pollId: string,
  poll: FederatedPollChoices,
): Promise<boolean> {
  const [header] = await tx
    .select({ isMultipleChoice: polls.isMultipleChoice })
    .from(polls)
    .where(eq(polls.id, pollId))
    .limit(1);
  const stored = await tx
    .select({ id: pollOptions.id, text: pollOptions.text })
    .from(pollOptions)
    .where(eq(pollOptions.pollId, pollId))
    .orderBy(asc(pollOptions.position));
  const sameChoices =
    header?.isMultipleChoice === poll.isMultipleChoice &&
    stored.length === poll.options.length &&
    stored.every((option, index) => option.text === poll.options[index]?.text);
  if (!sameChoices) return false;

  await tx.update(polls).set({ endsAt: poll.endsAt }).where(eq(polls.id, pollId));
  for (const [index, option] of stored.entries()) {
    await tx
      .update(pollOptions)
      .set({ federatedVoteCount: poll.options[index]?.votes ?? 0 })
      .where(eq(pollOptions.id, option.id));
  }
  return true;
}

/**
 * Make a federated post's poll match its origin's `Question` — the one writer
 * for every ingest path (inbox `Create`/`Update`, outbox backfill, the import
 * of a boosted, quoted or ancestor note).
 *
 * Same choices: the tallies and deadline are refreshed in place, keeping local
 * voters' ballots. Different choices (an edit), or no poll at all any more: the
 * stored poll is deleted with its ballots, as the origin resets votes when a
 * poll's options change. `poll` null on a post with no poll is a no-op.
 */
export async function syncFederatedPoll(
  postId: string,
  createdBy: string,
  poll: FederatedPollInput | null,
): Promise<void> {
  const pointerChanged = await getDb().transaction(async (tx) => {
    const [post] = await tx
      .select({ pollId: posts.contentPollId })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1)
      .for('update');
    if (!post) return false;
    const existingId = post.pollId ?? null;
    if (existingId && poll && (await refreshFederatedPoll(tx, existingId, poll))) return false;
    if (!existingId && !poll) return false;

    if (existingId) await tx.delete(polls).where(eq(polls.id, existingId));
    const pollId = poll
      ? await createPollWithOptions(
          {
            question: poll.question,
            options: poll.options.map((option) => option.text),
            federatedVoteCounts: poll.options.map((option) => option.votes),
            createdBy,
            endsAt: poll.endsAt,
            isMultipleChoice: poll.isMultipleChoice,
            postId,
          },
          tx,
        )
      : null;
    await tx.update(posts).set({ contentPollId: pollId }).where(eq(posts.id, postId));
    return true;
  });
  if (pointerChanged) await invalidatePostDetailCache(postId);
}

/**
 * Refresh a federated post's poll tallies from an `Update(Question)` that edits
 * nothing else. Returns false when the post has no poll with these choices, so
 * the caller treats the activity as an edit instead.
 */
export async function refreshFederatedPostPoll(
  postId: string,
  poll: FederatedPollChoices,
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [post] = await tx
      .select({ pollId: posts.contentPollId })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);
    return post?.pollId ? refreshFederatedPoll(tx, post.pollId, poll) : false;
  });
}
