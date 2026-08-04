/**
 * No source file may contain a raw control character.
 *
 * This is a convention that was stated, agreed, and then violated twice — once
 * in `LabelService.ts` (committed, `ecb1cc69`) and once in the backfill's own
 * `userProfile.ts`, both a NUL used as a separator inside a composite map key.
 * A convention nothing checks is a convention that gets violated, so it is a
 * test rather than a paragraph.
 *
 * ## Three harms, and the third is the one that bites hardest
 *
 * 1. **It is invisible in a diff.** `git diff` renders a raw NUL as a SPACE, so
 *    a template literal joined by one reads as though it were joined by a
 *    space — a plausible separator — in every review and every blame. Nobody
 *    can see it in order to object to it.
 * 2. **It is invisible in an editor**, so the next person to touch the line
 *    retypes it as a space and silently changes the key.
 * 3. **It makes the whole file BINARY to grep**, which fails SILENTLY: `grep`
 *    reports no match rather than an error, so every grep-based check against
 *    that file answers "not present" for content that is present. Measured
 *    here: `grep -c emitLabelActions userProfile.ts` exited 1 on a file
 *    containing two occurrences, and a mutation whose search pattern therefore
 *    never matched reported a source rule as UNGUARDED when the guard was fine.
 *    A verification tool that cannot fail loudly is worse than no tool.
 *
 * The fix is never to drop the separator — a composite key genuinely needs one
 * that cannot occur in either part. It is to write the six-character ESCAPE,
 * which denotes the identical string and is plain ASCII in the file.
 *
 * Tab, newline and carriage return are allowed: they are ordinary formatting.
 *
 * This file is deliberately written with escapes only, and is scanned by its
 * own rule — an exemption for the scanner would be the first thing to rot.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** C0 and C1 controls, minus tab, newline and carriage return. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

const SOURCE_ROOT = join(__dirname, '..', '..');

async function typescriptFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await typescriptFiles(path)));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(path);
    }
  }
  return found;
}

describe('source files', () => {
  it('contain no raw control characters', async () => {
    const files = await typescriptFiles(SOURCE_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        const match = FORBIDDEN_CONTROL.exec(line);
        if (match === null) continue;
        const codePoint = match[0].codePointAt(0) ?? 0;
        offenders.push(
          `${file.slice(SOURCE_ROOT.length + 1)}:${index + 1} contains U+` +
            `${codePoint.toString(16).toUpperCase().padStart(4, '0')} — write the ` +
            'escape instead of the raw character'
        );
      }
    }

    expect(offenders, 'source files containing a raw control character').toStrictEqual([]);

    // The vacuity floor. A traversal that found no files, or one whose regex was
    // mis-built, would satisfy the assertion above while checking nothing. The
    // backend has well over a thousand TypeScript files; three hundred is a
    // floor that cannot drift upward past what is really scanned.
    expect(files.length).toBeGreaterThan(300);
  });

  it('detects a control character when one is present', async () => {
    // The mutation test, inline and permanent: a scanner nobody has ever seen
    // FAIL is a scanner nobody knows works. This pins the PREDICATE rather than
    // the corpus, so it stays honest while the tree is clean — which is exactly
    // the state in which the case above cannot tell a working regex from a
    // broken one.
    expect(FORBIDDEN_CONTROL.test(`a${String.fromCodePoint(0)}b`)).toBe(true);
    expect(FORBIDDEN_CONTROL.test(`a${String.fromCodePoint(0x1f)}b`)).toBe(true);
    // …and does NOT fire on the escape spelling, which is the sanctioned fix,
    // nor on ordinary formatting.
    expect(FORBIDDEN_CONTROL.test('a\\u0000b')).toBe(false);
    expect(FORBIDDEN_CONTROL.test('a\tb')).toBe(false);
    expect(FORBIDDEN_CONTROL.test('a\nb')).toBe(false);
  });
});
