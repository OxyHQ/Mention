/**
 * A one-shot entry point that reaches the Postgres pool must OPEN it.
 *
 * ## The defect this exists for leaves nothing to go red
 *
 * `scripts/reconcile-engagement-projections.ts` opened only Mongo while
 * `EngagementProjectionReconciliationService` had been ported to Drizzle. Its
 * first `getDb()` threw `PostgreSQL is not connected`, the task exited 1, and
 * every deploy rolled back. `scripts/migrate.ts` had the same shape through
 * `runMigrationTask` → `reconcileBlockedDomains` → `purgeBlockedDomainContent`,
 * where the throw is caught as fail-soft — so blocking a domain silently
 * stopped purging its content while the deploy reported success.
 *
 * **Nothing went red either time, and nothing could have.** The link between an
 * entry point and the store its callee reads is a RUNTIME CONNECTION, not a
 * symbol: `tsc` sees a valid import graph, and no test executes these files. A
 * clean cut gives TS2307; this gives a green build and a container that dies on
 * its first query. So the property has to be checked STATICALLY, from the
 * module graph, which is what this does.
 *
 * ## Why a graph and not a grep
 *
 * `reconcile-engagement-projections.ts` imports zero Drizzle. It needs the pool
 * because a service two hops away calls `getDb()`. A grep for `drizzle` or
 * `getDb` in the entry point finds nothing in either of the two real cases.
 *
 * ## The over-approximation, and how the exemption stays honest
 *
 * Module reachability is not call reachability: an entry that imports one PURE
 * function from a module which ALSO calls `getDb()` elsewhere is flagged
 * although no call path reaches the pool. That is the safe direction (it asks
 * for a connect that is not strictly needed) but it is also how a gate starts
 * crying wolf, so {@link PURE_IMPORT_EXEMPTIONS} records those — and each entry
 * NAMES the symbols it may import from the offending module. Import anything
 * else from it and the exemption stops applying, so the escape hatch cannot
 * quietly widen into "this script is allowed to skip the pool".
 *
 * A stale exemption is also a failure: if an exempted entry stops reaching the
 * module at all, the declaration has to go rather than sit there looking like
 * it protects something.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/** `packages/backend`. */
const BACKEND = resolve(__dirname, '../../..');
const POSTGRES_MODULE = resolve(BACKEND, 'src/db/postgres.ts');

/** Calling either of these requires a pool that someone already opened. */
const POOL_READERS = new Set(['getDb', 'getPostgresClient']);
const OPENER = 'connectPostgres';

/** Where a Fargate one-shot's `command` can point. */
const ENTRY_DIRS = ['scripts', 'src/scripts'];

/**
 * One-shots that do NOT live in an entry directory.
 *
 * Enumerating by DIRECTORY is a guess about where entry points live, and it is
 * wrong for at least one: `.github/scripts/deploy-ecs-image.sh` runs
 * `packages/backend/dist/src/db/migrate.js` as the FIRST migration one-shot of
 * every deploy — the step whose own comment calls Postgres "the store that can
 * invalidate the whole rollout". A directory scan would have left the most
 * consequential entry point in the deploy unchecked.
 *
 * It passes today for a reason that does not generalise: it builds its own
 * `postgres(url, …)` client rather than going through `connectPostgres`. The
 * day it imports a service instead, this is what notices.
 */
const EXTRA_ENTRY_POINTS = ['src/db/migrate.ts'];

/**
 * The FLOOR. A traversal that silently stopped finding entry points would pass
 * every assertion below while checking nothing, so the count is asserted first.
 * Deliberately a floor and not an equality: adding a script must not fail this.
 *
 * **Lowering it needs a reason, not the current count.** The number that comes
 * out of the walk today satisfies any floor set to it, so a floor re-pinned to
 * whatever is there stops being an assertion about what must exist and becomes
 * "there are as many as there are". This one was 30 before the orphan Mongo
 * scripts were deleted; twelve of them went, so the honest floor is not
 * `30 - 12 = 18` either — that is still just arithmetic on an old guess.
 *
 * 15 is the number of entry points this package cannot function without: the
 * three the deploy invokes by name (`src/db/migrate.ts`, `scripts/migrate.ts`,
 * `src/scripts/assertPostgresPopulated.ts`), the three the operational workflows
 * invoke (`normalizeFederatedText`, `purgeBlockedDomainContent`,
 * `purgeBlockedDomainPlatformData`), the two the cutover depends on
 * (`backfill-mongo-to-postgres.ts`, `reconcile-engagement-projections.ts`), and
 * the seven remaining reviewed admin scripts. Falling below it means a walk that
 * lost a whole class of file, not a deletion somebody made on purpose.
 */
