/**
 * Job locations and salaries are closed values (Clarity Jobs' validated ingest
 * contract): the write routes reject free text with field-level issues, derive
 * a place's country/region/city from Clarity instead of the client, and the
 * form's autocomplete reaches Clarity only through `GET /jobs/places/search`.
 *
 * Runs the real routers — public `jobs` first, then `jobsManagement`, in the
 * order `appRoutes.ts` mounts them, so the public `GET /jobs/:id` is proven not
 * to shadow the places route — against the real Postgres test database, with
 * the Clarity client mocked.
 */

import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxy.so/core/server';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { mentionJobs } from '../../db/schema/jobs';
import { getJobById } from '../../db/jobs/jobRepository';
import jobsRouter from '../../routes/jobs';
import jobsManagementRouter from '../../routes/jobsManagement';

const run = randomUUID();
const EMPLOYER_ID = `employer-${run}`;
const OPERATOR_ID = `operator-${run}`;
const OUTSIDER_ID = `outsider-${run}`;

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn(async (ids: string[]) => {
    const summaries = new Map();
    for (const id of ids) {
      if (id === EMPLOYER_ID) {
        summaries.set(id, { user: { id, username: 'acme-hiring', kind: 'organization' } });
      }
    }
    return summaries;
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: () => ({
    listAccountMembers: async (accountId: string) =>
      accountId === EMPLOYER_ID
        ? [{ memberUserId: OPERATOR_ID, status: 'active', permissions: ['account:act_as'] }]
        : [],
  }),
}));

class FakeClarityError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ClarityError';
  }
}

const BARCELONA = {
  id: '3128760',
  kind: 'city',
  name: 'Barcelona',
  asciiName: 'Barcelona',
  countryCode: 'ES',
  admin1Code: '56',
  admin1Name: 'Catalonia',
  population: 1620343,
};
const CATALONIA = {
  id: '3336901',
  kind: 'region',
  name: 'Catalonia',
  asciiName: 'Catalonia',
  countryCode: 'ES',
  admin1Code: '56',
  admin1Name: 'Catalonia',
};
const PLACES: Record<string, unknown> = { [BARCELONA.id]: BARCELONA, [CATALONIA.id]: CATALONIA };

const placesClient = {
  get: vi.fn(async (id: string) => {
    const place = PLACES[id];
    if (!place) throw new FakeClarityError('Place not found', 'not_found', 404);
    return place;
  }),
  search: vi.fn(async (_request: unknown) => ({ data: [BARCELONA, CATALONIA] })),
};
vi.mock('../../utils/clarityClient', () => ({
  getClarityClient: async () => ({
    places: placesClient,
    jobs: { ingest: vi.fn(async () => ({ url: 'x', status: 'indexed' })), search: vi.fn() },
  }),
}));

let db: Database;

const app = express();
app.use(express.json());
app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
  const testUser = req.header('x-test-user');
  if (testUser) req.user = { id: testUser };
  next();
});
app.use('/jobs', jobsRouter);
app.use('/jobs', jobsManagementRouter);

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  vi.clearAllMocks();
  await db.delete(mentionJobs).where(eq(mentionJobs.employerOxyUserId, EMPLOYER_ID));
});

afterAll(async () => {
  await closePostgres();
});

function createJob(body: Record<string, unknown>) {
  return request(app)
    .post('/jobs')
    .set('x-test-user', OPERATOR_ID)
    .send({
      employerOxyUserId: EMPLOYER_ID,
      title: 'Widget Engineer',
      description: 'Build widgets.',
      applicationMode: 'external',
      externalApplyUrl: 'https://example.com/apply',
      ...body,
    });
}

