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
 * ## `poll_votes` ids and timestamps are DERIVED, and they encode ORDER
 *
 * A vote is a bare string in an array: there is no `_id` to preserve and no
 * timestamp to copy. What Mongo DID record is the ORDINAL — `$push` appended to
 * each option's array, so the array index is real information about the sequence
 * votes arrived in. `PollVoteService.loadPollRecord` reads it back with
 * `orderBy(asc(createdAt), asc(id))` and its own comment says so: "Order is vote
 * order, which is what `$push` gave."
 *
 * Both of that query's sort keys therefore have to agree with the ordinal, and
 * neither did:
 *
 * - **`created_at` omitted** let the column default apply, and `now()` is
 *   `transaction_timestamp()` — so every vote written in ONE batched transaction
 *   got a `created_at` identical to the microsecond. The primary sort key
 *   collapsed to a tie for the entire batch.
 * - **The id fell through to `childRowId`**, whose derived form is a sha256
 *   digest. The tiebreak therefore sorted in HASH order. Between them, migrated
 *   vote order was scrambled with no error anywhere.
 *
 * So both are derived from a running ordinal instead. The id is
 * `<pollId>-v<zero-padded ordinal>`, which sorts lexicographically in ordinal
 * order; `created_at` is the poll's own `createdAt` plus the ordinal in
 * milliseconds, which sorts the same way.
 *
 * ## Why a derived timestamp is honest HERE, and where the line is
 *
 * Mongo stored an ordinal and no instant. The ORDER is real information and
 * losing it would be losing data; the INSTANT never existed and rendering one
 * would be inventing data. A derived `created_at` is only acceptable because
 * nothing displays it: `created_at` on this table is read in exactly ONE place
 * in the whole of `src/` — the `orderBy` above — and that query's projection is
 * `{ optionId, userId }`, so the value never leaves the function. Verified by
 * grep before this was written, and it is the premise the choice rests on. **If
 * a second reader of `poll_votes.created_at` ever appears, this becomes
 * fabricated data and the answer changes to an explicit ordinal column.**
 *
 * The ordinal is a single counter across the whole document, advanced in
 * `(option position, vote index)` order. Cross-option order is arbitrary and
 * unobservable — `loadPollRecord` buckets the flat list by option immediately,
 * so only the order WITHIN one option's bucket ever reaches a caller, and that
 * is exactly what the counter preserves.
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
    const pollCreatedAt = date(doc, 'created_at');
    // ONE counter for the whole document — see the docblock for why it spans
    // options rather than restarting per option.
    let voteOrdinal = 0;

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
      for (const userId of strArray(option, 'votes') ?? []) {
        const ordinal = voteOrdinal;
        voteOrdinal += 1;

        emit(
          pollVotes,
          buildRow(
            pollVotes,
            {
              // ORDER-PRESERVING and deterministic — both properties matter.
              // Deterministic so a re-run conflicts with the row it already
              // wrote rather than inserting a second one; order-preserving
              // because this is the tiebreak `loadPollRecord` sorts on.
              id: voteRowId(pollId, ordinal),
              optionId,
              // Denormalized from the option so `poll_votes_option_id_user_id_key`
              // and the one-vote-per-poll rule can be constraints. The schema
              // says a CHECK cannot reach across to `poll_options.poll_id`, so
              // the writer keeps them in lockstep — and so does this.
              pollId,
              userId,
              // DERIVED from the ordinal, not observed — see the docblock. When
              // the poll itself carries no `created_at` there is no base to
              // offset from, so the key is omitted and the whole poll's votes
              // tie on this key; the id above then carries the order alone,
              // which is why it had to be order-preserving too rather than
              // relying on the timestamp.
              ...(pollCreatedAt === null
                ? {}
                : { createdAt: new Date(pollCreatedAt.getTime() + ordinal) }),
            },
            pollId
          )
        );
      }
    }
  },
};

/**
 * Digits the vote ordinal is zero-padded to, so ids sort in ordinal order.
 *
 * Lexicographic order and numeric order agree only at a FIXED width — `10`
 * sorts before `9` otherwise, which would scramble exactly the thing this id
 * exists to preserve. Nine digits is a billion votes on one poll; a poll that
 * exceeds it THROWS rather than silently re-ordering, because a cap that fails
 * quietly is worse than no cap.
 */
const VOTE_ORDINAL_WIDTH = 9;

/** An order-preserving, deterministic `poll_votes.id`. */
function voteRowId(pollId: string, ordinal: number): string {
  const padded = String(ordinal).padStart(VOTE_ORDINAL_WIDTH, '0');
  if (padded.length > VOTE_ORDINAL_WIDTH) {
    throw new Error(
      `polls ${pollId} holds more than ${10 ** VOTE_ORDINAL_WIDTH} votes, so a ` +
        `${VOTE_ORDINAL_WIDTH}-digit ordinal no longer sorts in vote order. Widen ` +
        'VOTE_ORDINAL_WIDTH — and note that doing so changes every derived id, ' +
        'so the target must be re-copied from empty rather than topped up.'
    );
  }
  // NOT uuid-shaped, and that is fine: `text` primary keys accommodate the mixed
  // format by design (`schema/CONVENTIONS.md`), and `engagement_outbox.id` is
  // already a caller-supplied deterministic string for the same reason.
  return `${pollId}-v${padded}`;
}

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
