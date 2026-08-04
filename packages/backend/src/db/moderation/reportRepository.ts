/**
 * `reports` — a receipt and an integration state, never a verdict.
 *
 * CrowdSource owns cases, reviews and decisions; this table keeps what Mention
 * needs to answer its own reporter, drive its own delivery and record its own
 * enforcement. The decision fields are a CACHE of a published revision —
 * overwritten by a later revision, never edited in place.
 *
 * ## The reporter's list is a keyset on `(created_at, id)`, and it used to be broken
 *
 * The Mongo route sorted by `createdAt` and paged on `_id`, which are two
 * different axes — correct only while `_id` order WAS creation order. It also
 * gated the cursor on `mongoose.Types.ObjectId.isValid`, and that guard's FALSE
 * branch means "no cursor", i.e. **serve page one**. Every id minted after the
 * cutover is a uuid v7, so the guard would answer false for all of them and the
 * list would hand back the first page forever, with no error — one of the
 * "empty/false answer consumed as a benign one" shapes.
 *
 * Both are fixed here rather than translated: the sort and the keyset name the
 * same pair, `id` is the tiebreak (rows written in one millisecond share
 * `created_at` exactly), and the cursor is opaque — a value naming no row simply
 * matches nothing.
 */

import { and, asc, count, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import {
  MODERATION_ENFORCEMENT_ACTIONS,
  REPORTED_TYPES,
  REPORT_CATEGORIES,
  REPORT_LOCAL_STATUSES,
  REPORT_STATUSES,
  reports,
} from '../schema/moderation';

/** The objects Mention accepts reports about. Deliberately wider than what is delivered. */
export type ReportedType = (typeof REPORTED_TYPES)[number];
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export type ReportLocalStatus = (typeof REPORT_LOCAL_STATUSES)[number];
/** What Mention did about a decision, when it did anything. */
export type ReportEnforcementAction = (typeof MODERATION_ENFORCEMENT_ACTIONS)[number];

/** One stored report. Absent optionals are `undefined`, never `null`. */
export type ReportRecord = {
  id: string;
  reportedType: ReportedType;
  reportedId: string;
  reporter: string;
  categories: ReportCategory[];
  details?: string;
  status: ReportStatus;
  localStatus: ReportLocalStatus;
  localStatusReason?: string;
  crowdSourceReportId?: string;
  crowdSourceCaseId?: string;
  crowdSourceMerged?: boolean;
  submittedAt?: Date;
  decisionId?: string;
  decisionRevision?: number;
  decisionOutcome?: string;
  decisionStatus?: string;
  decidedAt?: Date;
  enforcedAction?: ReportEnforcementAction;
  enforcedAt?: Date;
  contentSnapshotHash?: string;
  lastDeliveryError?: string;
  createdAt: Date;
  updatedAt: Date;
};

type ReportRow = typeof reports.$inferSelect;

function toRecord(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    reportedType: row.reportedType,
    reportedId: row.reportedId,
    reporter: row.reporter,
    categories: row.categories,
    details: row.details ?? undefined,
    status: row.status,
    localStatus: row.localStatus,
    localStatusReason: row.localStatusReason ?? undefined,
    crowdSourceReportId: row.crowdSourceReportId ?? undefined,
    crowdSourceCaseId: row.crowdSourceCaseId ?? undefined,
    crowdSourceMerged: row.crowdSourceMerged ?? undefined,
    submittedAt: row.submittedAt ?? undefined,
    decisionId: row.decisionId ?? undefined,
    decisionRevision: row.decisionRevision ?? undefined,
    decisionOutcome: row.decisionOutcome ?? undefined,
    decisionStatus: row.decisionStatus ?? undefined,
    decidedAt: row.decidedAt ?? undefined,
    enforcedAction: row.enforcedAction ?? undefined,
    enforcedAt: row.enforcedAt ?? undefined,
    contentSnapshotHash: row.contentSnapshotHash ?? undefined,
    lastDeliveryError: row.lastDeliveryError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The report this reporter already filed about this object, if any. */
export async function findDuplicateReport(
  reporter: string,
  reportedId: string,
  reportedType: ReportedType,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReportRecord | undefined> {
  const [row] = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.reporter, reporter),
        eq(reports.reportedId, reportedId),
        eq(reports.reportedType, reportedType),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : undefined;
}

/** Store a new report. */
export async function insertReport(
  input: {
    reportedType: ReportedType;
    reportedId: string;
    reporter: string;
    categories: readonly ReportCategory[];
    details?: string;
    localStatus: ReportLocalStatus;
    localStatusReason?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReportRecord> {
  const [row] = await db
    .insert(reports)
    .values({
      reportedType: input.reportedType,
      reportedId: input.reportedId,
      reporter: input.reporter,
      categories: [...input.categories],
      details: input.details ?? null,
      status: 'pending',
      localStatus: input.localStatus,
      localStatusReason: input.localStatusReason ?? null,
    })
    .returning();
  return toRecord(row);
}

/** One report by id. */
export async function findReportById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ReportRecord | undefined> {
  const [row] = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
  return row ? toRecord(row) : undefined;
}

/** Close a report there is genuinely nothing left to do about. */
export async function closeUndeliverableReport(
  id: string,
  reason: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(reports)
    .set({ localStatus: 'closed', localStatusReason: reason })
    .where(eq(reports.id, id));
}

/** Record a successful delivery and what CrowdSource gave back. */
export async function markReportSubmitted(
  id: string,
  receipt: {
    crowdSourceReportId: string;
    crowdSourceCaseId: string;
    crowdSourceMerged: boolean;
    contentSnapshotHash: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(reports)
    .set({
      localStatus: 'submitted',
      crowdSourceReportId: receipt.crowdSourceReportId,
      crowdSourceCaseId: receipt.crowdSourceCaseId,
      crowdSourceMerged: receipt.crowdSourceMerged,
      contentSnapshotHash: receipt.contentSnapshotHash,
      submittedAt: new Date(),
      lastDeliveryError: null,
      localStatusReason: null,
    })
    .where(eq(reports.id, id));
}

/**
 * Record a failed delivery on the report itself.
 *
 * `delivery_failed` is what a reporter's receipt and the reconciliation sweep
 * both read; leaving the report at `queued` while the outbox quietly backs off
 * would hide the problem in a table nobody looks at.
 */
export async function markReportDeliveryFailed(
  id: string,
  error: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(reports)
    .set({ localStatus: 'delivery_failed', lastDeliveryError: error.slice(0, 2_000) })
    .where(eq(reports.id, id));
}

/** Every report that opened or joined this case. */
export async function findReportsForCase(
  caseId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<Array<Pick<ReportRecord, 'id' | 'reportedType' | 'reportedId'>>> {
  return db
    .select({
      id: reports.id,
      reportedType: reports.reportedType,
      reportedId: reports.reportedId,
    })
    .from(reports)
    .where(eq(reports.crowdSourceCaseId, caseId));
}

/**
 * Write a decision onto one report, unless a NEWER revision already landed.
 *
 * The revision guard is what makes redelivery and out-of-order arrival safe: a
 * report carrying revision 3 must not be overwritten by a late copy of revision
 * 2. A report with no revision yet has `NULL`, and `NULL <= n` is NULL — which
 * excludes the row — so the absent case is spelled out explicitly rather than
 * left to a comparison that quietly drops exactly the first decision.
 *
 * @returns Whether this call wrote the decision.
 */
export async function applyDecisionToReport(
  id: string,
  decision: {
    status: ReportStatus;
    localStatus: ReportLocalStatus;
    decisionId: string;
    decisionRevision: number;
    decisionOutcome: string;
    decisionStatus: string;
    decidedAt: Date;
    /** What Mention did about it, when it did anything. */
    enforcedAction?: ReportEnforcementAction;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const updated = await db
    .update(reports)
    .set({
      status: decision.status,
      localStatus: decision.localStatus,
      decisionId: decision.decisionId,
      decisionRevision: decision.decisionRevision,
      decisionOutcome: decision.decisionOutcome,
      decisionStatus: decision.decisionStatus,
      decidedAt: decision.decidedAt,
      ...(decision.enforcedAction === undefined
        ? {}
        : { enforcedAction: decision.enforcedAction, enforcedAt: new Date() }),
    })
    .where(
      and(
        eq(reports.id, id),
        or(
          isNull(reports.decisionRevision),
          lte(reports.decisionRevision, decision.decisionRevision),
        ),
      ),
    )
    .returning({ id: reports.id });
  return updated.length > 0;
}

/**
 * Reports awaiting delivery, oldest first.
 *
 * `queued` and `delivery_failed` ONLY. `received` is excluded deliberately and
 * the omission is the safety property, not an oversight: those reports have no
 * subject provider, so an event re-derived for one would dead-letter on its first
 * attempt. They are counted separately.
 */
export async function findReportsAwaitingDelivery(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<Array<Pick<ReportRecord, 'id' | 'localStatus'>>> {
  return db
    .select({ id: reports.id, localStatus: reports.localStatus })
    .from(reports)
    .where(inArray(reports.localStatus, ['queued', 'delivery_failed']))
    .orderBy(asc(reports.createdAt))
    .limit(limit);
}

/**
 * How many reports have sat at `submitted` since before `before`.
 *
 * Deliberately NOT also `decision_id IS NULL`, which is the obvious-looking
 * addition: a PROVISIONAL decision leaves the report at `submitted` (§9.6 lets a
 * later revision supersede it), so such a report has a decision id and is still
 * legitimately waiting for the final one. Narrowing this would quietly shrink an
 * operator-facing number without anyone asking for it.
 */
export async function countReportsAwaitingDecision(
  before: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(reports)
    .where(and(eq(reports.localStatus, 'submitted'), lt(reports.submittedAt, before)));
  return row?.total ?? 0;
}

/** How many reports were stored with no route to review at all. */
export async function countLocalOnlyReports(
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(reports)
    .where(eq(reports.localStatus, 'received'));
  return row?.total ?? 0;
}

/** One page of a reporter's own reports, newest first. */
export interface ReporterReportsPage {
  reports: ReportRecord[];
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * A reporter's own reports — never another reporter's, and never the case behind
 * one.
 *
 * The cursor is the last row's `(created_at, id)`, encoded together, because the
 * sort and the keyset must name the same pair. An unparseable or unknown cursor
 * yields the FIRST page, which is what the previous implementation did for every
 * post-cutover id — the difference is that here it is the documented behaviour of
 * a malformed value rather than the permanent behaviour of a valid one.
 */
export async function findReporterReports(
  options: {
    reporter: string;
    status?: ReportStatus;
    reportedType?: ReportedType;
    cursor?: string;
    limit: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ReporterReportsPage> {
  const after = decodeReportCursor(options.cursor);

  const rows = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.reporter, options.reporter),
        options.status ? eq(reports.status, options.status) : undefined,
        options.reportedType ? eq(reports.reportedType, options.reportedType) : undefined,
        after
          ? sql`(${reports.createdAt}, ${reports.id}) < (${after.createdAt}, ${after.id})`
          : undefined,
      ),
    )
    .orderBy(desc(reports.createdAt), desc(reports.id))
    .limit(options.limit + 1);

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page[page.length - 1];

  return {
    reports: page.map(toRecord),
    hasMore,
    nextCursor: hasMore && last ? encodeReportCursor(last.createdAt, last.id) : undefined,
  };
}

/** `<createdAt ISO>|<id>`, opaque to the client. */
export function encodeReportCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

function decodeReportCursor(cursor?: string): { createdAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const separator = cursor.indexOf('|');
  if (separator <= 0) return undefined;
  const createdAt = new Date(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return undefined;
  return { createdAt, id };
}
