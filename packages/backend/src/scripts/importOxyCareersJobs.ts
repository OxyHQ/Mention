/**
 * ONE-SHOT IMPORT: Oxy's own 21 careers listings, as Mention-owned jobs.
 *
 * ## Where the content came from
 *
 * `oxy.so/company/careers` used to store its listings in the website's own
 * database. That backend was removed when the site moved to reading Clarity
 * Jobs (OxyHQ/website#113), and the listings were recovered from the previous
 * PRERENDERED deployment — each page's `schema.org/JobPosting` JSON-LD, which
 * is the full public record of the listing. `fixtures/oxyCareersJobs.json`
 * holds that recovery, converted to Mention's create-request shape, with the
 * originating page kept on every entry (`sourceSlug`, `sourceUrl`) so a
 * reviewer can put any line of it back next to the page it came from.
 *
 * This script publishes them as the flow issue #952 / #1053 was built for:
 * Mention owns the listing, Clarity indexes it, and the website reads it back
 * out of Clarity. Nothing here writes into Clarity's corpus directly.
 *
 * ## It goes through the ordinary write path, deliberately
 *
 * No raw SQL. Every job is created by `db/jobs/jobRepository.createJob` after
 * its location is resolved by `services/jobPlaces.resolveJobLocation` and its
 * body is validated by the SAME `createJobSchema` the HTTP route parses, then
 * mirrored by `services/clarityJobsAdapter.syncJobToClarity`. A job imported
 * here is therefore indistinguishable from one an operator typed into the app:
 * same validation, same slug allocation, same derived place columns, same
 * Clarity payload.
 *
 * The one thing it does NOT go through is `services/jobAuthority`, which needs
 * an authenticated Express request. An administrative one-shot has no request;
 * what stands in for it is {@link assertAdminMutationAllowed} plus the employer
 * identity check below, which refuses to write if `OXY_EMPLOYER_OXY_USER_ID`
 * does not still resolve to the `oxy` account.
 *
 * ## Idempotency
 *
 * The key is **(employer, normalized title)**. `mention_jobs` has no column for
 * a foreign source id, and inventing one — a migration on the whole table — to
 * serve a single one-shot would be the wrong trade; the 21 titles are unique
 * among themselves and an employer does not hold two open listings with the
 * same title. A second run therefore matches every job it created on the first
 * and writes NOTHING.
 *
 * What the match does when it hits:
 *   - `published`         — skipped, untouched. The steady state.
 *   - `draft` / `paused`  — republished through `setJobStatus` and re-synced,
 *                           because the import's contract is "these are live".
 *   - `closed`/`expired`  — skipped and WARNED. Somebody closed that listing on
 *                           purpose and an import must never resurrect it.
 *
 * ## Places fail loudly
 *
 * Every entry names a GeoNames place id, and each is resolved against Clarity's
 * gazetteer before ANY write — in dry-run too, so the preview is what verifies
 * them. The resolved city and country are then checked against the locality the
 * original JSON-LD stated (`expectedLocality` / `expectedCountryCode`). A place
 * that cannot be resolved, or that resolves to somewhere else, aborts the whole
 * run rather than storing a wrong place on a public listing.
 *
 * ## Clarity is fail-soft, as everywhere else
 *
 * `syncJobToClarity` never throws: a Clarity outage records
 * `claritySyncStatus: 'failed'` on the row and the job stays created. The
 * summary reports each job's sync status, and a run with failed syncs exits
 * {@link EXIT_INCOMPLETE} — the jobs are committed, and the adapter's own lazy
 * retry (or a re-run of this script, which will skip the creates) heals them.
 *
 * ## Running it
 *
 *   DRY_RUN defaults to `true`; only `DRY_RUN=false` writes, and only together
 *   with `CONFIRM_ADMIN_MUTATION=importOxyCareersJobs`.
 *
 *   bun packages/backend/dist/src/scripts/importOxyCareersJobs.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=importOxyCareersJobs \
 *     bun packages/backend/dist/src/scripts/importOxyCareersJobs.js
 *
 * `.github/workflows/run-oxy-careers-jobs-import.yml` runs it as a Fargate
 * one-shot inside the VPC, which is the only place the database is reachable
 * from.
 */