describe('GET /jobs/places/search', () => {
  it('requires a signed-in user', async () => {
    const res = await request(app).get('/jobs/places/search').query({ q: 'barc' });
    expect(res.status).toBe(401);
    expect(placesClient.search).not.toHaveBeenCalled();
  });

  it('is not shadowed by the public GET /jobs/:id, and returns picker-shaped places', async () => {
    const res = await request(app)
      .get('/jobs/places/search')
      .set('x-test-user', OUTSIDER_ID)
      .query({ q: ' barc ', countryCode: 'ES', kind: 'city', limit: '5' });

    expect(res.status).toBe(200);
    expect(placesClient.search).toHaveBeenCalledWith({ q: 'barc', countryCode: 'ES', kind: 'city', limit: 5 });
    expect(res.body).toEqual({
      places: [
        { id: '3128760', kind: 'city', name: 'Barcelona', countryCode: 'ES', region: 'Catalonia' },
        { id: '3336901', kind: 'region', name: 'Catalonia', countryCode: 'ES' },
      ],
    });
  });

  it('defaults the limit to 10', async () => {
    await request(app).get('/jobs/places/search').set('x-test-user', OUTSIDER_ID).query({ q: 'barc' });
    expect(placesClient.search).toHaveBeenCalledWith({ q: 'barc', countryCode: undefined, kind: undefined, limit: 10 });
  });

  it('rejects a missing query, an unknown country, an unknown kind and an oversized limit with field-level issues', async () => {
    const res = await request(app)
      .get('/jobs/places/search')
      .set('x-test-user', OUTSIDER_ID)
      .query({ countryCode: 'XK', kind: 'village', limit: '500' });

    expect(res.status).toBe(400);
    expect(res.body.issues.map((issue: { path: string }) => issue.path).sort()).toEqual(['countryCode', 'kind', 'limit', 'q']);
    expect(placesClient.search).not.toHaveBeenCalled();
  });

  it('answers 503 when Clarity cannot', async () => {
    placesClient.search.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const res = await request(app).get('/jobs/places/search').set('x-test-user', OUTSIDER_ID).query({ q: 'barc' });
    expect(res.status).toBe(503);
  });
});

