import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_IDS } from '../../migrations/runner';
import type { Migration } from '../../migrations/runner';

/**
 * Every migration on disk is registered with the runner, in order.
 *
 * Forgetting the registration is silent by construction: nothing imports the
 * file, nothing runs it, and no test anywhere fails. In production —
 * `autoIndex`/`autoCreate` are OFF — the index it was supposed to create simply
 * never exists, while every query keeps working, more slowly or without the
 * constraint it was meant to enforce. That is exactly the shape of bug that gets
 * found months later by the incident it causes.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/** `NNNN-slug.ts`; `constants.ts`, `runner.ts` and `task.ts` are not migrations. */
const MIGRATION_FILE = /^(\d{4}-[a-z0-9-]+)\.ts$/;

/**
 * Migrations present when this guard was written. A traversal that silently
 * stopped matching would otherwise "pass" against an empty set, which is the
 * failure mode a filesystem-scanning test is most prone to.
 */
const VACUITY_FLOOR = 16;

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .map((entry) => MIGRATION_FILE.exec(entry))
  .filter((match): match is RegExpExecArray => match !== null)
  .map((match) => ({ file: match[0], id: match[1] }))
  .sort((a, b) => a.id.localeCompare(b.id));

describe('migration registration', () => {
  it('finds the migration files at all', () => {
    expect(migrationFiles.length).toBeGreaterThanOrEqual(VACUITY_FLOOR);
  });

  it('registers every migration on disk, in numeric order', () => {
    // Set equality BOTH ways plus order, in one assertion: an unregistered file,
    // a registered id with no file, and a list out of sequence all fail here.
    expect(MIGRATION_IDS).toEqual(migrationFiles.map((migration) => migration.id));
  });

  it('gives each migration the id its filename promises', async () => {
    // The runner records applied work under the id, so an id that disagrees with
    // its filename would re-run (or skip) under a name nobody can trace back.
    for (const { file, id } of migrationFiles) {
      // The extension stays in the STATIC part of the specifier — Vite cannot
      // resolve a fully dynamic one and warns rather than failing.
      const module: Record<string, unknown> = await import(`../../migrations/${id}.ts`);
      const exported = Object.values(module).find(
        (value): value is Migration =>
          typeof value === 'object'
          && value !== null
          && typeof (value as Migration).id === 'string'
          && typeof (value as Migration).run === 'function',
      );
      expect(exported, `${file} exports no Migration`).toBeDefined();
      expect(exported?.id, `${file} declares a mismatched id`).toBe(id);
    }
  });
});