import { z } from 'zod';
import type { MentionJobLocation } from '@mention/shared-types';
import {
  MENTION_JOB_APPLICATION_MODES,
  MENTION_JOB_EMPLOYMENT_TYPES,
  MENTION_JOB_WORKPLACE_TYPES,
} from '@mention/shared-types';
import { connectPostgres } from '../db/postgres';
import {
  createJob,
  getJobById,
  listJobsByEmployer,
  setJobStatus,
  type MentionJobRow,
} from '../db/jobs/jobRepository';
import { createJobSchema, jobLocationInputSchema } from '../controllers/jobsManagement.controller';
import { resolveJobLocation } from '../services/jobPlaces';
import { syncJobToClarity } from '../services/clarityJobsAdapter';
import { resolveUserSummaries } from '../services/PostHydrationService';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import rawOxyCareersJobs from './fixtures/oxyCareersJobs.json';

/** The Oxy organization account that employs every listing in the fixture. */
export const OXY_EMPLOYER_OXY_USER_ID = '69b2d3df5d12f58c9800d651';

/** The username {@link OXY_EMPLOYER_OXY_USER_ID} must still resolve to. */
export const OXY_EMPLOYER_USERNAME = 'oxy';

/** Recorded as `author_oxy_user_id` — audit only, never an authority (see `db/schema/jobs.ts`). */
export const OXY_CAREERS_IMPORT_AUTHOR_OXY_USER_ID = '6981c9178fcdefaf81988ffb';

/**
 * Exit code for "every job is committed, but some could not be mirrored to
 * Clarity". Distinct from a throw so the workflow can tell "re-run me" apart
 * from "the script broke" — the same split `backfillMediaMetadata` uses.
 */
export const EXIT_INCOMPLETE = 75;

/**
 * Ceiling on the employer's existing jobs this reads while building the
 * duplicate index. `listJobsByEmployer` caps at 100 and offers no cursor, so a
 * full page back is "there may be more" — and an incomplete index is how an
 * idempotent import silently stops being idempotent. It aborts instead.
 */
const EXISTING_JOBS_READ_LIMIT = 100;

/**
 * One recovered listing, exactly as `fixtures/oxyCareersJobs.json` holds it.
 *
 * `strictObject`, so a key nobody validates cannot ride along into a create
 * request. The job fields deliberately reuse the app's own vocabularies
 * (`MENTION_JOB_*`) and the route's own `jobLocationInputSchema`, rather than
 * a second spelling of them that could drift.
 */
export const oxyCareersJobEntrySchema = z.strictObject({
  /** The path segment of the originating careers page — provenance, and the human key. */
  sourceSlug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'sourceSlug must be a lower-case hyphenated slug'),
  /** The page the JSON-LD was recovered from. */
  sourceUrl: z.string().url(),
  title: z.string().min(1).max(200),
  /** Markdown, as `MentionJobPosting.description` is everywhere else. */
  description: z.string().min(1),
  workplaceType: z.enum(MENTION_JOB_WORKPLACE_TYPES),
  employmentType: z.enum(MENTION_JOB_EMPLOYMENT_TYPES),
  applicationMode: z.enum(MENTION_JOB_APPLICATION_MODES),
  /** Every recovered listing was live, and the import's contract is that they stay live. */
  publish: z.literal(true),
  location: jobLocationInputSchema.nullable(),
  /**
   * What the original JSON-LD said the place WAS. Checked against what Clarity
   * resolves the place id to, so a transposed id cannot quietly move a job to
   * another city. `null` only where the original stated no locality.
   */
  expectedLocality: z.string().min(1).nullable(),
  expectedCountryCode: z
    .string()
    .regex(/^[A-Z]{2}$/, 'expectedCountryCode must be an ISO 3166-1 alpha-2 code')
    .nullable(),
});

export type OxyCareersJobEntry = z.infer<typeof oxyCareersJobEntrySchema>;

const oxyCareersJobsSchema = z
  .array(oxyCareersJobEntrySchema)
  .min(1, 'the fixture must not be empty')
  .superRefine((entries, ctx) => {
    for (const [key, label] of [
      ['sourceSlug', 'sourceSlug'],
      ['title', 'title'],
    ] as const) {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        const value = key === 'title' ? idempotencyKey(entry.title) : entry[key];
        if (seen.has(value)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, key],
            message: `duplicate ${label} in the fixture; the import keys on it`,
          });
        }
        seen.add(value);
      });
    }
  });

