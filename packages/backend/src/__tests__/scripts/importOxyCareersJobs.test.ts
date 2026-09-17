/**
 * The Oxy careers one-shot, against real rows.
 *
 * Three properties, and they are the three a reviewer has to believe before the
 * import runs once against production:
 *
 *  1. **The committed fixture is valid** — all 21 recovered listings parse
 *     against the same contract the HTTP create route uses, and a malformed
 *     entry is rejected rather than written.
 *  2. **It is idempotent** — a second run over the same employer creates
 *     nothing, touches nothing, and says so.
 *  3. **Clarity is fail-soft** — an ingest that throws still leaves the job
 *     created and published, carrying `clarity_sync_status = 'failed'` for the
 *     adapter's own lazy retry to pick up.
 *
 * The employer is overridden per test, which is also what keeps this file out
 * of `isolatedDatabaseFiles.ts`: the import's driving SELECT is
 * `listJobsByEmployer`, scoped to one account, so it can never reach a row
 * another suite seeded.
 *
 * Clarity is mocked at `utils/clarityClient`, the single seam both the place
 * lookup and the ingest go through — so `resolveJobLocation` and
 * `syncJobToClarity` run for real over a fake gazetteer rather than being
 * stubbed out, which is the only way the place-verification assertions mean
 * anything.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const placesGet = vi.fn();
const jobsIngest = vi.fn();
vi.mock('../../utils/clarityClient', () => ({
  getClarityClient: async () => ({
    places: { get: placesGet },
    jobs: { ingest: jobsIngest },
  }),
}));

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn(async (ids: string[]) => {
    const summaries = new Map<string, unknown>();
    for (const id of ids) {
      summaries.set(id, { user: { id, username: 'oxy', name: { displayName: 'Oxy' } } });
    }
    return summaries;
  }),
}));

import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres';
import { mentionJobs } from '../../db/schema/jobs';
import {
  OXY_CAREERS_IMPORT_AUTHOR_OXY_USER_ID,
  idempotencyKey,
  importOxyCareersJobs,
  loadOxyCareersJobs,
  oxyCareersJobEntrySchema,
  type OxyCareersJobEntry,
} from '../../scripts/importOxyCareersJobs';

let db: Database;
let employerSeq = 0;

/** A fresh employer per test, so no two tests can see each other's rows. */
function nextEmployer(): string {
  employerSeq += 1;
  return `oxy-careers-import-employer-${employerSeq}-${Date.now()}`;
}

const BARCELONA = {
  id: '3128760',
  kind: 'city',
  name: 'Barcelona',
  countryCode: 'ES',
  admin1Name: 'Catalonia',
};

function entry(overrides: Partial<OxyCareersJobEntry> = {}): OxyCareersJobEntry {
  return oxyCareersJobEntrySchema.parse({
    sourceSlug: 'account-manager-remote',
    sourceUrl: 'https://oxy.so/company/careers/account-manager-remote/',
    title: 'Account Manager',
    description: 'Own the relationships.',
    workplaceType: 'remote',
    employmentType: 'full_time',
    applicationMode: 'mention',
    publish: true,
    location: { placeId: '3128760' },
    expectedLocality: 'Barcelona',
    expectedCountryCode: 'ES',
    ...overrides,
  });
}

async function rowsFor(employer: string) {
  return db
    .select()
    .from(mentionJobs)
    .where(eq(mentionJobs.employerOxyUserId, employer));
}

beforeAll(async () => {
  await connectPostgres();
  db = getDb();
  return async () => {
    await closePostgres();
  };
});

