/**
 * `mention_job_applications` + `mention_job_application_answers` +
 * `mention_job_application_notes` reads/writes (OxyHQ/Mention#952 Phase E).
 *
 * Same discipline as `jobRepository.ts`: the only place that maps between the
 * DB row shapes and the API's {@link MentionJobApplication} /
 * {@link MentionJobApplicationNote}, so a controller never touches these
 * tables' columns directly.
 *
 * THE PRIVACY INVARIANT (issue #952 Phase E): every mapper in this file reads
 * ONLY `mention_job_applications`, `mention_job_application_answers` and
 * `mention_job_application_notes` — never `posts`, `entity_follows`, or any
 * other social-graph table. An application response to an employer must never
 * be able to leak an applicant's posts, follows, likes, DMs or inferred
 * interests, and the only way to guarantee that structurally is for the
 * queries themselves to never join outside this table family.
 */

import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type {
  MentionJobApplication,
  MentionJobApplicationAnswer,
  MentionJobApplicationNote,
  MentionJobApplicationStatus,
} from '@mention/shared-types';
import { getDb } from '../postgres';
import {
  mentionJobApplicationAnswers,
  mentionJobApplicationNotes,
  mentionJobApplications,
} from '../schema/jobs';

type MentionJobApplicationRow = typeof mentionJobApplications.$inferSelect;
type MentionJobApplicationAnswerRow = typeof mentionJobApplicationAnswers.$inferSelect;
type MentionJobApplicationNoteRow = typeof mentionJobApplicationNotes.$inferSelect;

export const APPLICATION_UNIQUE_CONSTRAINT = 'mention_job_applications_job_id_applicant_key';

/** A route can catch this specifically and answer 400, instead of a generic 500. */
export class MalformedCursorError extends Error {
  constructor() {
    super('cursor is malformed');
    this.name = 'MalformedCursorError';
  }
}

function toAnswer(row: Pick<MentionJobApplicationAnswerRow, 'question' | 'answer'>): MentionJobApplicationAnswer {
  return { question: row.question, answer: row.answer };
}