/**
 * The stable key an already-imported job is recognised by: its title, trimmed,
 * whitespace-collapsed and case-folded. Not the slug — `createJob` appends a
 * random tail to every slug it allocates, so a stored slug can never be
 * recomputed from the fixture.
 */
export function idempotencyKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

/**
 * Read and validate the committed fixture. Pure: no database, no network, so
 * the shape is checkable on its own and a malformed entry fails before the
 * script has connected to anything.
 */
export function loadOxyCareersJobs(raw: unknown = rawOxyCareersJobs): OxyCareersJobEntry[] {
  return oxyCareersJobsSchema.parse(raw);
}

/** What the run decided to do with one entry. */
export type OxyCareersImportAction =
  /** No job with this title under this employer — create and publish it. */
  | 'create'
  /** A matching draft/paused job exists — publish it again. */
  | 'republish'
  /** A matching published job exists — nothing to do. */
  | 'skip_published'
  /** A matching closed/expired job exists — deliberately left closed. */
  | 'skip_closed';

export interface OxyCareersImportEntryResult {
  sourceSlug: string;
  action: OxyCareersImportAction;
  /** The job this entry resolved to. Absent on a dry run's `create`. */
  jobId?: string;
  /** The row's `clarity_sync_status` after the run touched it, when it did. */
  claritySyncStatus?: MentionJobRow['claritySyncStatus'];
}

export interface OxyCareersImportSummary {
  dryRun: boolean;
  employerOxyUserId: string;
  /** Fixture entries considered. */
  planned: number;
  created: number;
  republished: number;
  skippedPublished: number;
  skippedClosed: number;
  /** Jobs whose Clarity mirror did not take. Committed regardless — see the module docblock. */
  claritySyncFailed: number;
  entries: OxyCareersImportEntryResult[];
}

export interface ImportOxyCareersJobsOptions {
  /** Defaults to TRUE. A dry run resolves every place but writes nothing. */
  dryRun?: boolean;
  /** Overridable for tests; production always imports the committed fixture. */
  entries?: readonly OxyCareersJobEntry[];
  employerOxyUserId?: string;
  authorOxyUserId?: string;
}

/**
 * Refuse the run if the employer id no longer names the Oxy organization.
 *
 * A one-shot that publishes 21 public listings under the wrong account is not
 * recoverable by re-running it, so the id is checked against the username it is
 * supposed to belong to. An UNRESOLVABLE account only warns: Oxy being briefly
 * unreachable is not evidence that the id is wrong, and the adapter this same
 * summary feeds is itself fail-soft about it. A resolved MISMATCH throws.
 */
async function assertEmployerIsOxy(employerOxyUserId: string): Promise<void> {
  const summary = await resolveUserSummaries([employerOxyUserId])
    .then((summaries) => summaries.get(employerOxyUserId))
    .catch(() => undefined);
  const username = summary?.user?.username;
  if (!username) {
    logger.warn('[importOxyCareersJobs] could not resolve the employer account; continuing', {
      employer: employerOxyUserId,
    });
    return;
  }
  if (username !== OXY_EMPLOYER_USERNAME) {
    throw new Error(
      `[importOxyCareersJobs] employer ${employerOxyUserId} resolves to a different account than ${OXY_EMPLOYER_USERNAME}; refusing to publish`,
    );
  }
}

/**
 * Resolve one entry's place through Clarity and check it against what the
 * original listing said. Throws — a wrong or unresolvable place aborts the run.
 */
async function resolveEntryLocation(entry: OxyCareersJobEntry): Promise<MentionJobLocation | undefined> {
  if (!entry.location) return undefined;
  const location = await resolveJobLocation(entry.location);

  if (entry.expectedCountryCode && location.countryCode !== entry.expectedCountryCode) {
    throw new Error(
      `[importOxyCareersJobs] ${entry.sourceSlug}: place ${entry.location.placeId ?? '(country only)'} resolved to country ${location.countryCode}, not ${entry.expectedCountryCode}`,
    );
  }
  if (entry.expectedLocality) {
    const resolvedName = location.city ?? location.region;
    if (resolvedName !== entry.expectedLocality) {
      throw new Error(
        `[importOxyCareersJobs] ${entry.sourceSlug}: place ${entry.location.placeId ?? '(country only)'} resolved to ${resolvedName ?? '(no locality)'}, not ${entry.expectedLocality}`,
      );
    }
  }
  return location;
}