beforeEach(() => {
  placesGet.mockResolvedValue(BARCELONA);
  jobsIngest.mockResolvedValue({ job: { id: 'clarity-doc-1' } });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the committed fixture', () => {
  it('holds every recovered Oxy listing, valid against the create contract', () => {
    const entries = loadOxyCareersJobs();

    expect(entries).toHaveLength(21);
    for (const item of entries) {
      expect(item.publish).toBe(true);
      // The website reads these back out of Clarity; applications belong in
      // Mention, so none of them may route to an external ATS.
      expect(item.applicationMode).toBe('mention');
      expect(item.employmentType).toBe('full_time');
      expect(item.sourceUrl.startsWith('https://oxy.so/company/careers/')).toBe(true);
      expect(item.description.length).toBeGreaterThan(200);
    }
    // The idempotency key has to be unique across the fixture or the import
    // would recognise one listing as another.
    const keys = new Set(entries.map((item) => idempotencyKey(item.title)));
    expect(keys.size).toBe(entries.length);
  });

  it('only names places the run verifies', () => {
    for (const item of loadOxyCareersJobs()) {
      expect(item.location?.placeId).toMatch(/^[1-9][0-9]*$/);
      expect(item.expectedLocality).toBeTruthy();
      expect(item.expectedCountryCode).toMatch(/^[A-Z]{2}$/);
    }
  });

  it.each([
    ['an unknown key', { note: 'ride-along' }],
    ['a workplace type outside the vocabulary', { workplaceType: 'hyperspace' }],
    ['an application mode the schema does not know', { applicationMode: 'carrier_pigeon' }],
    ['a location naming both a place and a country', { location: { placeId: '1', countryCode: 'ES' } }],
    ['an unpublished entry', { publish: false }],
    ['an empty description', { description: '' }],
  ])('rejects %s', (_shape, override) => {
    expect(() => entry(override as Partial<OxyCareersJobEntry>)).toThrow();
  });

  it('rejects a fixture whose titles collide, because the key would be ambiguous', () => {
    const duplicated = [
      { ...entry(), sourceSlug: 'a-manager' },
      { ...entry(), sourceSlug: 'b-manager', title: '  account   MANAGER ' },
    ];
    expect(() => loadOxyCareersJobs(duplicated)).toThrow(/duplicate title/);
  });
});