describe('job locations are resolved, never trusted', () => {
  it('derives country, region and city from the Clarity place', async () => {
    const res = await createJob({ location: { placeId: BARCELONA.id } });

    expect(res.status).toBe(201);
    expect(res.body.job.location).toEqual({
      placeId: '3128760',
      countryCode: 'ES',
      region: 'Catalonia',
      city: 'Barcelona',
    });
    const row = await getJobById(res.body.job.id);
    expect(row).toMatchObject({
      locationPlaceId: '3128760',
      locationCountryCode: 'ES',
      locationRegion: 'Catalonia',
      locationCity: 'Barcelona',
    });
  });

  it('stores a region place as its own region, with no city', async () => {
    const res = await createJob({ location: { placeId: CATALONIA.id } });
    expect(res.status).toBe(201);
    expect(res.body.job.location).toEqual({ placeId: '3336901', countryCode: 'ES', region: 'Catalonia' });
  });

  it('accepts a country-only role without calling Clarity', async () => {
    const res = await createJob({ location: { countryCode: 'DE' }, workplaceType: 'remote' });
    expect(res.status).toBe(201);
    expect(res.body.job.location).toEqual({ countryCode: 'DE' });
    expect(placesClient.get).not.toHaveBeenCalled();
  });

  it('accepts a remote role with no location at all', async () => {
    const res = await createJob({ workplaceType: 'remote' });
    expect(res.status).toBe(201);
    expect(res.body.job.location).toBeUndefined();
  });

  it('rejects client-supplied city/region/raw text instead of ignoring it', async () => {
    const res = await createJob({ location: { placeId: BARCELONA.id, city: 'Gotham', raw: 'Gotham' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation error');
    expect(res.body.issues[0].path).toBe('location');
  });

  it('rejects both a place and a country, and neither', async () => {
    for (const location of [{ placeId: BARCELONA.id, countryCode: 'ES' }, {}]) {
      const res = await createJob({ location });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/exactly one of placeId/);
    }
  });

  it('rejects a country code outside COUNTRY_CODES, naming the field', async () => {
    for (const countryCode of ['Spain', 'es', 'XK']) {
      const res = await createJob({ location: { countryCode } });
      expect(res.status).toBe(400);
      expect(res.body.issues).toContainEqual({
        path: 'location.countryCode',
        message: 'location.countryCode must be an ISO 3166-1 alpha-2 country code (e.g. "ES")',
      });
    }
  });

  it('answers 400 on location.placeId for a place Clarity does not have, and writes nothing', async () => {
    const res = await createJob({ location: { placeId: '999999999' }, title: 'Nowhere Engineer' });
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual([{ path: 'location.placeId', message: expect.stringContaining('999999999') }]);
    const rows = await db.select().from(mentionJobs).where(eq(mentionJobs.employerOxyUserId, EMPLOYER_ID));
    expect(rows).toHaveLength(0);
  });

  it('answers 503, not a write of an unverified place, when Clarity is unreachable', async () => {
    placesClient.get.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const res = await createJob({ location: { placeId: BARCELONA.id } });
    expect(res.status).toBe(503);
  });

  it('never asks Clarity on behalf of a caller who cannot manage the employer', async () => {
    const res = await request(app)
      .post('/jobs')
      .set('x-test-user', OUTSIDER_ID)
      .send({
        employerOxyUserId: EMPLOYER_ID,
        title: 'Widget Engineer',
        description: 'Build widgets.',
        applicationMode: 'mention',
        location: { placeId: BARCELONA.id },
      });
    expect(res.status).toBe(403);
    expect(placesClient.get).not.toHaveBeenCalled();
  });

  it('PUT re-derives a new place, switches to a country, and clears with null', async () => {
    const created = await createJob({ location: { placeId: BARCELONA.id } });
    const id = created.body.job.id;

    const toRegion = await request(app).put(`/jobs/${id}`).set('x-test-user', OPERATOR_ID).send({ location: { placeId: CATALONIA.id } });
    expect(toRegion.status).toBe(200);
    expect(toRegion.body.job.location).toEqual({ placeId: '3336901', countryCode: 'ES', region: 'Catalonia' });

    const toCountry = await request(app).put(`/jobs/${id}`).set('x-test-user', OPERATOR_ID).send({ location: { countryCode: 'PT' } });
    expect(toCountry.body.job.location).toEqual({ countryCode: 'PT' });
    expect(await getJobById(id)).toMatchObject({ locationPlaceId: null, locationRegion: null, locationCity: null });

    const untouched = await request(app).put(`/jobs/${id}`).set('x-test-user', OPERATOR_ID).send({ title: 'Renamed' });
    expect(untouched.body.job.location).toEqual({ countryCode: 'PT' });

    const cleared = await request(app).put(`/jobs/${id}`).set('x-test-user', OPERATOR_ID).send({ location: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.job.location).toBeUndefined();
  });
});

describe('job salaries use closed vocabularies', () => {
  it('accepts an ISO 4217 currency and every Clarity interval, including week', async () => {
    const res = await createJob({ salary: { min: 900, max: 1200, currency: 'GBP', interval: 'week' } });
    expect(res.status).toBe(201);
    expect(res.body.job.salary).toEqual({ min: 900, max: 1200, currency: 'GBP', interval: 'week' });
  });

  it('rejects an unknown or lower-case currency, naming the field', async () => {
    for (const currency of ['Euros', 'eur', 'XAU', 'HRK']) {
      const res = await createJob({ salary: { min: 1, currency, interval: 'year' } });
      expect(res.status).toBe(400);
      expect(res.body.issues).toContainEqual({
        path: 'salary.currency',
        message: 'salary.currency must be an ISO 4217 currency code (e.g. "EUR")',
      });
    }
  });

  it('rejects an unknown interval, negative or fractional amounts, an inverted range and a salary with no amount', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ min: 1, currency: 'EUR', interval: 'fortnight' }, 'salary.interval'],
      [{ min: -1, currency: 'EUR', interval: 'year' }, 'salary.min'],
      [{ max: 10.5, currency: 'EUR', interval: 'year' }, 'salary.max'],
      [{ min: 10, max: 5, currency: 'EUR', interval: 'year' }, 'salary.max'],
      [{ currency: 'EUR', interval: 'year' }, 'salary.min'],
    ];
    for (const [salary, path] of cases) {
      const res = await createJob({ salary });
      expect(res.status, JSON.stringify(salary)).toBe(400);
      expect(res.body.issues.map((issue: { path: string }) => issue.path)).toContain(path);
    }
  });
});