/** The employer's existing jobs, indexed by {@link idempotencyKey}. */
async function indexExistingJobs(employerOxyUserId: string): Promise<Map<string, MentionJobRow>> {
  const rows = await listJobsByEmployer(employerOxyUserId, { limit: EXISTING_JOBS_READ_LIMIT });
  if (rows.length >= EXISTING_JOBS_READ_LIMIT) {
    throw new Error(
      `[importOxyCareersJobs] the employer already has at least ${EXISTING_JOBS_READ_LIMIT} jobs; the duplicate index would be incomplete and the import could insert twice`,
    );
  }
  const index = new Map<string, MentionJobRow>();
  for (const row of rows) {
    // First wins: `listJobsByEmployer` orders newest-first, and if two rows ever
    // shared a title the newer one is the one a re-run should recognise.
    const key = idempotencyKey(row.title);
    if (!index.has(key)) index.set(key, row);
  }
  return index;
}

/** Mirror one row to Clarity and read back what the adapter recorded on it. */
async function syncAndReport(row: MentionJobRow): Promise<MentionJobRow['claritySyncStatus']> {
  // Awaited, not the fire-and-forget wrapper the routes use: a one-shot exits
  // as soon as this function returns, so a backgrounded sync would be killed
  // mid-flight and the summary would have nothing to report.
  await syncJobToClarity(row);
  const refreshed = await getJobById(row.id);
  return refreshed?.claritySyncStatus ?? 'pending';
}

/**
 * Plan the import, and — unless `dryRun` — perform it. Never partially
 * validates: every entry is parsed and every place resolved before the first
 * write, so a bad fixture cannot leave half the listings published.
 */
export async function importOxyCareersJobs(
  options: ImportOxyCareersJobsOptions = {},
): Promise<OxyCareersImportSummary> {
  const dryRun = options.dryRun ?? true;
  const employerOxyUserId = options.employerOxyUserId ?? OXY_EMPLOYER_OXY_USER_ID;
  const authorOxyUserId = options.authorOxyUserId ?? OXY_CAREERS_IMPORT_AUTHOR_OXY_USER_ID;
  const entries = options.entries ?? loadOxyCareersJobs();

  // Only for the real employer: a test or a rehearsal against another account
  // has no `oxy` username to match, and the check exists to protect THIS import.
  if (employerOxyUserId === OXY_EMPLOYER_OXY_USER_ID) {
    await assertEmployerIsOxy(employerOxyUserId);
  }

  // Phase 1 — everything that can refuse, before anything that writes.
  const existing = await indexExistingJobs(employerOxyUserId);
  const planned: {
    entry: OxyCareersJobEntry;
    location: MentionJobLocation | undefined;
    match: MentionJobRow | undefined;
  }[] = [];

  for (const entry of entries) {
    const location = await resolveEntryLocation(entry);
    // The route's own contract, on the exact object the repository will store.
    // Parsing it here means a fixture that the API would reject can never reach
    // `createJob`, where only the table's CHECK constraints would still be
    // watching.
    createJobSchema.parse({
      employerOxyUserId,
      title: entry.title,
      description: entry.description,
      ...(entry.location ? { location: entry.location } : {}),
      workplaceType: entry.workplaceType,
      employmentType: entry.employmentType,
      applicationMode: entry.applicationMode,
      publish: entry.publish,
    });
    planned.push({ entry, location, match: existing.get(idempotencyKey(entry.title)) });
  }

  logger.info('[importOxyCareersJobs] plan resolved', {
    dryRun,
    employer: employerOxyUserId,
    planned: planned.length,
    creates: planned.filter((item) => !item.match).length,
    matches: planned.filter((item) => item.match).length,
  });

  // Phase 2 — act.
  const summary: OxyCareersImportSummary = {
    dryRun,
    employerOxyUserId,
    planned: planned.length,
    created: 0,
    republished: 0,
    skippedPublished: 0,
    skippedClosed: 0,
    claritySyncFailed: 0,
    entries: [],
  };

  for (const { entry, location, match } of planned) {
    if (match) {
      if (match.status === 'closed' || match.status === 'expired') {
        summary.skippedClosed += 1;
        summary.entries.push({ sourceSlug: entry.sourceSlug, action: 'skip_closed', jobId: match.id });
        logger.warn('[importOxyCareersJobs] a matching job is closed; leaving it closed', {
          sourceSlug: entry.sourceSlug,
          job: match.id,
          status: match.status,
        });
        continue;
      }
      if (match.status === 'published') {
        summary.skippedPublished += 1;
        summary.entries.push({
          sourceSlug: entry.sourceSlug,
          action: 'skip_published',
          jobId: match.id,
          claritySyncStatus: match.claritySyncStatus,
        });
        continue;
      }

      // draft or paused: the import's contract is that these are live.
      summary.republished += 1;
      if (dryRun) {
        summary.entries.push({ sourceSlug: entry.sourceSlug, action: 'republish', jobId: match.id });
        continue;
      }
      const republished = await setJobStatus(match.id, 'published');
      const claritySyncStatus = republished ? await syncAndReport(republished) : undefined;
      if (claritySyncStatus === 'failed') summary.claritySyncFailed += 1;
      summary.entries.push({
        sourceSlug: entry.sourceSlug,
        action: 'republish',
        jobId: match.id,
        claritySyncStatus,
      });
      continue;
    }

    summary.created += 1;
    if (dryRun) {
      summary.entries.push({ sourceSlug: entry.sourceSlug, action: 'create' });
      continue;
    }

    const row = await createJob({
      employerOxyUserId,
      authorOxyUserId,
      title: entry.title,
      description: entry.description,
      location,
      workplaceType: entry.workplaceType,
      employmentType: entry.employmentType,
      applicationMode: entry.applicationMode,
      publish: entry.publish,
    });
    // The Clarity mirror is best-effort by construction, so it is NOT inside
    // the create's failure domain: the job is committed above whatever happens
    // below, which is the whole point of the fail-soft adapter.
    const claritySyncStatus = await syncAndReport(row);
    if (claritySyncStatus === 'failed') summary.claritySyncFailed += 1;
    summary.entries.push({
      sourceSlug: entry.sourceSlug,
      action: 'create',
      jobId: row.id,
      claritySyncStatus,
    });
  }

  return summary;
}