export function toMentionJobApplication(
  row: MentionJobApplicationRow,
  answers: readonly Pick<MentionJobApplicationAnswerRow, 'question' | 'answer'>[] = [],
): MentionJobApplication {
  return {
    id: row.id,
    jobId: row.jobId,
    applicantOxyUserId: row.applicantOxyUserId,
    displayName: row.displayName ?? undefined,
    contactMethod: row.contactMethod ?? undefined,
    resumeFileId: row.resumeFileId ?? undefined,
    coverNote: row.coverNote ?? undefined,
    portfolioLinks: row.portfolioLinks ?? undefined,
    answers: answers.length > 0 ? answers.map(toAnswer) : undefined,
    status: row.status as MentionJobApplicationStatus,
    assignedToOxyUserId: row.assignedToOxyUserId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toMentionJobApplicationNote(row: MentionJobApplicationNoteRow): MentionJobApplicationNote {
  return {
    id: row.id,
    applicationId: row.applicationId,
    authorOxyUserId: row.authorOxyUserId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

async function answersForApplication(applicationId: string): Promise<MentionJobApplicationAnswerRow[]> {
  return getDb()
    .select()
    .from(mentionJobApplicationAnswers)
    .where(eq(mentionJobApplicationAnswers.applicationId, applicationId))
    .orderBy(mentionJobApplicationAnswers.position);
}

/** Batch-load answers for several applications at once — avoids one query per row on a list page. */
async function answersByApplicationId(
  applicationIds: readonly string[],
): Promise<Map<string, MentionJobApplicationAnswerRow[]>> {
  const map = new Map<string, MentionJobApplicationAnswerRow[]>();
  if (applicationIds.length === 0) return map;
  const rows = await getDb()
    .select()
    .from(mentionJobApplicationAnswers)
    .where(inArray(mentionJobApplicationAnswers.applicationId, applicationIds))
    .orderBy(mentionJobApplicationAnswers.position);
  for (const row of rows) {
    const bucket = map.get(row.applicationId);
    if (bucket) bucket.push(row);
    else map.set(row.applicationId, [row]);
  }
  return map;
}

export interface SubmitApplicationParams {
  jobId: string;
  applicantOxyUserId: string;
  displayName?: string;
  contactMethod?: string;
  resumeFileId?: string;
  coverNote?: string;
  portfolioLinks?: string[];
  answers?: MentionJobApplicationAnswer[];
}

export interface SubmitApplicationResult {
  application: MentionJobApplication;
  /** `false` when this call overwrote an existing row (see the docblock below) rather than inserting a fresh one. */
  isNewApplication: boolean;
}

/**
 * Create — or, on a resubmission, overwrite in place — one applicant's
 * application to one job, in a transaction with its answers. Same
 * two-table transactional shape as `upsertMirroredStarterPack`
 * (`db/lists/starterPackRepository.ts`): the parent row first, then a
 * delete-then-insert of the child rows so `position` never collides.
 *
 * UPSERT, not 409-on-duplicate. `mention_job_applications_job_id_applicant_key`
 * is unique on `(jobId, applicantOxyUserId)` REGARDLESS of status, and the
 * schema's own docblock on that constraint says the intended flow is
 * "resubmitting withdraws and reapplies, it does not duplicate" — so an
 * applicant who withdrew (their row still exists, with `status: 'withdrawn'`)
 * must be able to reapply by submitting again. A plain insert-and-409 would
 * make that flow impossible through this endpoint: the withdrawn row would
 * permanently occupy the unique key. Overwriting resets `status` to `'new'`,
 * which is correct for both the "never applied" and the "reapplying after
 * withdrawal" case.
 *
 * A SELECT-then-branch rather than `onConflictDoUpdate`, so the caller can
 * tell the two cases apart (`isNewApplication`) and only bump
 * `mention_jobs.application_count` for a genuinely new applicant. A true
 * concurrent double-submit by the same applicant for the same job is a narrow
 * race this still leaves open (both transactions see "no existing row" and
 * both attempt an insert); the loser surfaces as a driver-level unique
 * violation the caller can catch with `isUniqueViolation` and retry, rather
 * than one statement silently clobbering the other's write in a way neither
 * request sees.
 */
export async function submitApplication(params: SubmitApplicationParams): Promise<SubmitApplicationResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: mentionJobApplications.id })
      .from(mentionJobApplications)
      .where(
        and(
          eq(mentionJobApplications.jobId, params.jobId),
          eq(mentionJobApplications.applicantOxyUserId, params.applicantOxyUserId),
        ),
      )
      .limit(1);

    const [row] = existing
      ? // `undefined` means "leave alone" to drizzle's `.set()` (it FILTERS OUT
        // any key whose value is `undefined` — see `jobRepository.ts`'s
        // `UpdateJobParams` docblock for the same trap). A reapply is a whole
        // new submission, not a partial patch, so every optional field is
        // coerced to `null` here: an applicant who drops their cover note on a
        // resubmission must not have the OLD one survive silently.
        await tx
          .update(mentionJobApplications)
          .set({
            displayName: params.displayName ?? null,
            contactMethod: params.contactMethod ?? null,
            resumeFileId: params.resumeFileId ?? null,
            coverNote: params.coverNote ?? null,
            portfolioLinks: params.portfolioLinks ?? null,
            status: 'new',
            assignedToOxyUserId: null,
          })
          .where(eq(mentionJobApplications.id, existing.id))
          .returning()
      : await tx
          .insert(mentionJobApplications)
          .values({
            jobId: params.jobId,
            applicantOxyUserId: params.applicantOxyUserId,
            displayName: params.displayName,
            contactMethod: params.contactMethod,
            resumeFileId: params.resumeFileId,
            coverNote: params.coverNote,
            portfolioLinks: params.portfolioLinks,
          })
          .returning();

    // Delete-then-insert, same reasoning as `upsertMirroredStarterPack`: the
    // answers a reapply carries fully replace the previous set rather than
    // merging with it.
    await tx.delete(mentionJobApplicationAnswers).where(eq(mentionJobApplicationAnswers.applicationId, row.id));
    const answers = params.answers ?? [];
    if (answers.length > 0) {
      await tx.insert(mentionJobApplicationAnswers).values(
        answers.map((answer, position) => ({
          applicationId: row.id,
          question: answer.question,
          answer: answer.answer,
          position,
        })),
      );
    }

    return { application: toMentionJobApplication(row, answers), isNewApplication: !existing };
  });
}

export async function getApplicationById(id: string): Promise<MentionJobApplication | undefined> {
  const [row] = await getDb().select().from(mentionJobApplications).where(eq(mentionJobApplications.id, id)).limit(1);
  if (!row) return undefined;
  const answers = await answersForApplication(id);
  return toMentionJobApplication(row, answers);
}