describe('importing', () => {
  it('publishes each listing as a Mention-owned job and mirrors it to Clarity', async () => {
    const employer = nextEmployer();
    const entries = [entry(), entry({ sourceSlug: 'data-analyst-remote', title: 'Data Analyst' })];

    const summary = await importOxyCareersJobs({ dryRun: false, employerOxyUserId: employer, entries });

    expect(summary).toMatchObject({
      dryRun: false,
      planned: 2,
      created: 2,
      republished: 0,
      skippedPublished: 0,
      skippedClosed: 0,
      claritySyncFailed: 0,
    });
    expect(summary.entries.map((item) => item.action)).toEqual(['create', 'create']);
    expect(summary.entries.every((item) => item.claritySyncStatus === 'synced')).toBe(true);

    const rows = await rowsFor(employer);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('published');
      expect(row.publishedAt).toBeInstanceOf(Date);
      expect(row.authorOxyUserId).toBe(OXY_CAREERS_IMPORT_AUTHOR_OXY_USER_ID);
      expect(row.applicationMode).toBe('mention');
      expect(row.externalApplyUrl).toBeNull();
      // Derived from the place by `resolveJobLocation`, never taken from the fixture.
      expect(row.locationPlaceId).toBe('3128760');
      expect(row.locationCountryCode).toBe('ES');
      expect(row.locationCity).toBe('Barcelona');
      expect(row.claritySyncStatus).toBe('synced');
      expect(row.clarityDocumentId).toBe('clarity-doc-1');
    }
    expect(jobsIngest).toHaveBeenCalledTimes(2);
  });

  it('writes nothing on a dry run, having resolved every place first', async () => {
    const employer = nextEmployer();

    const summary = await importOxyCareersJobs({
      employerOxyUserId: employer,
      entries: [entry()],
    });

    expect(summary).toMatchObject({ dryRun: true, created: 1 });
    expect(summary.entries[0]).toEqual({ sourceSlug: 'account-manager-remote', action: 'create' });
    expect(await rowsFor(employer)).toHaveLength(0);
    // The preview is what verifies the place ids, so the lookup still happens.
    expect(placesGet).toHaveBeenCalledWith('3128760');
    expect(jobsIngest).not.toHaveBeenCalled();
  });

  it('is idempotent: a second run creates nothing and touches nothing', async () => {
    const employer = nextEmployer();
    const entries = [entry(), entry({ sourceSlug: 'data-analyst-remote', title: 'Data Analyst' })];

    await importOxyCareersJobs({ dryRun: false, employerOxyUserId: employer, entries });
    const before = (await rowsFor(employer))
      .map((row) => ({ id: row.id, slug: row.slug, updatedAt: row.updatedAt.toISOString() }))
      .sort((a, b) => a.id.localeCompare(b.id));
    jobsIngest.mockClear();

    const second = await importOxyCareersJobs({ dryRun: false, employerOxyUserId: employer, entries });

    expect(second).toMatchObject({
      planned: 2,
      created: 0,
      republished: 0,
      skippedPublished: 2,
      claritySyncFailed: 0,
    });
    expect(second.entries.map((item) => item.action)).toEqual(['skip_published', 'skip_published']);

    const after = (await rowsFor(employer))
      .map((row) => ({ id: row.id, slug: row.slug, updatedAt: row.updatedAt.toISOString() }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(after).toEqual(before);
    // A skip is a skip: it does not re-ingest either.
    expect(jobsIngest).not.toHaveBeenCalled();
  });

  it('recognises a job whose title differs only in case and spacing', async () => {
    const employer = nextEmployer();
    await importOxyCareersJobs({ dryRun: false, employerOxyUserId: employer, entries: [entry()] });

    const second = await importOxyCareersJobs({
      dryRun: false,
      employerOxyUserId: employer,
      entries: [entry({ title: 'account   Manager' })],
    });

    expect(second.created).toBe(0);
    expect(second.skippedPublished).toBe(1);
    expect(await rowsFor(employer)).toHaveLength(1);
  });

  it('republishes a matching job that had been paused, and re-syncs it', async () => {
    const employer = nextEmployer();
    await importOxyCareersJobs({ dryRun: false, employerOxyUserId: employer, entries: [entry()] });
    const [row] = await rowsFor(employer);
    await db.update(mentionJobs).set({ status: 'paused' }).where(eq(mentionJobs.id, row.id));
    jobsIngest.mockClear();

    const summary = await importOxyCareersJobs({
      dryRun: false,
      employerOxyUserId: employer,
      entries: [entry()],
    });

    expect(summary).toMatchObject({ created: 0, republished: 1 });
    expect(jobsIngest).toHaveBeenCalledTimes(1);
    const [after] = await rowsFor(employer);
    expect(after.id).toBe(row.id);
    expect(after.status).toBe('published');
  });

  it('leaves a deliberately closed listing closed', async () => {
    const employer = nextEmployer();
    await importOxyCareersJobs({ dryRun: false, employerOxyUserId: employer, entries: [entry()] });
    const [row] = await rowsFor(employer);
    await db.update(mentionJobs).set({ status: 'closed' }).where(eq(mentionJobs.id, row.id));
    jobsIngest.mockClear();

    const summary = await importOxyCareersJobs({
      dryRun: false,
      employerOxyUserId: employer,
      entries: [entry()],
    });

    expect(summary).toMatchObject({ created: 0, republished: 0, skippedClosed: 1 });
    const [after] = await rowsFor(employer);
    expect(after.status).toBe('closed');
    expect(jobsIngest).not.toHaveBeenCalled();
  });
});

describe('Clarity failures', () => {
  it('still leaves the job created and published when the ingest throws', async () => {
    const employer = nextEmployer();
    jobsIngest.mockRejectedValue(new Error('clarity is down'));

    const summary = await importOxyCareersJobs({
      dryRun: false,
      employerOxyUserId: employer,
      entries: [entry()],
    });

    expect(summary).toMatchObject({ created: 1, claritySyncFailed: 1 });
    expect(summary.entries[0].claritySyncStatus).toBe('failed');

    const [row] = await rowsFor(employer);
    expect(row.status).toBe('published');
    expect(row.claritySyncStatus).toBe('failed');
    expect(row.claritySyncError).toContain('clarity is down');
    // Left for the adapter's lazy retry rather than rolled back.
    expect(row.claritySyncAttempts).toBe(1);
  });

  it('is still idempotent after a failed sync — the job is created, so it is not created again', async () => {
    const employer = nextEmployer();
    jobsIngest.mockRejectedValue(new Error('clarity is down'));
    await importOxyCareersJobs({ dryRun: false, employerOxyUserId: employer, entries: [entry()] });

    const second = await importOxyCareersJobs({
      dryRun: false,
      employerOxyUserId: employer,
      entries: [entry()],
    });

    expect(second).toMatchObject({ created: 0, skippedPublished: 1 });
    expect(await rowsFor(employer)).toHaveLength(1);
  });
});

describe('place verification', () => {
  it('aborts before any write when a place resolves to another city', async () => {
    const employer = nextEmployer();
    placesGet.mockResolvedValue({ ...BARCELONA, id: '756135', name: 'Warsaw', countryCode: 'PL' });

    await expect(
      importOxyCareersJobs({
        dryRun: false,
        employerOxyUserId: employer,
        entries: [entry(), entry({ sourceSlug: 'data-analyst-remote', title: 'Data Analyst' })],
      }),
    ).rejects.toThrow(/resolved to/);

    expect(await rowsFor(employer)).toHaveLength(0);
    expect(jobsIngest).not.toHaveBeenCalled();
  });

  it('aborts when the gazetteer cannot answer, rather than storing an unverified place', async () => {
    const employer = nextEmployer();
    placesGet.mockRejectedValue(new Error('gateway timeout'));

    await expect(
      importOxyCareersJobs({ dryRun: false, employerOxyUserId: employer, entries: [entry()] }),
    ).rejects.toThrow(/unavailable/i);

    expect(await rowsFor(employer)).toHaveLength(0);
  });
});
