/**
 * Which runner owns each backend test file while the suite moves from Vitest to
 * `bun test`.
 *
 * The rule is the file's own import, and nothing else: a `*.test.ts` that
 * imports from `'bun:test'` belongs to `bun test`, every other one belongs to
 * Vitest. Both runners read this module — `vitest.config.ts` EXCLUDES the bun
 * files and `runBunTests.ts` passes exactly those files to `bun test` — so a
 * file cannot be run by neither runner or by both, and migrating a file is one
 * edit to that file rather than an edit to the file plus a list that can drift
 * from it.
 *
 * A file that imports from BOTH is refused rather than assigned: whichever
 * runner it went to, half of its imports would be the wrong runner's.
 *
 * Plain `node:fs` only: Vitest loads this through its config on Node, and the
 * bun runner loads it on Bun.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** `src/` — the same root the suite-collection gate walks. */
export const TEST_ROOT = resolve(__dirname, 'src');

/**
 * A value import from `bun:test` (single- or multi-line). Anchored at the start
 * of a line so prose in a comment cannot claim a file, and `import type` is not
 * a claim: a type-only import executes nothing.
 */
const BUN_TEST_IMPORT = /^import\s+(?!type\b)[^;]*?\bfrom\s+'bun:test';/m;
const VITEST_IMPORT = /^import\s+(?!type\b)[^;]*?\bfrom\s+'vitest';/m;

/** Every `*.test.ts` under `root`, absolute and sorted — skipping what the collection gate skips. */
function testFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (entry.name.endsWith('.test.ts')) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

export interface RunnerSplit {
  /** Absolute paths of the files `bun test` runs. */
  bun: string[];
  /** Absolute paths of the files Vitest runs. */
  vitest: string[];
}

export function splitTestFiles(root: string = TEST_ROOT): RunnerSplit {
  const split: RunnerSplit = { bun: [], vitest: [] };
  const ambiguous: string[] = [];
  for (const file of testFiles(root)) {
    const source = readFileSync(file, 'utf8');
    const isBun = BUN_TEST_IMPORT.test(source);
    if (isBun && VITEST_IMPORT.test(source)) ambiguous.push(file);
    else (isBun ? split.bun : split.vitest).push(file);
  }
  if (ambiguous.length > 0) {
    throw new Error(
      `These test files import from both 'vitest' and 'bun:test', so neither runner can own them:\n  ${ambiguous.join('\n  ')}`,
    );
  }
  return split;
}
