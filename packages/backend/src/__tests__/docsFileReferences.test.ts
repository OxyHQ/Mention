import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `AGENTS.md` used to be the one place in the repo where a wrong statement
 * survives indefinitely: package `files` excludes it, so no consumer ever
 * trips over a stale claim and forces a correction. `AGENTS.md` was cut down
 * to a short summary pointing at `docs/`, and the file-path claims moved WITH
 * the rules — so the same blind spot now lives in `docs/`, plus the doc
 * files under `packages`, all of which are just as excluded from any
 * build or lint. Nothing but a test that READS them will catch the decay.
 * Bloom's `src/__tests__/icon-references.test.ts` is the reference
 * implementation of this idea.
 *
 * This checks the one class of claim that is mechanically decidable without
 * guessing at prose: every file path a scanned document points at must
 * exist. When this was first run (against `AGENTS.md` alone) it found SEVEN
 * stale references, including `utils/ssrfGuard.ts` — a security helper that
 * had moved UPSTREAM into `@oxyhq/core/server`, so the document was telling
 * every agent to look for a local copy of something the ecosystem rule says
 * must not be local.
 *
 * Deliberately NOT checked:
 *  - restated constants (`FOO = 4`). There are none left, because the fix for
 *    that class is to stop restating values and point at the constant instead —
 *    machinery for a failure that cannot currently occur reads as load-bearing
 *    to whoever touches it next.
 *  - prose. A sentence's truth is not decidable here, and a gate that guesses
 *    gets disabled by the first person it blocks wrongly.
 *  - `docs/handoff/` and `docs/superpowers/`. Both are explicitly historical
 *    working notes (`docs/README.md` says so), never mirrored into
 *    `AGENTS.md`, and were never in this gate's scope even before the cut —
 *    including them would fold pre-existing, unrelated staleness into a gate
 *    whose job is the CURRENT reference surface.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * Every document a rule from `AGENTS.md` can land in, enumerated by
 * directory rather than hardcoded by name — a new doc file added under one
 * of these directories is scanned automatically, the same self-maintaining
 * shape as `packages/frontend/scripts/coverage-policy.mjs`'s domain globs.
 * A hardcoded list rots the day someone adds `docs/whatever.md` and nobody
 * remembers to extend it.
 */
const DOC_SOURCES: ReadonlyArray<{ dir: string; pattern: RegExp }> = [
  { dir: '.', pattern: /^AGENTS\.md$/ },
  { dir: 'docs', pattern: /\.(?:md|mdx)$/ },
  { dir: 'packages/mcp', pattern: /^README\.md$/ },
  { dir: 'packages/frontend/docs', pattern: /\.md$/ },
];

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const { dir, pattern } of DOC_SOURCES) {
    const dirPath = resolve(REPO_ROOT, dir);
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isFile() && pattern.test(entry.name)) {
        files.push(dir === '.' ? entry.name : `${dir}/${entry.name}`);
      }
    }
  }
  return files.sort();
}

/**
 * References that intentionally resolve to nothing, each with the reason. A path
 * listed here that STARTS resolving is a failure too: the entry has become a lie
 * in the other direction, and the list must only ever shrink.
 */
const UNRESOLVABLE_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  ['__common.js', "Metro's generated shared chunk — an output artifact, never a repo file"],
  ['X.web.tsx', "packages/frontend/docs/TESTING-POLICY.md's illustrative example name for a `.web` fork, not a real file"],
]);

/**
 * A path-shaped reference is a backticked token with a source-file extension.
 * Extensions only — a bare `foo/bar` is as likely to be a URL path, an ECS
 * cluster or a Mongo field as a file. A LEADING SLASH is excluded too: this
 * codebase never writes a file path that way (always relative — `utils/foo.ts`,
 * never `/utils/foo.ts`), so a backticked `/well-known/route.json` in an
 * endpoint table is an HTTP route, not a file, even though it ends in a
 * recognised extension.
 */
const PATH_REFERENCE = /`(?!\/)([a-zA-Z0-9_./-]+\.(?:ts|tsx|mjs|js|json|md|yml))`/g;

