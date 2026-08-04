import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE FILE OWNS AN ID LITERAL.
 *
 * Vitest runs test FILES in parallel against a single Postgres database, so a
 * hardcoded fixture id is not local to the file that writes it — it is a claim
 * about every other file in the run. Four collisions of that shape were found in
 * one day, in three different forms:
 *
 *  - two files inserting the same `posts.id` → whichever ran second died on the
 *    primary key, or the row was already there with another file's data;
 *  - two files seeding different federated actors under one `oxy_user_id` → the
 *    lookup answered with whichever row it reached first;
 *  - one file asserting an id did NOT exist while another SEEDS it.
 *
 * Every one passed in isolation and failed in a full run, which is the flake
 * that gets rerun until green rather than read. This is the gate, because a
 * convention nothing checks WILL be violated again — the last four were written
 * by people who knew the rule.
 *
 * It checks the narrow, mechanical half: an id-shaped literal written as an
 * `id:` FIELD belongs to exactly one file. It cannot see an id built at runtime,
 * one passed positionally, or a collision between two different tables that
 * happen to share a literal harmlessly — so a green run here is not proof of
 * isolation, only the absence of the cheapest way to lose it.
 */

const TESTS_ROOT = path.resolve(__dirname);

/** 24-char ObjectId hex (pre-cutover) or a uuid (post-cutover). Both are live id shapes. */
const ID_SHAPE = '(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const ID_FIELD = new RegExp(`\\bid:\\s*['"\`](${ID_SHAPE})['"\`]`, 'g');

/**
 * Which files write each id literal as an `id:` field.
 *
 * Lines carrying `expect(` are skipped: an id inside an assertion is being READ
 * back, not written, and two files may legitimately expect the same value from
 * different subjects. Taking the whole file instead reported
 * `apexFrontendProxy.integration.test.ts` — which asserts a proxied response
 * body and inserts nothing — as colliding with a moderation fixture. A gate that
 * cries wolf gets disabled by whoever hits it first.
 */
export function mapIdOwners(files: { name: string; content: string }[]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const file of files) {
    for (const line of file.content.split('\n')) {
      if (line.includes('expect(')) continue;
      for (const match of line.matchAll(ID_FIELD)) {
        const existing = owners.get(match[1]);
        if (existing) existing.add(file.name);
        else owners.set(match[1], new Set([file.name]));
      }
    }
  }
  return owners;
}

function readTestFiles(dir: string): { name: string; content: string }[] {
  const out: { name: string; content: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...readTestFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    out.push({ name: path.relative(TESTS_ROOT, full), content: readFileSync(full, 'utf8') });
  }
  return out;
}

describe('fixture id ownership', () => {
  const files = readTestFiles(TESTS_ROOT);
  const owners = mapIdOwners(files);

  it('finds enough to be checking something', () => {
    // The vacuity floor. A broken traversal or a regex that stops matching would
    // otherwise report ZERO collisions and read exactly like a clean tree.
    expect(files.length).toBeGreaterThan(200);
    expect(owners.size).toBeGreaterThan(10);
  });

  it('reports the collision when two files write one id, and stays quiet otherwise', () => {
    // Directional, on synthetic input, so the check is exercised in BOTH states
    // regardless of what the real tree currently holds.
    const shared = '650000000000000000000abc';
    const collide = mapIdOwners([
      { name: 'a.test.ts', content: `seed({ id: '${shared}' })` },
      { name: 'b.test.ts', content: `seed({ id: '${shared}' })` },
    ]);
    expect(collide.get(shared)).toEqual(new Set(['a.test.ts', 'b.test.ts']));

    const distinct = mapIdOwners([
      { name: 'a.test.ts', content: `seed({ id: '${shared}' })` },
      { name: 'b.test.ts', content: `seed({ id: '650000000000000000000abd' })` },
    ]);
    expect([...distinct.values()].every((set) => set.size === 1)).toBe(true);

    // An id being READ back is not a write, and two files may expect the same one.
    const asserted = mapIdOwners([
      { name: 'a.test.ts', content: `expect(res.body).toEqual({ id: '${shared}' })` },
      { name: 'b.test.ts', content: `expect(row).toMatchObject({ id: '${shared}' })` },
    ]);
    expect(asserted.size).toBe(0);
  });

  it('no id literal is written by more than one test file', () => {
    const shared = [...owners.entries()]
      .filter(([, names]) => names.size > 1)
      .map(([id, names]) => `${id} written by ${[...names].sort().join(', ')}`);

    // The message names the offending files, because the fix is to give one of
    // them its own value and the failure is otherwise a bare boolean.
    expect(shared).toEqual([]);
  });
});
