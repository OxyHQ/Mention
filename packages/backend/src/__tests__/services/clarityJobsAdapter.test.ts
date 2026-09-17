/**
 * `buildJobPostingJsonLd` against Clarity's first-party ingest contract
 * (`POST /v1/jobs/ingest`, Clarity `docs/jobs.mdx` "Ingest contract"), and the
 * sync's handling of a `400 invalid_job_posting`.
 *
 * The contract assertions are written as the literal payload Clarity documents,
 * not as a re-derivation of the builder's own logic: an exact `toEqual` on the
 * whole document is what catches a stray free-text field (the old
 * `streetAddress: raw`) or a string where a number belongs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MentionJobPosting } from '@mention/shared-types';

const ingest = vi.fn();
vi.mock('../../utils/clarityClient', () => ({
  getClarityClient: async () => ({ jobs: { ingest } }),
}));

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn(async (ids: string[]) => {
    const summaries = new Map();
    for (const id of ids) {
      summaries.set(id, { user: { id, username: 'acme', name: { displayName: 'Acme Inc.' }, avatar: 'https://cdn.example.com/acme.png' } });
    }
    return summaries;
  }),
}));

const recordClaritySync = vi.fn(async () => undefined);
vi.mock('../../db/jobs/jobRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/jobs/jobRepository')>();
  return { ...actual, recordClaritySync: (...args: unknown[]) => recordClaritySync(...(args as [])) };
});

import {
  buildJobPostingJsonLd,
  describeClaritySyncError,
  syncJobToClarity,
} from '../../services/clarityJobsAdapter';
import type { MentionJobRow } from '../../db/jobs/jobRepository';

const ORGANIZATION = { name: 'Mention', url: 'https://mention.earth/@mention', logo: 'https://mention.earth/logo.png' };

function job(overrides: Partial<MentionJobPosting> = {}): MentionJobPosting {
  return {
    id: '7',
    employerOxyUserId: 'employer-1',
    authorOxyUserId: 'author-1',
    title: 'Community Manager',
    description: '## About the role\n\nGrow the **Mention** community.',
    skills: [],
    applicationMode: 'external',
    externalApplyUrl: 'https://example.com/apply',
    status: 'published',
    slug: 'community-manager-7',
    canonicalUrl: 'https://mention.earth/jobs/7',
    applicationCount: 0,
    claritySyncStatus: 'pending',
    publishedAt: '2026-09-17T08:30:00.000Z',
    createdAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-17T08:30:00.000Z',
    ...overrides,
  };
}

class FakeClarityError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly requestId: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ClarityError';
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildJobPostingJsonLd', () => {
  it('emits the documented complete payload for a city place with a salary', () => {
    const document = buildJobPostingJsonLd(
      job({
        employmentType: 'full_time',
        location: { placeId: '3128760', countryCode: 'ES', region: 'Catalonia', city: 'Barcelona' },
        salary: { min: 40000, max: 55000, currency: 'EUR', interval: 'year' },
        closesAt: '2026-12-31T23:59:59.000Z',
      }),
      ORGANIZATION,
    );

    expect(document).toEqual({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Community Manager',
      description: '## About the role\n\nGrow the **Mention** community.',
      identifier: { '@type': 'PropertyValue', name: 'Mention', value: '7' },
      datePosted: '2026-09-17',
      validThrough: '2026-12-31T23:59:59.000Z',
      employmentType: ['FULL_TIME'],
      hiringOrganization: {
        '@type': 'Organization',
        name: 'Mention',
        url: 'https://mention.earth/@mention',
        logo: 'https://mention.earth/logo.png',
      },
      directApply: false,
      jobLocation: [
        {
          '@type': 'Place',
          sameAs: 'https://www.geonames.org/3128760',
          address: {
            '@type': 'PostalAddress',
            addressLocality: 'Barcelona',
            addressRegion: 'Catalonia',
            addressCountry: 'ES',
          },
        },
      ],
      baseSalary: {
        '@type': 'MonetaryAmount',
        currency: 'EUR',
        value: { '@type': 'QuantitativeValue', minValue: 40000, maxValue: 55000, unitText: 'YEAR' },
      },
      url: 'https://mention.earth/jobs/7',
    });
  });

  it('states a country-only remote role as addressCountry alone, with TELECOMMUTE', () => {
    const document = buildJobPostingJsonLd(
      job({ workplaceType: 'remote', location: { countryCode: 'DE' } }),
      ORGANIZATION,
    );
    expect(document.jobLocation).toEqual([
      { '@type': 'Place', address: { '@type': 'PostalAddress', addressCountry: 'DE' } },
    ]);
    expect(document.jobLocationType).toBe('TELECOMMUTE');
  });

  it('never writes free text into streetAddress, and a region place has no locality', () => {
    const document = buildJobPostingJsonLd(
      job({ location: { placeId: '3336901', countryCode: 'ES', region: 'Catalonia' } }),
      ORGANIZATION,
    );
    const [place] = document.jobLocation as Array<{ address: Record<string, unknown> }>;
    expect(place.address).toEqual({ '@type': 'PostalAddress', addressRegion: 'Catalonia', addressCountry: 'ES' });
    expect(JSON.stringify(document)).not.toContain('streetAddress');
  });

  it('omits jobLocation for a job with no location, and jobLocationType unless remote', () => {
    const document = buildJobPostingJsonLd(job({ workplaceType: 'onsite' }), ORGANIZATION);
    expect(document).not.toHaveProperty('jobLocation');
    expect(document).not.toHaveProperty('jobLocationType');
  });

  it('maps every Mention employment type onto the schema.org value Clarity reads', () => {
    const expected = {
      full_time: 'FULL_TIME',
      part_time: 'PART_TIME',
      contract: 'CONTRACTOR',
      temporary: 'TEMPORARY',
      internship: 'INTERN',
      other: 'OTHER',
    } as const;
    for (const [employmentType, schemaValue] of Object.entries(expected)) {
      const document = buildJobPostingJsonLd(job({ employmentType: employmentType as keyof typeof expected }), ORGANIZATION);
      expect(document.employmentType).toEqual([schemaValue]);
    }
  });

  it('sends numeric amounts, drops an absent bound, and upper-cases WEEK', () => {
    const document = buildJobPostingJsonLd(
      job({ salary: { min: 900, currency: 'GBP', interval: 'week' } }),
      ORGANIZATION,
    );
    expect(document.baseSalary).toEqual({
      '@type': 'MonetaryAmount',
      currency: 'GBP',
      value: { '@type': 'QuantitativeValue', minValue: 900, unitText: 'WEEK' },
    });
  });

  it('omits a salary that states no amount instead of sending one Clarity rejects', () => {
    const document = buildJobPostingJsonLd(
      job({ salary: { currency: 'USD', interval: 'hour' } }),
      ORGANIZATION,
    );
    expect(document).not.toHaveProperty('baseSalary');
  });

  it('marks a closed job as ending now and omits organization fields Mention does not have', () => {
    const now = new Date('2026-09-18T00:00:00.000Z');
    const document = buildJobPostingJsonLd(job({ status: 'closed' }), { name: 'Acme' }, now);
    expect(document.validThrough).toBe('2026-09-18T00:00:00.000Z');
    expect(document.hiringOrganization).toEqual({ '@type': 'Organization', name: 'Acme' });
  });

  it('falls back to the creation date for datePosted when the job was never published', () => {
    const document = buildJobPostingJsonLd(job({ status: 'draft', publishedAt: undefined }), ORGANIZATION);
    expect(document.datePosted).toBe('2026-09-16');
  });
});

describe('describeClaritySyncError', () => {
  it('records every field-level issue of a 400 invalid_job_posting', () => {
    const error = new FakeClarityError('Invalid job posting', 'invalid_job_posting', 400, 'req-1', {
      issues: [
        { path: 'jobLocation[0].sameAs', code: 'unknown_place', message: 'No such place' },
        { path: 'baseSalary.currency', code: 'unknown_currency', message: 'Not an ISO 4217 code' },
      ],
    });
    expect(describeClaritySyncError(error)).toBe(
      'invalid_job_posting: jobLocation[0].sameAs: unknown_place (No such place); baseSalary.currency: unknown_currency (Not an ISO 4217 code)',
    );
  });

  it('keeps the plain message for any other failure', () => {
    expect(describeClaritySyncError(new Error('socket hang up'))).toBe('socket hang up');
    expect(describeClaritySyncError(new FakeClarityError('Forbidden', 'forbidden', 403, 'req-2'))).toBe('Forbidden');
  });
});

describe('syncJobToClarity', () => {
  const row = {
    id: 'job-row-1',
    employerOxyUserId: 'employer-1',
    authorOxyUserId: 'author-1',
    title: 'Engineer',
    description: 'Build things.',
    locationPlaceId: '3128760',
    locationCountryCode: 'ES',
    locationRegion: 'Catalonia',
    locationCity: 'Barcelona',
    workplaceType: 'hybrid',
    employmentType: 'full_time',
    salaryMin: 50000,
    salaryMax: 60000,
    salaryCurrency: 'EUR',
    salaryInterval: 'year',
    skills: [],
    applicationMode: 'external',
    externalApplyUrl: 'https://example.com/apply',
    status: 'published',
    slug: 'engineer-abc',
    applicationCount: 0,
    claritySyncStatus: 'pending',
    clarityDocumentId: null,
    claritySyncedAt: null,
    claritySyncError: null,
    claritySyncAttempts: 0,
    publishedAt: new Date('2026-09-17T08:00:00.000Z'),
    closesAt: null,
    createdAt: new Date('2026-09-17T08:00:00.000Z'),
    updatedAt: new Date('2026-09-17T08:00:00.000Z'),
  } as MentionJobRow;

  it('ingests the contract payload with the employer resolved from Oxy', async () => {
    ingest.mockResolvedValueOnce({ url: 'https://mention.earth/jobs/engineer-abc', status: 'indexed', job: { id: 'clarity-1' } });
    await syncJobToClarity(row);

    expect(ingest).toHaveBeenCalledTimes(1);
    const [request] = ingest.mock.calls[0] as [{ jobPosting: Record<string, unknown> }];
    expect(request.jobPosting.hiringOrganization).toMatchObject({
      name: 'Acme Inc.',
      url: expect.stringMatching(/\/@acme$/),
    });
    expect(request.jobPosting.jobLocation).toEqual([
      expect.objectContaining({ sameAs: 'https://www.geonames.org/3128760' }),
    ]);
    expect(recordClaritySync).toHaveBeenCalledWith('job-row-1', { status: 'synced', clarityDocumentId: 'clarity-1' });
  });

  it('records the issues of a rejected payload as the sync error, without throwing', async () => {
    ingest.mockRejectedValueOnce(
      new FakeClarityError('Invalid job posting', 'invalid_job_posting', 400, 'req-3', {
        issues: [{ path: 'jobLocation[0].sameAs', code: 'place_country_mismatch', message: 'Place is not in ES' }],
      }),
    );
    await expect(syncJobToClarity(row)).resolves.toBeUndefined();
    expect(recordClaritySync).toHaveBeenCalledWith('job-row-1', {
      status: 'failed',
      error: 'invalid_job_posting: jobLocation[0].sameAs: place_country_mismatch (Place is not in ES)',
    });
  });
});
