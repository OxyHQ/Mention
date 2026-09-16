/**
 * `mention_jobs` reads/writes. The single place that maps between the DB row
 * shape (flat location/salary columns, Clarity sync bookkeeping) and the API's
 * {@link MentionJobPosting} — a controller never touches `mentionJobs` columns
 * directly, so the two cannot drift.
 */

import { and, desc, eq, lt, or } from 'drizzle-orm';
import { isUniqueViolation } from '@oxy.so/db';
import type {
  CreateMentionJobRequest,
  MentionJobListFilters,
  MentionJobListPage,
  MentionJobPosting,
  MentionJobStatus,
  UpdateMentionJobRequest,
} from '@mention/shared-types';
import { getDb } from '../postgres';
import { mentionJobs, type MentionJobClaritySyncStatus } from '../schema/jobs';
import { config } from '../../config';
import { slugify } from '../../utils/textProcessing';

type MentionJobRow = typeof mentionJobs.$inferSelect;

const SLUG_UNIQUE_CONSTRAINT = 'mention_jobs_slug_key';
const MAX_SLUG_ATTEMPTS = 5;

function canonicalUrl(slug: string): string {
  const base = config.frontendUrl ?? 'https://mention.earth';
  return `${base.replace(/\/$/, '')}/jobs/${slug}`;
}