const MIN_ENTRY_POINTS = 15;

/**
 * Entries whose only route into a pool-using module is through symbols that
 * cannot reach the pool.
 *
 * `symbols` is the whole point: it is re-checked against the file's real
 * imports on every run, so this cannot decay into a blanket exemption.
 */
const PURE_IMPORT_EXEMPTIONS: ReadonlyArray<{
  readonly entry: string;
  readonly module: string;
  readonly symbols: readonly string[];
  readonly reason: string;
}> = [
  {
    entry: 'src/scripts/purgeBlockedDomainPlatformData.ts',
    module: 'src/scripts/purgeBlockedDomainContent.ts',
    symbols: ['buildBlockedContentDomains'],
    reason:
      'It purges a domain on the PLATFORM (Oxy), not in our stores, and calls ' +
      '`getDb` nowhere itself. Its one edge into the content purge is ' +
      '`buildBlockedContentDomains`, which folds a blocklist and our own ' +
      'domains into a set of targets and touches no store — the module around ' +
      'it is what reads Postgres.',
  },
];

interface ImportRecord {
  readonly spec: string;
  readonly names: ReadonlyArray<{ imported: string; local: string }>;
}

/**
 * Every VALUE import, static or dynamic.
 *
 * `import type` and per-specifier `type` are excluded because a type cannot
 * call anything; dynamic `await import(...)` is INCLUDED because
 * `evalFeedQuality.ts` reaches the pool that way and a static-only reader
 * called it pool-free.
 */
function valueImports(src: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const destructured = /(?:const|let|var)\s*(\{[\s\S]*?\})\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of src.matchAll(destructured)) {
    out.push({ spec: match[2] ?? '', names: readBindings(match[1] ?? '', ':') });
  }
  for (const match of src.matchAll(/await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.push({ spec: match[1] ?? '', names: [] });
  }
  for (const match of src.matchAll(/import\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (match[1]) continue;
    const braces = /\{([\s\S]*?)\}/.exec(match[2] ?? '');
    out.push({ spec: match[3] ?? '', names: braces ? readBindings(braces[1] ?? '', ' as ') : [] });
  }
  return out;
}

/** `{ a, b as c }` / `{ a, b: c }` → the imported name and the local one. */
function readBindings(clause: string, separator: string): Array<{ imported: string; local: string }> {
  const out: Array<{ imported: string; local: string }> = [];
  for (const part of clause.replace(/[{}]/g, '').split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || trimmed.startsWith('type ')) continue;
    const [imported, local] = trimmed.split(separator === ':' ? /\s*:\s*/ : /\s+as\s+/);
    out.push({ imported: (imported ?? '').trim(), local: (local ?? imported ?? '').trim() });
  }
  return out;
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return resolve(candidate);
  }
  return null;
}

/**
 * The source with comments and string bodies blanked out, for CALL detection.
 *
 * Not a nicety. Every file that fixes this bug explains itself in a docblock,
 * and those docblocks say `connectPostgres()` — with parentheses. Against the
 * raw text the call check therefore matched the PROSE, so deleting the real
 * call from `reconcile-engagement-projections.ts` (the defect that rolled back
 * every deploy) left this gate green. A gate that a comment can satisfy is
 * worse than no gate.
 *
 * Written as ONE pass over the characters rather than chained replaces: a
 * comment strip followed by a string strip desynchronises on the first
 * apostrophe in prose (`server.ts's startup`), and the failure mode is a file
 * that reports NO matches, which reads exactly like success.
 *
 * Lengths are preserved so nothing else has to care that this happened.
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | '"' | "'" | '`' = 'code';
  for (let index = 0; index < src.length; index += 1) {
    const char = src[index] ?? '';
    const next = src[index + 1] ?? '';
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; out += '  '; index += 1; continue; }
      if (char === '/' && next === '*') { state = 'block'; out += '  '; index += 1; continue; }
      if (char === '"' || char === "'" || char === '`') { state = char; out += ' '; continue; }
      out += char;
      continue;
    }
    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += '\n'; continue; }
      out += ' ';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; out += '  '; index += 1; continue; }
      out += char === '\n' ? '\n' : ' ';
      continue;
    }
    // Inside a string: an escape consumes the next character, so a `\'` cannot
    // close it and a `\\` cannot escape the quote that follows.
    if (char === '\\') { out += '  '; index += 1; continue; }
    if (char === state) { state = 'code'; out += ' '; continue; }
    out += char === '\n' ? '\n' : ' ';
  }
  return out;
}

interface Module {
  readonly file: string;
  readonly src: string;
  /** {@link src} with comments and string bodies blanked — see the function. */
  readonly code: string;
  readonly imports: readonly ImportRecord[];
}