/** The raw row (never sent on the wire directly) — callers that need `jobId`/`applicantOxyUserId` for an authority check without paying for the answers join. */
export async function getApplicationRowById(id: string): Promise<MentionJobApplicationRow | undefined> {
  const [row] = await getDb().select().from(mentionJobApplications).where(eq(mentionJobApplications.id, id)).limit(1);
  return row;
}

export interface ListApplicationsParams {
  status?: MentionJobApplicationStatus;
  limit?: number;
  /** Opaque, from a previous page's `nextCursor` — keyset on `(createdAt, id)` descending. */
  cursor?: string;
}

export interface ListApplicationsResult {
  applications: MentionJobApplication[];
  hasMore: boolean;
  nextCursor?: string;
}

const CURSOR_SEPARATOR = '|';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}${CURSOR_SEPARATOR}${id}`;
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | undefined {
  const index = cursor.indexOf(CURSOR_SEPARATOR);
  if (index === -1) return undefined;
  const createdAtRaw = cursor.slice(0, index);
  const id = cursor.slice(index + 1);
  const createdAt = new Date(createdAtRaw);
  if (!id || Number.isNaN(createdAt.getTime())) return undefined;
  return { createdAt, id };
}

/** Newest first, by job. Employer-facing list — see the module docblock's privacy invariant. */
export async function listApplicationsByJob(
  jobId: string,
  params: ListApplicationsParams = {},
): Promise<ListApplicationsResult> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const conditions: SQL[] = [eq(mentionJobApplications.jobId, jobId)];
  if (params.status) conditions.push(eq(mentionJobApplications.status, params.status));
  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    if (!decoded) throw new MalformedCursorError();
    // Row comparison, so the two columns are compared as ONE value in the same
    // order the sort below uses — same construction as `entity-follow.routes.ts`'s
    // keyset cursor, including the explicit `::timestamptz`/`::text` casts a bare
    // template parameter needs to bind correctly.
    conditions.push(
      sql`(${mentionJobApplications.createdAt}, ${mentionJobApplications.id}) < (${decoded.createdAt.toISOString()}::timestamptz, ${decoded.id}::text)`,
    );
  }

  const rows = await getDb()
    .select()
    .from(mentionJobApplications)
    .where(and(...conditions))
    .orderBy(desc(mentionJobApplications.createdAt), desc(mentionJobApplications.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const answersById = await answersByApplicationId(page.map((row) => row.id));
  const applications = page.map((row) => toMentionJobApplication(row, answersById.get(row.id) ?? []));
  const last = page[page.length - 1];
  return {
    applications,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : undefined,
  };
}

export async function updateApplicationStatus(
  id: string,
  status: MentionJobApplicationStatus,
): Promise<MentionJobApplication | undefined> {
  const [row] = await getDb()
    .update(mentionJobApplications)
    .set({ status })
    .where(eq(mentionJobApplications.id, id))
    .returning();
  if (!row) return undefined;
  const answers = await answersForApplication(id);
  return toMentionJobApplication(row, answers);
}

/**
 * The applicant's own withdrawal. A status flip, not a hard delete — the
 * schema already models "withdrawn" as a first-class status, and keeping the
 * row lets the unique constraint keep meaning "one application per applicant
 * per job" (a withdrawn application still occupies that key, which is exactly
 * what lets {@link submitApplication} reapply onto it).
 */
export async function withdrawApplication(id: string): Promise<MentionJobApplication | undefined> {
  return updateApplicationStatus(id, 'withdrawn');
}

export async function addApplicationNote(params: {
  applicationId: string;
  authorOxyUserId: string;
  note: string;
}): Promise<MentionJobApplicationNote> {
  const [row] = await getDb()
    .insert(mentionJobApplicationNotes)
    .values({
      applicationId: params.applicationId,
      authorOxyUserId: params.authorOxyUserId,
      note: params.note,
    })
    .returning();
  return toMentionJobApplicationNote(row);
}

/** Newest first — same convention as every other chronological list in this schema. */
export async function listApplicationNotes(applicationId: string): Promise<MentionJobApplicationNote[]> {
  const rows = await getDb()
    .select()
    .from(mentionJobApplicationNotes)
    .where(eq(mentionJobApplicationNotes.applicationId, applicationId))
    .orderBy(desc(mentionJobApplicationNotes.createdAt));
  return rows.map(toMentionJobApplicationNote);
}

export type { MentionJobApplicationRow };
