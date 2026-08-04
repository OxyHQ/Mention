/**
 * The protected-column guard.
 *
 * `publicColumns` cannot defend against not being called, so the scan below is
 * the actual gate: it walks `src/` for the two shapes that return every column
 * IMPLICITLY — a bare `select()` and the relational `db.query.<table>` API —
 * against any table in the registry, and fails naming the `file:line`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { actorKeyPairs } from '../../db/schema/federation';
import {
  ACTOR_KEY_PAIRS_PROTECTED_COLUMNS,
  PROTECTED_COLUMNS,
  PROTECTED_COLUMNS_BY_TABLE,
  publicColumns,
} from '../../db/schema/protectedColumns';

const SOURCE_ROOT = join(__dirname, '..', '..');

/** Every `.ts` file under `src/`, excluding the test tree itself. */
function sourceFiles(directory: string = SOURCE_ROOT): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

describe('the registry', () => {
  it('protects the ActivityPub signing key', () => {
    const properties = PROTECTED_COLUMNS_BY_TABLE.get('actor_key_pairs');
    expect(properties).toBeDefined();
    expect([...(properties ?? [])].sort()).toEqual([...ACTOR_KEY_PAIRS_PROTECTED_COLUMNS].sort());
  });

  it('gives every entry a reason', () => {
    const missing = PROTECTED_COLUMNS.filter((entry) => entry.reason.trim().length < 40).map(
      (entry) => entry.property
    );
    expect(missing).toEqual([]);
  });

  it('names only columns that exist', () => {
    const unknown: string[] = [];
    for (const entry of PROTECTED_COLUMNS) {
      if (!(entry.property in getTableColumns(entry.table))) {
        unknown.push(entry.property);
      }
    }
    // A stale entry protects nothing while looking like it does.
    expect(unknown).toEqual([]);
  });
});

describe('publicColumns', () => {
  it('omits every protected column at runtime', () => {
    const selection = publicColumns(actorKeyPairs);
    expect(Object.keys(selection)).not.toContain('privateKeyPem');
    // And keeps the rest, so the helper is usable rather than merely safe.
    expect(Object.keys(selection)).toContain('publicKeyPem');
    expect(Object.keys(selection)).toContain('keyId');
  });

  it('omits it at the TYPE level, which is the part a convention cannot give', () => {
    const selection = publicColumns(actorKeyPairs);
    // @ts-expect-error `privateKeyPem` is excluded from the returned type, so a
    // serializer that reads it fails `tsc` rather than shipping the key.
    void selection.privateKeyPem;
  });
});

describe('no implicit whole-row read of a protected table', () => {
  it('scans a non-trivial number of source files', () => {
    // Vacuity floor: a broken traversal would make the scan below pass while
    // reading nothing at all.
    expect(sourceFiles().length).toBeGreaterThan(200);
  });

  it('finds no bare `select()` or `db.query.<table>` against a protected table', () => {
    const tableNames = [...PROTECTED_COLUMNS_BY_TABLE.keys()];
    // `actor_key_pairs` in SQL, `actorKeyPairs` as the drizzle export.
    const propertyNames = tableNames.map((name) =>
      name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
    );

    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const location = `${relative(SOURCE_ROOT, file)}:${index + 1}`;
        // A bare `select()` returns EVERY column of whatever it is `.from(...)`.
        for (const property of propertyNames) {
          if (/\.select\(\s*\)/.test(line) && line.includes(property)) {
            offenders.push(`${location} — bare select() over ${property}: ${line.trim()}`);
          }
          if (new RegExp(`db\\.query\\.${property}\\b`).test(line)) {
            offenders.push(`${location} — relational query over ${property}: ${line.trim()}`);
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