const modules = new Map<string, Module>();
function readModule(file: string): Module | null {
  const cached = modules.get(file);
  if (cached) return cached;
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  // Imports are parsed from the RAW source — the specifier lives INSIDE a
  // string, so a stripped copy has no module paths left to resolve. Calls are
  // detected from the stripped copy. The two reads want opposite things.
  const mod: Module = { file, src, code: stripCommentsAndStrings(src), imports: valueImports(src) };
  modules.set(file, mod);
  return mod;
}

/**
 * Does this module CALL one of the pool readers?
 *
 * Keyed on the LOCAL name the file bound, not on the exported one — an aliased
 * import is still a call, and a name-only grep would miss it.
 */
function callsPoolReader(mod: Module): boolean {
  return bindsAndCalls(mod, (imported) => POOL_READERS.has(imported));
}

function callsOpener(mod: Module): boolean {
  return bindsAndCalls(mod, (imported) => imported === OPENER);
}

function bindsAndCalls(mod: Module, wanted: (imported: string) => boolean): boolean {
  for (const record of mod.imports) {
    if (resolveImport(mod.file, record.spec) !== POSTGRES_MODULE) continue;
    for (const { imported, local } of record.names) {
      if (wanted(imported) && new RegExp(`\\b${local}\\s*\\(`).test(mod.code)) return true;
    }
  }
  return false;
}

/** Every module transitively imported, with the edge each was first reached by. */
function graphOf(entry: string): { reached: Set<string>; via: Map<string, string> } {
  const reached = new Set<string>();
  const via = new Map<string, string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined || reached.has(file)) continue;
    reached.add(file);
    const mod = readModule(file);
    if (!mod) continue;
    for (const record of mod.imports) {
      const target = resolveImport(file, record.spec);
      if (target === null || reached.has(target)) continue;
      if (!via.has(target)) via.set(target, file);
      stack.push(target);
    }
  }
  return { reached, via };
}

function chainTo(via: Map<string, string>, entry: string, file: string): string[] {
  const out: string[] = [];
  let cursor: string | undefined = file;
  while (cursor !== undefined && cursor !== entry) {
    out.unshift(relative(BACKEND, cursor));
    cursor = via.get(cursor);
  }
  return out;
}

const entryPoints = [
  ...ENTRY_DIRS.flatMap((dir) => {
    const absolute = resolve(BACKEND, dir);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .map((name) => resolve(absolute, name))
      .filter((file) => statSync(file).isFile());
  }),
  ...EXTRA_ENTRY_POINTS.map((entry) => resolve(BACKEND, entry)),
];

interface Verdict {
  readonly entry: string;
  readonly rel: string;
  readonly opens: boolean;
  /** Pool-using modules in the graph, each with the chain that reached it. */
  readonly reachedPoolVia: ReadonlyArray<{ module: string; chain: readonly string[] }>;
}

const verdicts: Verdict[] = entryPoints.map((entry) => {
  const { reached, via } = graphOf(entry);
  const reachedPoolVia: Array<{ module: string; chain: readonly string[] }> = [];
  for (const file of reached) {
    const mod = modules.get(file);
    if (mod && callsPoolReader(mod)) {
      reachedPoolVia.push({ module: relative(BACKEND, file), chain: chainTo(via, entry, file) });
    }
  }
  const own = readModule(entry);
  return {
    entry,
    rel: relative(BACKEND, entry),
    opens: own !== null && callsOpener(own),
    reachedPoolVia,
  };
});

