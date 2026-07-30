import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `AGENTS.md` is the one place in the repo where a wrong statement survives
 * indefinitely: package `files` excludes it, so no consumer ever trips over a
 * stale claim and forces a correction. Nothing but a test that READS it will
 * catch the decay. Bloom's `src/__tests__/icon-references.test.ts` is the
 * reference implementation of this idea.
 *
 * This checks the one class of claim that is mechanically decidable without
 * guessing at prose: every file path the document points at must exist. When
 * this was first run it found SEVEN stale references, including
 * `utils/ssrfGuard.ts` — a security helper that had moved UPSTREAM into
 * `@oxyhq/core/server`, so the document was telling every agent to look for a
 * local copy of something the ecosystem rule says must not be local.
 *
 * Deliberately NOT checked:
 *  - restated constants (`FOO = 4`). There are none left, because the fix for
 *    that class is to stop restating values and point at the constant instead —
 *    machinery for a failure that cannot currently occur reads as load-bearing
 *    to whoever touches it next.
 *  - prose. A sentence's truth is not decidable here, and a gate that guesses
 *    gets disabled by the first person it blocks wrongly.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const AGENTS_MD = resolve(REPO_ROOT, 'AGENTS.md');

/**
 * References that intentionally resolve to nothing, each with the reason. A path
 * listed here that STARTS resolving is a failure too: the entry has become a lie
 * in the other direction, and the list must only ever shrink.
 */
const UNRESOLVABLE_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  ['__common.js', "Metro's generated shared chunk — an output artifact, never a repo file"],
  ['_worker.js', 'the deleted Cloudflare Pages Advanced-Mode worker; cited as history, must not come back'],
  ['_routes.json', 'deleted alongside that worker; cited as history'],
  ['services/FederationService.ts', 'the removed facade the connectors module replaced; cited as history'],
]);

/**
 * A path-shaped reference is a backticked token with a source-file extension.
 * Extensions only — a bare `foo/bar` is as likely to be a URL path, an ECS
 * cluster or a Mongo field as a file.
 */
const PATH_REFERENCE = /`([a-zA-Z0-9_./-]+\.(?:ts|tsx|mjs|js|json|md|yml))`/g;

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

describe('AGENTS.md file references', () => {
  const markdown = readFileSync(AGENTS_MD, 'utf8');
  const references = pathReferences(markdown);
  const files = trackedFiles();

  it('scans a plausible number of references and files', () => {
    // A vacuity floor. Without it a broken regex or a `git ls-files` that returned
    // nothing would make every assertion below pass by checking nothing at all —
    // the exact failure mode these tests exist to prevent elsewhere.
    expect(references.length).toBeGreaterThan(60);
    expect(files.length).toBeGreaterThan(500);
  });

  it('points only at files that exist', () => {
    const stale = references
      .filter((reference) => !UNRESOLVABLE_BY_DESIGN.has(reference))
      .filter((reference) => !resolvesAgainst(reference, files));

    expect(stale, `AGENTS.md references files that do not exist:\n  ${stale.join('\n  ')}\n`
      + 'Fix the path, or — if it is deliberately unresolvable (a generated artifact, or history) — '
      + 'add it to UNRESOLVABLE_BY_DESIGN with the reason.').toEqual([]);
  });

  it('keeps the by-design exemptions honest, so the list can only shrink', () => {
    const nowResolving = [...UNRESOLVABLE_BY_DESIGN.keys()].filter((reference) => resolvesAgainst(reference, files));

    expect(nowResolving, 'these are listed in UNRESOLVABLE_BY_DESIGN but now resolve — '
      + `delete the entry:\n  ${nowResolving.join('\n  ')}\n`).toEqual([]);
  });
});
