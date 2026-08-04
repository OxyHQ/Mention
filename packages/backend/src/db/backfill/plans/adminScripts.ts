/**
 * `adminscriptcursors` and `repairfetchfailures` — resume state for the one-shot
 * administrative sweeps.
 *
 * ## Both copy, and the reason is what their ABSENCE causes someone to DO
 *
 * The useful question about state like this is not what it is for. It is what an
 * operator reaches for when it is gone.
 *
 * `completed_at` is the record that a DESTRUCTIVE sweep ran to exhaustion —
 * `purgeBlockedDomainContent`, `purgeBlockedDomainPlatformData` and
 * `repairFederatedMentions` are its three callers. Drop these four rows and
 * "already purged" becomes indistinguishable from "never ran", and the recovery
 * a reasonable operator reaches for at that point is re-running a destructive
 * sweep against live data.
 *
 * `repairfetchfailures` is the same argument with a measurement attached: the
 * completed sweep left 46,291 candidates of which only 5,691 were transient
 * failures, so without these rows a targeted retry costs ~40,600 requests to
 * other people's servers that cannot produce a repair. Losing it does not lose a
 * cache; it retires the only affordable way to fix the tail. Zero documents
 * today, which is the Group 1 argument verbatim — a zero now is not a zero at
 * cutover, and this one fills the moment the repair sweep next fails.
 *
 * ## `completed_at` NULL must survive as NULL, and this is the dangerous column
 *
 * It is an instance of the shape this migration keeps meeting: a value meaning
 * "I could not tell" consumed as one meaning "there is nothing". NULL here means
 * NOT KNOWN TO HAVE FINISHED — a sweep that stopped on a limit, died mid-page,
 * or is still running. Substituting a timestamp because a row exists would
 * assert completion the source never recorded, and the consumer of that lie
 * skips a purge that never finished.
 *
 * The direction of the harm is worth naming, because it is the opposite of the
 * usual one: an invented `completed_at` fails toward SILENCE (a sweep quietly
 * not re-run), where a missing one fails toward WORK (a sweep re-run
 * unnecessarily). Between a destructive sweep skipped and a destructive sweep
 * repeated, only one of them is recoverable — and the copy must never be the
 * thing that chooses.
 *
 * ## The cursor is portable because it is a row id
 *
 * `cursor` holds a hex `_id`, and ids are preserved VERBATIM by this migration,
 * so the value keeps meaning the same row after the cutover. A Mongo-specific
 * position — a `$natural` offset, a scan order — would have made the ROW
 * meaningless against Postgres even though the TABLE was still required, which
 * is the one shape in this migration where not-copying is the more correct
 * answer. It is not that shape.
 */

import { adminScriptCursors, repairFetchFailures } from '../../schema/adminScripts';
import type { CollectionPlan } from '../plan';
import { buildRow } from '../rowBuilder';
import { date, int, ownId, reqDate, reqInt, reqStr } from '../values';
import { timestamps } from './timestamps';

/** `adminscriptcursors` → `admin_script_cursors`. One row per (script, scope). */
const adminScriptCursorsPlan: CollectionPlan = {
  collection: 'adminscriptcursors',
  table: adminScriptCursors,
  numericAudits: [
    {
      path: 'scanned',
      column: adminScriptCursors.scanned,
      constraint: 'admin_script_cursors_scanned_check',
      min: 0,
      absentAs: 0,
    },
  ],
  uniquenessAudits: [
    {
      // Mongo declared this unique too. A collision would mean two shards claim
      // one territory, and the resume position a run reads would depend on
      // document order — which is how a sweep silently re-scans or skips a range.
      index: 'admin_script_cursors_script_scope_key',
      key: [
        { path: 'script', normalize: 'exact' },
        { path: 'scope', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    const cursorId = ownId(doc);
    emit(
      adminScriptCursors,
      buildRow(
        adminScriptCursors,
        {
          id: cursorId,
          script: reqStr(doc, 'script'),
          scope: reqStr(doc, 'scope'),
          // `required: true` and NOT NULL: a cursor row whose position is
          // missing cannot resume anything, and inventing one (the empty string,
          // the zero id) would resume from the START of a range the sweep has
          // already walked — re-doing destructive work rather than skipping it.
          cursor: reqStr(doc, 'cursor'),
          scanned: reqInt(doc, 'scanned'),
          // NULL means NOT KNOWN TO HAVE FINISHED. See the module docblock: this
          // is the column where a substituted value chooses, on an operator's
          // behalf, not to re-run a destructive sweep.
          completedAt: date(doc, 'completedAt'),
          ...timestamps(doc),
        },
        cursorId
      )
    );
  },
};

/** `repairfetchfailures` → `repair_fetch_failures`. One row per failing post. */
const repairFetchFailuresPlan: CollectionPlan = {
  collection: 'repairfetchfailures',
  table: repairFetchFailures,
  numericAudits: [
    {
      // NULLABLE, so the audit's null branch declines an absent status and this
      // reports only a real value outside the range — a remote server that
      // answered something no HTTP status can be.
      path: 'status',
      column: repairFetchFailures.status,
      constraint: 'repair_fetch_failures_status_check',
      min: 100,
      max: 599,
    },
  ],
  uniquenessAudits: [
    {
      index: 'repair_fetch_failures_script_post_id_key',
      key: [
        { path: 'script', normalize: 'exact' },
        { path: 'postId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    const failureId = ownId(doc);
    emit(
      repairFetchFailures,
      buildRow(
        repairFetchFailures,
        {
          id: failureId,
          script: reqStr(doc, 'script'),
          // A stringified `posts._id`, and deliberately NOT a foreign key: a row
          // is evidence a fetch failed at a moment, and it must outlive the post
          // if the post is later deleted — a constraint would erase the record
          // of the failure along with its subject.
          postId: reqStr(doc, 'postId'),
          // Open vocabulary, no CHECK: the retryable/mapping-failure split is
          // the sweep's own, and pinning it here would refuse a row recording a
          // mode a newer sweep learned to tell apart.
          reason: reqStr(doc, 'reason'),
          // NULL is MEANINGFUL: a timeout never saw a status. Defaulting it to
          // 0 or 500 would invent a remote answer and move the row across the
          // "retry politely" / "do not come back" line the field exists to draw.
          status: int(doc, 'status'),
          // `required: true`. The row's whole claim is that a fetch failed AT a
          // time — a consumer intersects these with the live candidate filter,
          // and an invented `now()` would make every migrated failure look like
          // it happened during the migration.
          failedAt: reqDate(doc, 'failedAt'),
          ...timestamps(doc),
        },
        failureId
      )
    );
  },
};

/** Both admin-script plans. */
export const ADMIN_SCRIPT_PLANS: readonly CollectionPlan[] = [
  adminScriptCursorsPlan,
  repairFetchFailuresPlan,
];
