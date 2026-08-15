/**
 * No raw `sql` template may be annotated with `Date`, anywhere in
 * `packages/backend/src`.
 *
 * Such an annotation is a TYPE ASSERTION over a raw expression, never a
 * conversion. `drizzle-orm/postgres-js` installs a transparent parser for every
 * timestamp OID so that DRIZZLE owns the conversion, and drizzle then applies it
 * per DECLARED COLUMN — a raw `sql` expression has no column behind it, so the
 * value arrives as the driver's string (`'2026-08-15 17:01:48.833+00'`) while
 * `tsc` believes it is a `Date`. Measured against a real server before this gate
 * was written: `typeof` `string`, `instanceof Date` false, `.getTime` undefined.
 *
 * The trap is that the natural thing to write against the DECLARED type —
 * `row.lastPostAt.toISOString()` — is a 500 with nothing anywhere to warn you.
 * It happened once already, in `routes/channelWriters.routes.ts`, whose comment
 * is the precedent this rule generalizes: `.mapWith(<column>)` borrows the
 * column's own decoder, so the type is DERIVED from what runs rather than
 * asserted over it.
 *
 * ## Why the rule is total rather than scoped to SELECT lists
 *
 * One site was write-only (`postRepository`'s `postCreatedAtSql`, an
 * `INSERT ... (select ...)` whose value never comes back), where the annotation
 * was harmless. Exempting it would mean a check that must classify each
 * occurrence by POSITION — and a rule with a judgement call in it is a rule that
 * grows an exemption list, one defensible entry at a time, until it cannot fail.
 * A bare `SQL` costs that call site nothing, so the rule is "never" and there is
 * no list.
 *
 * ## Why the scan strips comments, which is normally the wrong thing to do
 *
 * The first version of this gate did NOT, and went red on three occurrences that
 * were all PROSE — including the `channelWriters` comment that is the best
 * explanation of this trap in the repository, and the two written by the change
 * that added this file. A census over source normally must exclude nothing,
 * because a comment quoting a call verbatim is how a count gets inflated; here
 * the inflation is the whole population, and the cheapest way to green a
 * prose-sensitive gate is to delete the prose that explains the rule. A gate
 * whose cheapest green destroys documentation is the wrong gate.
 *
 * So: comments are stripped, and the two ways THAT can go wrong are both
 * controlled below — a code occurrence must still be FOUND (positive control),
 * and a commented one must be ignored while the scan can still see the file
 * (negative control with its own floor).
 */

import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE_ROOT = join(__dirname, '..', '..');

/**
 * The forbidden sequence, assembled from two halves so that this file does not
 * match itself and need an exemption.
 *
 * The trailing backtick is part of it: `sql` is a template TAG, so the tagged
 * template is the only shape that can construct one, and requiring the backtick
 * costs nothing while narrowing the match to real code.
 */
const PATTERN_SOURCE = 'sql<' + 'Date>' + '`';

/**
 * A scan that read nothing reports the same clean ZERO as a scan that read
 * everything and found nothing, so the file count carries a floor. 400 is well
 * under the number of TypeScript files in `src` and well over anything a broken
 * walk would return.
 */
const MIN_SCANNED_FILES = 400;

/**
 * The file both controls inject into. Named explicitly rather than found by
 * search: a control that PICKS its own subject can keep passing for the wrong
 * reason once that subject moves. This one is retired when
 * `db/posts/postRepository.ts` is.
 */
const CONTROL_FILE = join('db', 'posts', 'postRepository.ts');

async function typescriptFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await typescriptFiles(path)));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

/**
 * Blank out `//` and block comments, preserving line structure so reported line
 * numbers stay true.
 *
 * Deliberately NOT a TypeScript parser. The one thing a naive stripper can get
 * wrong in the permissive direction is a `//` inside a string literal earlier on
 * the same line as a real tagged template, which would hide it — a line that
 * would have to read `f('http://x'); const q = <tag>...` to occur at all. The
 * positive control is what stands behind that judgement; if this ever needs to
 * be smarter, make it a parser rather than adding cases.
 */
function stripComments(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;

  for (const line of source.split('\n')) {
    let result = '';
    let index = 0;
    while (index < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', index);
        if (end === -1) { index = line.length; break; }
        inBlock = false;
        index = end + 2;
        continue;
      }
      const block = line.indexOf('/*', index);
      const lineComment = line.indexOf('//', index);
      if (lineComment !== -1 && (block === -1 || lineComment < block)) {
        result += line.slice(index, lineComment);
        index = line.length;
        break;
      }
      if (block !== -1) {
        result += line.slice(index, block);
        inBlock = true;
        index = block + 2;
        continue;
      }
      result += line.slice(index);
      index = line.length;
    }
    out.push(result);
  }
  return out;
}

/**
 * Every `file:line` carrying the annotation in CODE.
 *
 * `inject` replaces one file's content IN MEMORY, which is how both controls
 * exercise this exact reader, this exact stripper and this exact matcher rather
 * than a re-implementation of them beside it.
 */
async function findOccurrences(
  files: readonly string[],
  inject?: { file: string; content: string },
): Promise<string[]> {
  const hits: string[] = [];
  for (const file of files) {
    const content = inject && file === inject.file ? inject.content : await readFile(file, 'utf8');
    for (const [index, line] of stripComments(content).entries()) {
      if (line.includes(PATTERN_SOURCE)) {
        hits.push(`${file.slice(SOURCE_ROOT.length + 1)}:${index + 1}`);
      }
    }
  }
  return hits;
}

describe('a raw sql template annotated as a date', () => {
  it('appears nowhere in packages/backend/src', async () => {
    const files = await typescriptFiles(SOURCE_ROOT);

    // VACUITY FLOOR: without this, a walk that returned `[]` would pass.
    expect(files.length).toBeGreaterThan(MIN_SCANNED_FILES);

    expect(await findOccurrences(files)).toEqual([]);
  });

  it('is FOUND when it is real code — positive control', async () => {
    const files = await typescriptFiles(SOURCE_ROOT);
    expect(files.length).toBeGreaterThan(MIN_SCANNED_FILES);

    const control = join(SOURCE_ROOT, CONTROL_FILE);
    expect(files).toContain(control);

    const hits = await findOccurrences(files, {
      file: control,
      content: [
        '// a line comment above it',
        `const probe = ${PATTERN_SOURCE}max(created_at)\`;`,
      ].join('\n'),
    });

    expect(hits).toEqual([`${CONTROL_FILE}:2`]);
  });

  it('is IGNORED when it is only prose — negative control, with a floor', async () => {
    const files = await typescriptFiles(SOURCE_ROOT);
    expect(files.length).toBeGreaterThan(MIN_SCANNED_FILES);

    const control = join(SOURCE_ROOT, CONTROL_FILE);
    expect(files).toContain(control);

    // Every shape the real comments use: a block comment, a doc line, and a
    // trailing comment on a line that also carries live code.
    const prose = [
      '/**',
      ` * A bare ${PATTERN_SOURCE}...\` is an assertion, not a conversion.`,
      ' */',
      `// never write ${PATTERN_SOURCE}...\``,
      `const real = 1; // ${PATTERN_SOURCE}max(created_at)\``,
    ].join('\n');

    const hits = await findOccurrences(files, { file: control, content: prose });

    // The FLOOR that makes this negative control non-vacuous: the injected file
    // really was read, and really did contain the sequence.
    expect(prose).toContain(PATTERN_SOURCE);
    expect(hits).toEqual([]);
  });
});
