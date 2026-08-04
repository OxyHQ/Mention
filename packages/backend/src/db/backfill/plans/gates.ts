/**
 * Reply and quote control: `threadgates` (+ its `allow[]` rules) and `postgates`.
 *
 * The first plans in this migration that produce a CHILD table, so they are
 * where two rules stop being abstract:
 *
 * - A child table's count is a count of ARRAY ELEMENTS, not of documents. The
 *   plan declares `childTables` so the verifier can tell "empty because nothing
 *   fed it" from "empty because the copy silently produced nothing".
 * - A subdocument's `_id` is PRESERVED when the subschema kept one, and derived
 *   from `(parentId, path, ordinal)` when it did not. `threadgate.allow[]` is
 *   the first case: it is declared as an inline array of objects and Mongoose
 *   gives those an `_id` unless told `_id: false`, so these ids are real and are
 *   copied verbatim like every other. `childRowId` handles both shapes without
 *   the plan having to know which — and its derived form is a pure function of
 *   the source, so a re-run conflicts with the row it already wrote rather than
 *   inserting a second one.
 *
 * ## One CHECK here is a CROSS-COLUMN invariant, and no audit can express it
 *
 * `threadgate_allow_rules_list_id_check` is `(type = 'listOnly') = (list_id is
 * not null)` — a biconditional over two columns. Every audit kind in this
 * framework asks about ONE column: `EnumAudit` reads a column's accepted set,
 * `NumericAudit` a bound, `UniquenessAudit` a key. A predicate relating two
 * columns has no expression here, so this constraint is NOT audited and a
 * violating document is not reported with a count and sample ids the way an
 * illegal enum value is.
 *
 * That is a real hole, stated rather than skipped, and the transform below does
 * what it can within it: the HARMLESS direction is normalized (a non-`listOnly`
 * rule carrying a list id loses the id, which means nothing to any reader), and
 * the harmful direction — a `listOnly` rule with no list — THROWS, naming the
 * constraint and the exact Mongo query that finds every other instance. A throw
 * is the sanctioned refusal (`CollectionPlan.transform`): the runner catches it,
 * names the collection and the `_id`, and aborts. It is strictly worse than a
 * finding, because it stops at the FIRST one instead of counting them all — so
 * the message carries the query that does the counting.
 */

import { postgates, threadgateAllowRules, threadgates } from '../../schema/gates';
import type { CollectionPlan } from '../plan';
import { buildRow } from '../rowBuilder';
import { bool, childRowId, ownId, reqStr, str, strArray, subdocuments } from '../values';
import { timestamps } from './timestamps';

/** `threadgates` → `threadgates` + `threadgate_allow_rules`. */
const threadgatesPlan: CollectionPlan = {
  collection: 'threadgates',
  table: threadgates,
  childTables: [threadgateAllowRules],
  enumAudits: [
    // `allow.type` is a path INTO an array of subdocuments, and `distinct` on
    // one returns the ELEMENTS' values — which is exactly the set this needs.
    { path: 'allow.type', column: threadgateAllowRules.type },
  ],
  uniquenessAudits: [
    { index: 'threadgates_post_uri_key', key: [{ path: 'postUri', normalize: 'exact' }] },
  ],
  transform: (doc, emit) => {
    const id = ownId(doc);
    emit(
      threadgates,
      buildRow(
        threadgates,
        {
          id,
          postUri: reqStr(doc, 'postUri'),
          // No foreign key: the gate is authored from a client payload and a
          // dead post must degrade to "gates nothing", not to a 500.
          postId: reqStr(doc, 'postId'),
          createdBy: reqStr(doc, 'createdBy'),
          ...timestamps(doc),
        },
        id
      )
    );

    for (const [rule, position] of subdocuments(doc, 'allow')) {
      const type = reqStr(rule, 'type');
      // The Mongo field is `list`; the column is `list_id`. Not a rename for
      // taste — `list` alone reads as the list itself rather than a reference,
      // and `schema/CONVENTIONS.md` requires the `_id` suffix on one.
      const listId = str(rule, 'list');

      if (type === 'listOnly' && listId === null) {
        throw new Error(
          `threadgates ${id}: allow[${position}] is a 'listOnly' rule with no ` +
            '`list`, which threadgate_allow_rules_list_id_check refuses — a ' +
            'list rule naming no list matches nobody, so the constraint states ' +
            'that it cannot exist. No audit can predict this one (it relates ' +
            'two columns), so this throw is the report. Find every instance ' +
            "with: db.threadgates.find({allow: {$elemMatch: {type: 'listOnly', " +
            'list: {$exists: false}}}}, {_id: 1})'
        );
      }

      emit(
        threadgateAllowRules,
        buildRow(
          threadgateAllowRules,
          {
            id: childRowId(rule, id, 'allow', position),
            threadgateId: id,
            // The ARRAY INDEX, which is the order the author wrote the rules in
            // — the only ordering Mongo preserved and the only one worth keeping.
            position,
            type,
            // NORMALIZED, not copied: the CHECK refuses a list id on any rule
            // that is not `listOnly`, and Mongo held the two independently so a
            // stray one is possible. Dropping it loses nothing — no reader
            // consults `list` on a `followingOnly` rule, and the constraint is
            // the schema saying so. The opposite direction is NOT normalizable,
            // which is why it throws above.
            listId: type === 'listOnly' ? listId : null,
          },
          id
        )
      );
    }
  },
};

/** `postgates` → `postgates`. */
const postgatesPlan: CollectionPlan = {
  collection: 'postgates',
  table: postgates,
  uniquenessAudits: [
    { index: 'postgates_post_uri_key', key: [{ path: 'postUri', normalize: 'exact' }] },
  ],
  transform: (doc, emit) => {
    emit(
      postgates,
      buildRow(
        postgates,
        {
          id: ownId(doc),
          postUri: reqStr(doc, 'postUri'),
          postId: reqStr(doc, 'postId'),
          disableQuotes: bool(doc, 'disableQuotes') ?? false,
          // NULLABLE, unlike `mute_words.targets` — so an absent array stays
          // NULL rather than becoming `{}`. The two are not interchangeable
          // here: NULL means the author never detached anything, `{}` would
          // mean they detached and then re-attached everything. Nothing reads
          // the difference today, and inventing one either way would be the
          // migration asserting something the source does not say.
          detachedQuoteUris: strArray(doc, 'detachedQuoteUris'),
          createdBy: reqStr(doc, 'createdBy'),
          ...timestamps(doc),
        },
        ownId(doc)
      )
    );
  },
};

/** Every gate plan. */
export const GATE_PLANS: readonly CollectionPlan[] = [threadgatesPlan, postgatesPlan];
