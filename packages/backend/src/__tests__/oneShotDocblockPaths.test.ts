/**
 * An ECS invocation written in a comment must name a path the IMAGE actually has.
 *
 * The image ships compiled output only — `tsconfig.json` is `rootDir: ./`,
 * `outDir: dist` — so `packages/backend/scripts/x.ts` exists at
 * `packages/backend/dist/scripts/x.js` and nowhere else. A docblock showing
 * `bun run …/scripts/x.ts` inside an `ecs run-task` therefore describes a
 * command that cannot start, in the one environment its own prose declares.
 *
 * ## Why this is worth a test rather than a careful reading
 *
 * It is the failure mode with no natural discovery path. A wrong example does
 * not break a build, does not fail a type-check, and nobody reading it trips
 * over it — it is only ever found by pasting it into a terminal, which is to say
 * during an incident, by whoever is least able to afford the detour. It had
 * already survived long enough to be copied into a live restore command.
 *
 * ## The signal is the override array, not the prose
 *
 * Matching on words like "Fargate" would be a guess about English. An ECS
 * `containerOverrides` block is unambiguous: it names a command run INSIDE the
 * image, so every repo-relative path in it must be a built artefact. Prose that
 * documents a LOCAL invocation is untouched by this and should be — the
 * `pruneGoneFederatedActors` docblock deliberately shows both, the Fargate one
 * on `dist/….js` and the SSM-tunnel one on `src/….ts`, and both are right.
 *
 * The expected path is DERIVED from the source file's real location rather than
 * pattern-matched, so a script that moves between `scripts/` and `src/scripts/`
 * is caught too — those map to different places under `dist/`, and the deploy
 * script already invokes both forms.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BACKEND_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '../..');

/**
 * Files that must be scanned, so an emptied traversal cannot pass. This is the
 * one carrying the ECS example; if it stops matching, the walk is broken rather
 * than the repo clean.
 */
const REQUIRED_SCANNED = ['packages/backend/scripts/backfill-mongo-to-postgres.ts'];

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') || full.endsWith('.md') || full.endsWith('.sh')) out.push(full);
  }
  return out;
}

/** Where the built artefact for a repo-relative source path lives. */
function builtPathFor(sourceRelative: string): string {
  // `packages/backend/<rest>.ts` -> `packages/backend/dist/<rest>.js`, because
  // `rootDir` is the package root and `outDir` is `dist`.
  const rest = sourceRelative.replace(/^packages\/backend\//, '');
  return `packages/backend/dist/${rest.replace(/\.ts$/, '.js')}`;
}

interface Offence {
  readonly file: string;
  readonly cited: string;
  readonly shouldBe: string;
}

/** Repo-relative `packages/backend/…` paths cited inside an ECS override block. */
function offencesIn(file: string): Offence[] {
  const text = readFileSync(file, 'utf8');
  const offences: Offence[] = [];

  // Each `containerOverrides` occurrence, up to the end of its command array.
  const blocks = [...text.matchAll(/containerOverrides[\s\S]{0,600}?\]\}\]\}/g)];
  for (const block of blocks) {
    for (const cite of block[0].matchAll(/["']([^"']*packages\/backend\/[^"']+)["']/g)) {
      const cited = cite[1];
      if (!cited.endsWith('.ts')) continue;
      offences.push({
        file: path.relative(REPO_ROOT, file),
        cited,
        shouldBe: builtPathFor(cited),
      });
    }
  }
  return offences;
}