export function toMentionJobPosting(row: MentionJobRow): MentionJobPosting {
  const hasLocation = Boolean(
    row.locationRaw || row.locationCountryCode || row.locationRegion || row.locationCity,
  );
  const hasSalary = Boolean(row.salaryCurrency && row.salaryInterval);
  return {
    id: row.id,
    employerOxyUserId: row.employerOxyUserId,
    authorOxyUserId: row.authorOxyUserId,
    title: row.title,
    description: row.description,
    location: hasLocation
      ? {
          raw: row.locationRaw ?? '',
          countryCode: row.locationCountryCode ?? undefined,
          region: row.locationRegion ?? undefined,
          city: row.locationCity ?? undefined,
        }
      : undefined,
    workplaceType: row.workplaceType ?? undefined,
    employmentType: row.employmentType ?? undefined,
    salary: hasSalary
      ? {
          min: row.salaryMin ?? undefined,
          max: row.salaryMax ?? undefined,
          currency: row.salaryCurrency as string,
          interval: row.salaryInterval as NonNullable<MentionJobPosting['salary']>['interval'],
        }
      : undefined,
    skills: row.skills ?? [],
    applicationMode: row.applicationMode,
    externalApplyUrl: row.externalApplyUrl ?? undefined,
    status: row.status,
    slug: row.slug,
    canonicalUrl: canonicalUrl(row.slug),
    applicationCount: row.applicationCount,
    claritySyncStatus: row.claritySyncStatus,
    publishedAt: row.publishedAt?.toISOString(),
    closesAt: row.closesAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A URL-safe slug candidate for `title`, with a short random tail for collision spread. */
function slugCandidate(title: string, attempt: number): string {
  const base = slugify(title).slice(0, 80) || 'job';
  if (attempt === 0) {
    // First attempt still carries a short random tail: two employers titling a
    // job "Software Engineer" the same minute must not race on the bare slug.
    return `${base}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return `${base}-${Math.random().toString(36).slice(2, 8)}${attempt}`;
}

export interface CreateJobParams extends CreateMentionJobRequest {
  authorOxyUserId: string;
}

/** Insert a new job row, retrying the slug on a unique collision. */
export async function createJob(params: CreateJobParams): Promise<MentionJobRow> {
  const db = getDb();
  const publish = params.publish === true;
  const now = new Date();

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      const [row] = await db
        .insert(mentionJobs)
        .values({
          employerOxyUserId: params.employerOxyUserId,
          authorOxyUserId: params.authorOxyUserId,
          title: params.title,
          description: params.description,
          locationRaw: params.location?.raw,
          locationCountryCode: params.location?.countryCode,
          locationRegion: params.location?.region,
          locationCity: params.location?.city,
          workplaceType: params.workplaceType,
          employmentType: params.employmentType,
          salaryMin: params.salary?.min,
          salaryMax: params.salary?.max,
          salaryCurrency: params.salary?.currency,
          salaryInterval: params.salary?.interval,
          skills: params.skills ?? [],
          applicationMode: params.applicationMode,
          externalApplyUrl: params.externalApplyUrl,
          status: publish ? 'published' : 'draft',
          slug: slugCandidate(params.title, attempt),
          publishedAt: publish ? now : undefined,
        })
        .returning();
      return row;
    } catch (error) {
      if (isUniqueViolation(error, SLUG_UNIQUE_CONSTRAINT) && attempt < MAX_SLUG_ATTEMPTS - 1) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Could not allocate a unique job slug');
}

export async function getJobById(id: string): Promise<MentionJobRow | undefined> {
  const [row] = await getDb().select().from(mentionJobs).where(eq(mentionJobs.id, id)).limit(1);
  return row;
}

export async function getJobBySlug(slug: string): Promise<MentionJobRow | undefined> {
  const [row] = await getDb().select().from(mentionJobs).where(eq(mentionJobs.slug, slug)).limit(1);
  return row;
}

/**
 * Same as {@link UpdateMentionJobRequest} except the clearable object/enum
 * fields also accept `null` to mean "clear this field" — `undefined` means
 * "leave it alone". The distinction is load-bearing: drizzle's `.set()`
 * FILTERS OUT any key whose value is `undefined` (`mapUpdateSet` in
 * `drizzle-orm/utils.js`; verified empirically — it even throws "No values to
 * set" when every key is undefined), so `location: undefined` and
 * `location: null` are not the same request and must not collapse into one.
 */
export interface UpdateJobParams extends Omit<UpdateMentionJobRequest, 'location' | 'workplaceType' | 'employmentType' | 'salary' | 'externalApplyUrl'> {
  location?: UpdateMentionJobRequest['location'] | null;
  workplaceType?: UpdateMentionJobRequest['workplaceType'] | null;
  employmentType?: UpdateMentionJobRequest['employmentType'] | null;
  salary?: UpdateMentionJobRequest['salary'] | null;
  externalApplyUrl?: UpdateMentionJobRequest['externalApplyUrl'] | null;
}

export async function updateJob(id: string, patch: UpdateJobParams): Promise<MentionJobRow | undefined> {
  const values: Partial<typeof mentionJobs.$inferInsert> = {};
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.location !== undefined) {
    values.locationRaw = patch.location?.raw ?? null;
    values.locationCountryCode = patch.location?.countryCode ?? null;
    values.locationRegion = patch.location?.region ?? null;
    values.locationCity = patch.location?.city ?? null;
  }
  if (patch.workplaceType !== undefined) values.workplaceType = patch.workplaceType;
  if (patch.employmentType !== undefined) values.employmentType = patch.employmentType;
  if (patch.salary !== undefined) {
    values.salaryMin = patch.salary?.min ?? null;
    values.salaryMax = patch.salary?.max ?? null;
    values.salaryCurrency = patch.salary?.currency ?? null;
    values.salaryInterval = patch.salary?.interval ?? null;
  }
  if (patch.skills !== undefined) values.skills = patch.skills;
  if (patch.applicationMode !== undefined) values.applicationMode = patch.applicationMode;
  if (patch.externalApplyUrl !== undefined) values.externalApplyUrl = patch.externalApplyUrl;

  if (Object.keys(values).length === 0) return getJobById(id);

  const [row] = await getDb()
    .update(mentionJobs)
    .set(values)
    .where(eq(mentionJobs.id, id))
    .returning();
  return row;
}

/** `publish` / `pause` / `close` — the only status transitions a route may request directly. */
export async function setJobStatus(
  id: string,
  status: Extract<MentionJobStatus, 'published' | 'paused' | 'closed'>,
): Promise<MentionJobRow | undefined> {
  const values: Partial<typeof mentionJobs.$inferInsert> = { status };
  if (status === 'published') values.publishedAt = new Date();
  const [row] = await getDb()
    .update(mentionJobs)
    .set(values)
    .where(eq(mentionJobs.id, id))
    .returning();
  return row;
}

/**
 * Flip every `published` job whose `closesAt` has passed to `expired`. Called
 * lazily from the read paths (`getJobById`/list) rather than a scheduled sweep
 * — see `services/jobExpiry.ts`.
 */
export async function expireDueJobs(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await getDb()
    .update(mentionJobs)
    .set({ status: 'expired' })
    .where(
      and(
        eq(mentionJobs.status, 'published'),
        lt(mentionJobs.closesAt, new Date()),
        or(...ids.map((id) => eq(mentionJobs.id, id))),
      ),
    );
}

export async function listJobsByEmployer(
  employerOxyUserId: string,
  filters: Pick<MentionJobListFilters, 'status' | 'limit'> = {},
): Promise<MentionJobRow[]> {
  const limit = Math.min(filters.limit ?? 20, 100);
  const conditions = [eq(mentionJobs.employerOxyUserId, employerOxyUserId)];
  if (filters.status) conditions.push(eq(mentionJobs.status, filters.status));
  return getDb()
    .select()
    .from(mentionJobs)
    .where(and(...conditions))
    .orderBy(desc(mentionJobs.createdAt))
    .limit(limit);
}

export async function incrementApplicationCount(jobId: string, delta: number): Promise<void> {
  const db = getDb();
  const [row] = await db.select({ count: mentionJobs.applicationCount }).from(mentionJobs).where(eq(mentionJobs.id, jobId)).limit(1);
  if (!row) return;
  await db
    .update(mentionJobs)
    .set({ applicationCount: Math.max(0, row.count + delta) })
    .where(eq(mentionJobs.id, jobId));
}

export interface ClaritySyncResult {
  status: MentionJobClaritySyncStatus;
  clarityDocumentId?: string;
  error?: string;
}

/** Record the outcome of one Clarity `jobs.ingest` attempt — see `services/clarityJobsAdapter.ts`. */
export async function recordClaritySync(jobId: string, result: ClaritySyncResult): Promise<void> {
  const db = getDb();
  const values: Partial<typeof mentionJobs.$inferInsert> = {
    claritySyncStatus: result.status,
  };
  if (result.status === 'synced') {
    values.claritySyncedAt = new Date();
    values.claritySyncAttempts = 0;
    values.claritySyncError = null;
    if (result.clarityDocumentId) values.clarityDocumentId = result.clarityDocumentId;
  } else {
    values.claritySyncError = result.error ?? null;
    const [row] = await db
      .select({ attempts: mentionJobs.claritySyncAttempts })
      .from(mentionJobs)
      .where(eq(mentionJobs.id, jobId))
      .limit(1);
    values.claritySyncAttempts = (row?.attempts ?? 0) + 1;
  }
  await db.update(mentionJobs).set(values).where(eq(mentionJobs.id, jobId));
}

/** Jobs whose Clarity sync failed and are due a retry — the retry queue's work source. */
export async function listFailedClaritySyncs(limit = 50): Promise<MentionJobRow[]> {
  return getDb()
    .select()
    .from(mentionJobs)
    .where(eq(mentionJobs.claritySyncStatus, 'failed'))
    .orderBy(desc(mentionJobs.updatedAt))
    .limit(limit);
}

export type { MentionJobRow };
export type { MentionJobListPage };
