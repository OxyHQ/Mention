/**
 * `0041_job_structured_location` rewrites free-text job locations and salary
 * currencies into closed values. The test database this suite runs against was
 * migrated with no job rows in it, so the data half of that migration has never
 * touched a row there — asserting the end state would prove nothing about it.
 *
 * So this file replays the migration against LEGACY rows: inside a transaction
 * that is always rolled back, it creates a private schema, builds `mention_jobs`
 * from the real `CREATE TABLE` statement `0040` shipped (not a hand-written
 * approximation of it), inserts rows the old API accepted, runs every statement
 * of the real `0041` file, and reads what survived. Nothing reaches `public`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { MIGRATIONS_FOLDER } from '../../db/migrationsFolder';

const LEGACY_TAG = '0040_fresh_daimon_hellstrom';
const MIGRATION_TAG = '0041_job_structured_location';
const PROBE_SCHEMA = 'job_location_migration_probe';

function statements(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function legacyJobsTable(): string {
  const create = statements(LEGACY_TAG).find((statement) => statement.startsWith('CREATE TABLE "mention_jobs"'));
  if (!create) throw new Error(`${LEGACY_TAG} no longer creates mention_jobs`);
  return create;
}

interface LegacyRow {
  id: string;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  raw?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string | null;
  interval?: string | null;
}

interface MigratedRow {
  id: string;
  location_place_id: string | null;
  location_country_code: string | null;
  location_region: string | null;
  location_city: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_interval: string | null;
}

const LEGACY_ROWS: LegacyRow[] = [
  { id: 'valid-country', country: 'ES', region: 'Catalonia', city: 'Barcelona', raw: 'Barcelona, Spain' },
  { id: 'lowercase-country', country: ' es ', raw: 'Spain' },
  { id: 'country-name', country: 'Spain', city: 'Madrid', raw: 'Madrid' },
  { id: 'kosovo', country: 'XK', raw: 'Pristina' },
  { id: 'raw-only', raw: 'Remote, anywhere' },
  { id: 'salary-valid', salaryMin: 40000, salaryMax: 55000, currency: 'eur', interval: 'year' },
  { id: 'salary-unknown-currency', salaryMin: 100, currency: 'Euros', interval: 'month' },
  { id: 'salary-withdrawn-currency', salaryMin: 100, currency: 'HRK', interval: 'month' },
  { id: 'salary-no-amount', currency: 'USD', interval: 'hour' },
  { id: 'salary-negative', salaryMin: -5, salaryMax: 10, currency: 'USD', interval: 'hour' },
];

let db: Database;
let migrated: Map<string, MigratedRow>;
let columns: string[];

class Rollback extends Error {}

beforeAll(async () => {
  db = await connectPostgres();
  migrated = new Map();
  await db
    .transaction(async (tx) => {
      await tx.execute(sql.raw(`create schema ${PROBE_SCHEMA}`));
      await tx.execute(sql.raw(`set local search_path to ${PROBE_SCHEMA}`));
      await tx.execute(sql.raw(legacyJobsTable()));
      for (const row of LEGACY_ROWS) {
        await tx.execute(sql`
          insert into mention_jobs (
            id, employer_oxy_user_id, author_oxy_user_id, title, description, slug, application_mode,
            location_raw, location_country_code, location_region, location_city,
            salary_min, salary_max, salary_currency, salary_interval
          ) values (
            ${row.id}, 'employer', 'author', 'Title', 'Description', ${row.id}, 'mention',
            ${row.raw ?? null}, ${row.country ?? null}, ${row.region ?? null}, ${row.city ?? null},
            ${row.salaryMin ?? null}, ${row.salaryMax ?? null}, ${row.currency ?? null}, ${row.interval ?? null}
          )
        `);
      }
      for (const statement of statements(MIGRATION_TAG)) {
        await tx.execute(sql.raw(statement));
      }
      const rows = await tx.execute<MigratedRow>(sql`
        select id, location_place_id, location_country_code, location_region, location_city,
               salary_min, salary_max, salary_currency, salary_interval
        from mention_jobs
      `);
      for (const row of rows) migrated.set(row.id, row);
      const columnRows = await tx.execute<{ column_name: string }>(sql`
        select column_name from information_schema.columns
        where table_schema = ${PROBE_SCHEMA} and table_name = 'mention_jobs'
      `);
      columns = [...columnRows].map((column) => column.column_name);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
});

afterAll(async () => {
  await closePostgres();
});

function row(id: string): MigratedRow {
  const found = migrated.get(id);
  if (!found) throw new Error(`Row ${id} did not survive the migration replay`);
  return found;
}

describe('0041_job_structured_location on legacy rows', () => {
  it('replayed every legacy row — the instrument read something', () => {
    expect(migrated.size).toBe(LEGACY_ROWS.length);
  });

  it('keeps a valid ISO country code and drops the unresolved region and city', () => {
    expect(row('valid-country')).toMatchObject({
      location_place_id: null,
      location_country_code: 'ES',
      location_region: null,
      location_city: null,
    });
  });

  it('normalizes a valid code written in lower case with whitespace', () => {
    expect(row('lowercase-country').location_country_code).toBe('ES');
  });

  it('clears a country that is not an ISO 3166-1 alpha-2 code, including user-assigned XK', () => {
    expect(row('country-name')).toMatchObject({ location_country_code: null, location_city: null });
    expect(row('kosovo').location_country_code).toBe(null);
  });

  it('leaves a free-text-only location with no location at all', () => {
    expect(row('raw-only')).toMatchObject({ location_country_code: null, location_region: null, location_city: null });
  });

  it('drops location_raw and adds location_place_id', () => {
    expect(columns).toContain('location_country_code');
    expect(columns).toContain('location_place_id');
    expect(columns).not.toContain('location_raw');
  });

  it('keeps a valid salary, upper-casing its currency', () => {
    expect(row('salary-valid')).toMatchObject({
      salary_min: 40000,
      salary_max: 55000,
      salary_currency: 'EUR',
      salary_interval: 'year',
    });
  });

  it('clears the whole salary when the currency is unknown or withdrawn, no amount is stated, or an amount is negative', () => {
    for (const id of ['salary-unknown-currency', 'salary-withdrawn-currency', 'salary-no-amount', 'salary-negative']) {
      expect(row(id), id).toMatchObject({
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        salary_interval: null,
      });
    }
  });
});
