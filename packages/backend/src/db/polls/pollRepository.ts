/**
 * The ONE writer of a poll and its options.
 *
 * A poll is two tables — `polls` plus the ordered `poll_options` rows — and
 * every path that creates one has to write both, atomically. Mongo could not
 * produce a half-created poll because the options were an embedded array; here
 * that guarantee has to be stated, and stating it once is what keeps the
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
 * What must NOT come back is the `temp_` placeholder the Mongo code used
 * (`postId: 'temp_' + Date.now()`). That existed because `PollSchema.postId` was
 * `Mixed` and accepted anything; against a real foreign key it is not a
 * workaround but a failed write. See the `db/schema/polls.ts` docblock.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { pollOptions, polls } from '../schema/polls';

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
        input.options.map((text, position) => ({ pollId: row.id, position, text })),
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
