import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every `vi.mock` in this package names a module that EXISTS.
 *
 * `vi.mock` keys on a RESOLVED module id. A mock whose specifier resolves to
 * nothing therefore matches nothing — silently, with no warning from vitest and
 * no failing assertion, because the spy it installs simply stays uncalled and an
 * uncalled spy is indistinguishable from a stub that is working. The suite runs
 * the REAL module while every comment in the file says it is stubbed.
 *
 * That failure mode has been paid for twice. #706 deleted the Mongoose models
 * and left 151 mocks pointing at them, and every one of those suites stayed
 * green; #712 swept them. #713 then found two more of a different origin — a
 * module RENAMED out from under its mock, and a relative path written from the
 * wrong directory — which is the shape that will keep recurring, because
 * renaming a module does not touch the string that names it.
 *
 * So the sweep is not the fix; this is. It is worth having only because the
 * thing it measures is invisible by construction.
 *
 * Bare specifiers (`@oxyhq/core/server`, `node:https`) are NOT checked — those
 * resolve through package exports and conditions, and a wrong one fails loudly
 * at import anyway. Only RELATIVE specifiers are in scope, which is where the
 * silence lives.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

/**
 * Extension candidates, in the order a bundler would try them. `''` first so a
 * specifier that already carries its extension resolves to itself.
 */
const CANDIDATES = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js'];

/**
 * Floors. A scanner that silently reads nothing reports the same clean zero as a
 * repository with no dead mocks, so "found none" is only meaningful next to
 * "and it looked at this much". Both are well under the current counts and are
 * meant to catch a BROKEN scan, not to track growth.
 */
const MIN_FILES_WITH_MOCKS = 250;
const MIN_RESOLVED_RELATIVE_MOCKS = 900;

interface MockReference {
  file: string;
  spec: string;
}

/**
 * Blank out comments and the insides of string literals, preserving offsets and
 * line breaks.
 *
 * A census over source that counts comments is wrong in the direction that
 * matters here: prose quoting `vi.mock('../models/Post')` to explain why it was
 * REMOVED would be counted as the very thing it documents, and this file's own
 * docblock does exactly that. Strings are blanked for the same reason — a
 * fixture containing the text of a mock call is not a mock call.
 */
function blankNonCode(source: string): string {
  const out: string[] = [];
  let state: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const pair = source.slice(index, index + 2);

    if (state === 'code') {
      if (pair === '//') {
        state = 'line';
        out.push('  ');
        index += 2;
        continue;
      }
      if (pair === '/*') {
        state = 'block';
        out.push('  ');
        index += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') state = char;
      out.push(char);
      index += 1;
      continue;
    }

    if (state === 'line' || state === 'block') {
      if (state === 'line' && char === '\n') {
        state = 'code';
        out.push('\n');
        index += 1;
        continue;
      }
      if (state === 'block' && pair === '*/') {
        state = 'code';
        out.push('  ');
        index += 2;
        continue;
      }
      out.push(char === '\n' ? '\n' : ' ');
      index += 1;
      continue;
    }

    // Inside a string literal: keep the quotes (the extractor matches on them)
    // and the length, blank the body.
    if (char === '\\') {
      out.push('  '.slice(0, Math.min(2, source.length - index)));
      index += 2;
      continue;
    }
    if (char === state) {
      state = 'code';
      out.push(char);
      index += 1;
      continue;
    }
    out.push(char === '\n' ? '\n' : ' ');
    index += 1;
  }

  return out.join('');
}

/**
 * The specifiers of every `vi.mock` / `vi.doMock` / `vi.unmock` in one file.
 *
 * Matched against the ORIGINAL source but positioned by the blanked copy, so a
 * call inside a comment or a string contributes nothing while a real one keeps
 * its literal specifier.
 */
function extractMockSpecs(source: string): string[] {
  const blanked = blankNonCode(source);
  const pattern = /vi\.(?:mock|doMock|unmock|doUnmock)\(\s*(['"])/g;
  const specs: string[] = [];

  for (const match of blanked.matchAll(pattern)) {
    const quote = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const end = source.indexOf(quote, start);
    if (end === -1) continue;
    specs.push(source.slice(start, end));
  }
  return specs;
}

/** Does this relative specifier, read from `fromFile`, name a file on disk? */
function resolves(fromFile: string, spec: string): boolean {
  const base = normalize(join(dirname(fromFile), spec));
  return CANDIDATES.some((extension) => {
    try {
      return statSync(base + extension).isFile();
    } catch {
      return false;
    }
  });
}

function walk(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, found);
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(full);
  }
  return found;
}

const scan = (() => {
  const dead: MockReference[] = [];
  let filesWithMocks = 0;
  let resolvedRelative = 0;
  let bare = 0;

  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('vi.mock') && !source.includes('vi.doMock') && !source.includes('vi.unmock')) continue;
    const specs = extractMockSpecs(source);
    if (specs.length > 0) filesWithMocks += 1;

    for (const spec of specs) {
      if (!spec.startsWith('.')) {
        bare += 1;
        continue;
      }
      if (resolves(file, spec)) resolvedRelative += 1;
      else dead.push({ file: relative(SRC, file), spec });
    }
  }

  return { dead, filesWithMocks, resolvedRelative, bare };
})();

describe('every vi.mock names a module that exists', () => {
  it('finds no mock pointing at a path that resolves to nothing', () => {
    expect(
      scan.dead.map((reference) => `${reference.file} -> ${reference.spec}`),
    ).toEqual([]);
  });

  it('actually looked at the tree it is reporting on', () => {
    // Without these, a scanner that read zero files would pass the assertion
    // above with the same output as a clean repository.
    expect(scan.filesWithMocks).toBeGreaterThanOrEqual(MIN_FILES_WITH_MOCKS);
    expect(scan.resolvedRelative).toBeGreaterThanOrEqual(MIN_RESOLVED_RELATIVE_MOCKS);
    // Bare specifiers exist and are skipped on purpose; a zero here would mean
    // the extractor stopped seeing a whole category.
    expect(scan.bare).toBeGreaterThan(0);
  });
});

describe('the scan itself', () => {
  // The positive control, in the same currency as the measurement: a synthetic
  // source attributed to a real directory, carrying one of every shape the scan
  // claims to handle. If any counter here stops moving, the zero above stops
  // meaning "none" and starts meaning "blind".
  const synthetic = [
    "import { vi } from 'vitest';",
    "// vi.mock('../models/CommentedOut');",
    "/* vi.mock('../models/BlockCommented'); */",
    "const prose = \"vi.mock('../models/InAString')\";",
    "vi.mock('../models/GoneForGood');",
    "vi.mock('../utils/logger');",
    "vi.mock('@oxyhq/core/server');",
  ].join('\n');

  const specs = extractMockSpecs(synthetic);

  it('extracts a real call and ignores one in a comment or a string', () => {
    expect(specs).toEqual(['../models/GoneForGood', '../utils/logger', '@oxyhq/core/server']);
  });

  it('classifies a missing module dead and a present one alive', () => {
    const from = join(SRC, '__tests__', 'synthetic.test.ts');
    expect(resolves(from, '../models/GoneForGood')).toBe(false);
    expect(resolves(from, '../utils/logger')).toBe(true);
  });
});
