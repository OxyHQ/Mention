/**
 * `polls` → `polls` + `poll_options` + `poll_votes`.
 *
 * One document, three tables, and the only plan so far where a Mongo SCALAR
 * ARRAY becomes rows: `options[].votes` was a `[String]` of voter ids nested
 * inside each option, so "has this user voted on this poll" meant scanning every
 * option's array and the total was a virtual that summed them. As a junction
 * table the one-vote-per-poll rule becomes a constraint and the tally becomes a
 * `GROUP BY`.
 *
 * ## The timestamps are NOT called `createdAt`/`updatedAt`
 *
 * `PollSchema` declares `timestamps: { createdAt: 'created_at', updatedAt:
 * 'updated_at' }` — the ONLY model in this package that renames them. The shared
 * `timestamps()` helper reads the default names and would find nothing here,
 * then silently let both column defaults apply and stamp every migrated poll
 * with the migration's own clock. That is the exact failure the helper exists to
 * prevent, arriving through the one door it does not cover, so this file reads
 * the real paths itself.
 *
 * ## `postId` is `Mixed`, and a `temp_` value is left to the audit
 *
 * The model accepts an ObjectId OR a `temp_…` string (a poll is created before
 * its post, so it briefly names a placeholder). `schema/polls.ts` says those
 * strings no longer exist. This transform does NOT assert that: it copies the
 * value verbatim, so a surviving `temp_` id becomes a `post_id` naming no post
 * and the referential-integrity audit reports it BY VALUE with the referencing
 * document ids, before anything is written. Special-casing it here — nulling it,
 * say — would decide on the operator's behalf and destroy the evidence that the
 * decision was needed.
 *
 * ## `poll_votes` ids are DERIVED, and they have to be
 *
 * A vote is a bare string in an array; there is no `_id` to preserve. The id
 * comes from `(pollId, 'options[i].votes', j)` via `childRowId`, which is a pure
 * function of the source — so a re-run conflicts with the row it already wrote
 * instead of inserting a second one. A freshly generated uuid would duplicate
 * every vote on every retry, and `poll_votes_option_id_user_id_key` would catch
 * most of that but only by accident.
 */

import { pollOptions, pollVotes, polls } from '../../schema/polls';
import type { CollectionPlan } from '../plan';
import { buildRow } from '../rowBuilder';
import { bool, childRowId, date, id, ownId, reqDate, reqStr, strArray, subdocuments } from '../values';
import type { MongoDocument } from '../values';

/**
 * `polls` → `polls` + `poll_options` + `poll_votes`.
 *
 * No `numericAudits`, and that is checked rather than forgotten:
 * `poll_options.position` is the ARRAY INDEX this transform assigns, so its
 * `>= 0` CHECK holds by construction, and `poll_votes` has no numeric CHECK at
 * all. Auditing a value the migration itself produces would be the migration
 * checking its own arithmetic.
 */
const pollsPlan: CollectionPlan = {
  collection: 'polls',
  table: polls,
  childTables: [pollOptions, pollVotes],
  transform: (doc, emit) => {
    const pollId = ownId(doc);

    emit(
      polls,
      buildRow(
        polls,
        {
          id: pollId,
          question: reqStr(doc, 'question'),
          // NULLABLE, and a `temp_` string is copied through — see the docblock.
          postId: id(doc, 'postId'),
          createdBy: reqStr(doc, 'createdBy'),
          // `NOT NULL` with no default: a poll with no end has no closing rule,
          // and inventing one would change when it stops accepting votes.
          endsAt: reqDate(doc, 'endsAt'),
          isMultipleChoice: bool(doc, 'isMultipleChoice') ?? false,
          isAnonymous: bool(doc, 'isAnonymous') ?? false,
          ...renamedTimestamps(doc),
        },
        pollId
      )
    );

    for (const [option, position] of subdocuments(doc, 'options')) {
      // `PollOptionSchema` is declared `{ _id: true }` explicitly, so this id is
      // PRESERVED rather than derived — and it must be: clients POST it back
      // when voting, so it is a first-class id, not an array index.
      const optionId = childRowId(option, pollId, 'options', position);

      emit(
        pollOptions,
        buildRow(
          pollOptions,
          {
            id: optionId,
            pollId,
            position,
            // The column is `text` and so is the Mongo field, which reads oddly
            // (`option.text`) but is the honest name for the choice's label.
            text: reqStr(option, 'text'),
          },
          pollId
        )
      );

      // `votes: [String]` — bare voter ids, no subdocument, no id of their own.
      for (const [voterIndex, userId] of (strArray(option, 'votes') ?? []).entries()) {
        emit(
          pollVotes,
          buildRow(
            pollVotes,
            {
              // The path includes the OPTION's position, so two options'
              // vote-zero cannot derive the same id.
              id: childRowId({}, pollId, `options.${position}.votes`, voterIndex),
              optionId,
              // Denormalized from the option so `poll_votes_option_id_user_id_key`
              // and the one-vote-per-poll rule can be constraints. The schema
              // says a CHECK cannot reach across to `poll_options.poll_id`, so
              // the writer keeps them in lockstep — and so does this.
              pollId,
              userId,
              // Mongo stored no per-vote timestamp; the column is `NOT NULL
              // DEFAULT now()`, so the key is OMITTED and Postgres supplies the
              // migration's clock. That is the one place in this file where a
              // timestamp is not the source's — unavoidable, because the source
              // never recorded one, and stated rather than hidden.
            },
            pollId
          )
        );
      }
    }
  },
};

/**
 * `created_at` / `updated_at` under the names this ONE model gave them.
 *
 * Not the shared helper: `PollSchema` renames both, so reading `createdAt` here
 * finds nothing and lets the column default stamp the migration's clock over
 * every poll's real history.
 */
function renamedTimestamps(doc: MongoDocument): Record<string, unknown> {
  const createdAt = date(doc, 'created_at');
  const updatedAt = date(doc, 'updated_at');
  return {
    ...(createdAt === null ? {} : { createdAt }),
    ...(updatedAt === null ? {} : { updatedAt }),
  };
}

/** Every poll plan. */
export const POLL_PLANS: readonly CollectionPlan[] = [pollsPlan];