/** Every tracked file, from git rather than a walk, so ignored output cannot satisfy a reference. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * References are written relative to whatever root the surrounding section is
 * about (`utils/mediaResolver.ts`, `packages/backend/Dockerfile`,
 * `app/(app)/videos.tsx`), so a reference resolves when some tracked file's path
 * ENDS with it on a segment boundary — the same thing a reader does.
 */
function resolvesAgainst(reference: string, files: readonly string[]): boolean {
  return files.some((file) => file === reference || file.endsWith(`/${reference}`));
}

function pathReferences(markdown: string): string[] {
  return [...new Set(Array.from(markdown.matchAll(PATH_REFERENCE), (match) => match[1]))].sort();
}

interface SourcedReference {
  readonly sourceFile: string;
  readonly reference: string;
}

describe('documentation file references (AGENTS.md + docs/)', () => {
  const sourceFiles = scannedFiles();
  const sourcedReferences: SourcedReference[] = sourceFiles.flatMap((sourceFile) => {
    const markdown = readFileSync(resolve(REPO_ROOT, sourceFile), 'utf8');
    return pathReferences(markdown).map((reference) => ({ sourceFile, reference }));
  });
  const allReferencedPaths = [...new Set(sourcedReferences.map((entry) => entry.reference))];
  const files = trackedFiles();

  it('scans a plausible number of documents, references and tracked files', () => {
    // A vacuity floor. Without it a broken glob, a broken regex, or a
    // `git ls-files` that returned nothing would make every assertion below
    // pass by checking nothing at all — the exact failure mode these tests
    // exist to prevent elsewhere. Measured on 2026-08-25: 25 source files,
    // 155 (file, reference) pairs, 136 distinct referenced paths. The floors
    // below sit comfortably under those counts, not against them, so normal
    // doc editing does not make this flaky.
    expect(sourceFiles.length).toBeGreaterThan(15);
    expect(sourcedReferences.length).toBeGreaterThan(100);
    expect(files.length).toBeGreaterThan(500);
  });

  it('points only at files that exist', () => {
    const stale = sourcedReferences
      .filter((entry) => !UNRESOLVABLE_BY_DESIGN.has(entry.reference))
      .filter((entry) => !resolvesAgainst(entry.reference, files));

    expect(
      stale,
      'A doc references a file that does not exist:\n'
        + `${stale.map((entry) => `  ${entry.sourceFile}: ${entry.reference}`).join('\n')}\n`
        + 'Fix the path, or — if it is deliberately unresolvable (a generated artifact, or history) — '
        + 'add it to UNRESOLVABLE_BY_DESIGN with the reason.',
    ).toEqual([]);
  });

  it('keeps the by-design exemptions honest, so the list can only shrink', () => {
    const nowResolving = [...UNRESOLVABLE_BY_DESIGN.keys()].filter((reference) => resolvesAgainst(reference, files));

    expect(nowResolving, 'these are listed in UNRESOLVABLE_BY_DESIGN but now resolve — '
      + `delete the entry:\n  ${nowResolving.join('\n  ')}\n`).toEqual([]);
  });

  it('drops an exemption once no scanned document makes the reference anymore', () => {
    // The OTHER way an exemption rots, and the one the check above cannot see:
    // every document that named the path stops naming it. The entry then
    // exempts nothing, and because an unmade reference can never resolve, it
    // sits there passing forever while reading as a live decision about a
    // real reference.
    //
    // This is not hypothetical. Two changes landed within minutes of each other
    // for one cross-repo path — `packages/api/src/routes/privacy.ts`, which lives
    // in OxyHQServices — one adding the exemption and one rewriting the sentence
    // so the path was no longer written as a reference. The exemption survived as
    // dead weight, and nothing failed.
    const unreferenced = [...UNRESOLVABLE_BY_DESIGN.keys()]
      .filter((reference) => !allReferencedPaths.includes(reference))
      .sort();

    expect(
      unreferenced,
      'these are listed in UNRESOLVABLE_BY_DESIGN but no scanned document references them anymore, so the '
        + `entry exempts nothing — delete it:\n  ${unreferenced.join('\n  ')}\n`,
    ).toEqual([]);
  });
});