/** Every `dist/….js` path cited in a comment, with the source file it implies. */
function citedDistPaths(): Array<{ file: string; line: number; cited: string; implied: string }> {
  const found: Array<{ file: string; line: number; cited: string; implied: string }> = [];
  for (const file of walk(BACKEND_ROOT)) {
    if (!file.endsWith('.ts')) continue;
    // Tests are not operator documentation, and THIS file necessarily spells the
    // broken shape out to explain it — a gate that reads its own examples as
    // offences reports itself and nothing else.
    if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      // Only this package's OWN build output. `rootDir` is the package root, so
      // every real citation is `dist/src/…` or `dist/scripts/…`; a dependency's
      // internal `dist/cjs/node/index.js` is not ours to validate.
      for (const match of text.matchAll(/dist\/(?:src|scripts)\/[A-Za-z0-9/_.-]+\.js/g)) {
        found.push({
          file: path.relative(REPO_ROOT, file),
          line: index + 1,
          cited: match[0],
          implied: `${match[0].slice('dist/'.length, -'.js'.length)}.ts`,
        });
      }
    });
  }
  return found;
}

describe('ECS invocations written in comments name built paths', () => {
  const files = walk(BACKEND_ROOT).concat(
    [path.join(REPO_ROOT, '.github')].flatMap((d) => {
      try {
        return walk(d);
      } catch {
        return [];
      }
    })
  );

  /** The floor, first: a walk that finds nothing must fail rather than pass. */
  it('scans the files that carry an ECS example', () => {
    const relative = new Set(files.map((f) => path.relative(REPO_ROOT, f)));
    for (const required of REQUIRED_SCANNED) {
      expect(relative.has(required), `${required} was not scanned — the walk is broken`).toBe(true);
    }
    expect(files.length).toBeGreaterThan(200);
  });

  /**
   * THE case. Reported as `cited -> shouldBe`, because "a path is wrong" sends
   * somebody reading, and the corrected path sends them editing.
   *
   * Mutation: restore `…/scripts/backfill-mongo-to-postgres.ts` to that
   * docblock's override array and this goes red naming it and its `dist`
   * replacement — verified.
   */
  it('cites no source path inside a containerOverrides command', () => {
    const offences = files.flatMap(offencesIn);
    expect(
      offences.map((o) => `${o.file}: ${o.cited} -> ${o.shouldBe}`),
    ).toEqual([]);
  });
});

/**
 * A `dist/…​.js` path cited anywhere must correspond to a source file that exists.
 *
 * Separate from the check above, and deliberately so. That one keys on
 * `containerOverrides` — an ECS override array, which unambiguously means "run
 * inside the image". Most one-shot documentation is not an override array at
 * all; it is a bare shell line, and stretching the override signal to cover
 * those would make it guess. This check needs no signal about intent: a cited
 * BUILT path either names a real source file or it does not.
 *
 * `rootDir` is the package root and `outDir` is `dist`, so `dist/X.js` implies
 * `X.ts`. `src/scripts/foo.ts` builds to `dist/src/scripts/foo.js`, and
 * `scripts/foo.ts` to `dist/scripts/foo.js` — the deploy invokes both forms, so
 * the two are not interchangeable and the difference is invisible by eye.
 *
 * Nine citations across five files were wrong when this was written, all the
 * same way: `dist/scripts/…` for a script living in `src/scripts/`. One of them
 * was in the script the cutover was about to run.
 *
 * Deriving the expectation from the FILE SYSTEM rather than a pattern is what
 * makes it exact: matching on basename alone gets this wrong, because
 * `migrate.ts` exists in BOTH `scripts/` and `src/db/` and the two build to
 * different places. That mistake produced three false positives on the first
 * pass of this very sweep.
 */
describe('cited dist paths name a source file that exists', () => {
  const cited = citedDistPaths();

  it('finds the citations to check', () => {
    // A floor: this repo documents dozens of one-shots. Zero would mean the
    // sweep broke, not that the docs are clean.
    expect(cited.length).toBeGreaterThan(40);
  });

  it('every cited dist path implies a real source file', () => {
    const broken = cited
      .filter((entry) => !existsSync(path.join(BACKEND_ROOT, entry.implied)))
      .map((entry) => `${entry.file}:${entry.line}: ${entry.cited} implies ${entry.implied}, which does not exist`);
    expect(broken).toEqual([]);
  });
});