/** The exemption applies only while the entry imports NOTHING ELSE from the module. */
function exemptionFor(verdict: Verdict) {
  const declared = PURE_IMPORT_EXEMPTIONS.find((entry) => entry.entry === verdict.rel);
  if (!declared) return null;
  const own = readModule(verdict.entry);
  if (!own) return null;
  const target = resolve(BACKEND, declared.module);
  const imported = own.imports
    .filter((record) => resolveImport(verdict.entry, record.spec) === target)
    .flatMap((record) => record.names.map((name) => name.imported));
  return { declared, imported };
}

describe('one-shot entry points and the Postgres pool', () => {
  it('scans every declared out-of-directory entry point', () => {
    // A path that stopped existing would silently drop out of the scan and take
    // its coverage with it, which is the same failure the directory walk has —
    // one file at a time instead of a whole directory.
    for (const entry of EXTRA_ENTRY_POINTS) {
      expect(existsSync(resolve(BACKEND, entry)), `${entry} is declared but missing`).toBe(true);
    }
  });

  it(`scans at least ${MIN_ENTRY_POINTS} entry points`, () => {
    // The vacuity floor. Every assertion below is over `verdicts`, so a
    // traversal that found nothing would pass all of them.
    expect(entryPoints.length).toBeGreaterThanOrEqual(MIN_ENTRY_POINTS);
  });

  it('finds entry points that DO reach the pool, so the check is not inert', () => {
    // The second floor: if the import walker broke, every entry would read as
    // pool-free and the real assertion would pass vacuously.
    expect(verdicts.filter((verdict) => verdict.reachedPoolVia.length > 0).length).toBeGreaterThan(20);
  });

  it('opens the pool in every entry point whose import graph reaches it', () => {
    const offenders = verdicts
      .filter((verdict) => verdict.reachedPoolVia.length > 0 && !verdict.opens)
      .filter((verdict) => exemptionFor(verdict) === null)
      .map((verdict) => {
        const first = verdict.reachedPoolVia[0];
        return `${verdict.rel}\n      reaches ${first?.module} via ${first?.chain.join(' -> ')}`;
      });

    // Named, not counted: "3 scripts are wrong" sends whoever reads it looking.
    expect(
      offenders,
      `These one-shots reach getDb()/getPostgresClient() but never call ${OPENER}(). ` +
        'A one-shot gets none of server.ts\'s startup, so the first query throws ' +
        '"PostgreSQL is not connected" — as a hard exit if nothing catches it, or ' +
        'silently if something does.'
    ).toEqual([]);
  });

  it('does not read a function NAMED in a comment as a call to it', () => {
    // The fixture in the gap, and it is the exact shape that made this gate
    // vacuous: every file that fixes the bug explains itself in a docblock, and
    // the docblock says `connectPostgres()`.
    const prose = [
      '/**',
      " * A one-shot gets none of server.ts's startup, so it must call",
      ' * `connectPostgres()` itself or the first `getDb()` throws.',
      ' */',
      "import { connectPostgres } from '../src/db/postgres';",
      'async function main() { await runIt(); }',
    ].join('\n');
    const stripped = stripCommentsAndStrings(prose);
    expect(/\bconnectPostgres\s*\(/.test(prose)).toBe(true);
    expect(/\bconnectPostgres\s*\(/.test(stripped)).toBe(false);
    // And the strip must not eat the code around it — an over-eager stripper
    // would make every call invisible and this gate green forever.
    expect(stripped).toContain('async function main');
    expect(stripped).toContain('await runIt(');
    expect(stripped.length).toBe(prose.length);
  });

  it('keeps every pure-import exemption honest and current', () => {
    for (const declared of PURE_IMPORT_EXEMPTIONS) {
      const verdict = verdicts.find((entry) => entry.rel === declared.entry);
      expect(verdict, `${declared.entry} is exempted but is not an entry point`).toBeDefined();
      if (!verdict) continue;

      // STALE: it no longer reaches a pool-using module, so the exemption is
      // claiming to protect something that is not happening.
      expect(
        verdict.reachedPoolVia.length,
        `${declared.entry} no longer reaches the pool — delete its exemption`
      ).toBeGreaterThan(0);

      // WIDENED: it now imports something else from the module it was exempted
      // for, and that something may well read the pool.
      const resolved = exemptionFor(verdict);
      expect(resolved?.imported.length ?? 0).toBeGreaterThan(0);
      expect(
        [...(resolved?.imported ?? [])].sort(),
        `${declared.entry} imports more from ${declared.module} than the exemption allows`
      ).toEqual([...declared.symbols].sort());
    }
  });
});