/** The per-entry lines and the totals, at INFO. Ids ride in the context, never the message. */
function logSummary(summary: OxyCareersImportSummary): void {
  for (const entry of summary.entries) {
    logger.info('[importOxyCareersJobs] entry', {
      dryRun: summary.dryRun,
      sourceSlug: entry.sourceSlug,
      action: entry.action,
      job: entry.jobId,
      claritySync: entry.claritySyncStatus,
    });
  }
  logger.info('[importOxyCareersJobs] complete', {
    dryRun: summary.dryRun,
    employer: summary.employerOxyUserId,
    planned: summary.planned,
    created: summary.created,
    republished: summary.republished,
    skippedPublished: summary.skippedPublished,
    skippedClosed: summary.skippedClosed,
    claritySyncFailed: summary.claritySyncFailed,
  });
}

async function main(): Promise<void> {
  // DEFAULT TRUE. An import that writes when nobody said `DRY_RUN` is one
  // typo away from 21 public listings; the preview costs a minute.
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';

  try {
    assertAdminMutationAllowed({ scriptName: 'importOxyCareersJobs', dryRun });
    await connectPostgres();
    logger.info('[importOxyCareersJobs] connected to PostgreSQL', { dryRun });

    const summary = await importOxyCareersJobs({ dryRun });
    logSummary(summary);

    // Committed, but not fully mirrored. See EXIT_INCOMPLETE.
    if (summary.claritySyncFailed > 0) process.exitCode = EXIT_INCOMPLETE;
  } finally {
    await closeAdminScriptResources().catch(() => undefined);
  }
}

if (require.main === module) {
  main()
    // `process.exitCode`, not `exit(0)`: `main` sets EXIT_INCOMPLETE when some
    // Clarity syncs failed, and exiting zero here would erase it. The explicit
    // exit is still needed — imported singletons keep the event loop alive.
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((error) => {
      logger.error('[importOxyCareersJobs] failed', error);
      process.exit(1);
    });
}

export default importOxyCareersJobs;
