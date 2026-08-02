import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `RedisStore` prefix in the backend must be unique.
 *
 * Two limiters that share a prefix share a Redis KEY whenever their key
 * generators agree — and ours mostly agree, because the convention here is to
 * key an authenticated caller as `user:<id>`. That is not a tidy-naming concern:
 * `rateLimitStore`'s Lua sets a TTL only when it CREATES the key
 * (`if hits == 1 or ttl == -1`), so the first limiter to arrive silently decides
 * the window for every limiter sharing that key, and each one's counter is
 * incremented by the others' traffic.
 *
 * It happened: `apiRateLimiter` and the app-wide `createOxyRateLimit` both used
 * `rate-limit:api:` with 60s and 15min windows. Nothing detected it —
 * `ERR_ERL_DOUBLE_COUNT` fires only for one shared client, and these were two
 * independent `RedisStore` instances — so it survived until a CodeQL fix on an
 * unrelated router went looking for a limiter to reuse.
 *
 * A per-limiter behavioural test would not have caught it: each limiter passes
 * its own test in isolation, because the collision is a property of the SET.
 * Hence this shape — enumerate the set, assert the invariant.
 */

const BACKEND_SRC = path.resolve(__dirname, '../..');

/** The prefix `RedisStore` falls back to when a caller omits one. */
const DEFAULT_PREFIX = 'rate-limit:';

interface PrefixSite {
  prefix: string;
  file: string;
  line: number;
  /** The whole matched construction, so a failure names the offender verbatim. */
  source: string;
}

function collectTypeScriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      // `__tests__` is excluded ON PURPOSE: a test may construct a store to
      // exercise a limiter, and those never reach a real Redis. The vacuity
      // floor below is what stops that exclusion from hiding a broken walk.
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
      collectTypeScriptFiles(full, out);
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Find every `new RedisStore(...)` and resolve the prefix it will use.
 *
 * Deliberately tolerant of formatting (the constructions in-tree are split
 * across lines in several styles) and deliberately explicit about the
 * no-argument form, which silently takes {@link DEFAULT_PREFIX} and can collide
 * with anything else that omits one.
 */
function collectPrefixSites(): PrefixSite[] {
  const sites: PrefixSite[] = [];

  for (const file of collectTypeScriptFiles(BACKEND_SRC)) {
    const contents = readFileSync(file, 'utf8');
    const construction = /new\s+RedisStore\s*\(([^)]*)\)/g;

    let match = construction.exec(contents);
    while (match !== null) {
      const args = match[1];
      const prefixMatch = /prefix\s*:\s*['"]([^'"]*)['"]/.exec(args);
      sites.push({
        prefix: prefixMatch ? prefixMatch[1] : DEFAULT_PREFIX,
        file: path.relative(BACKEND_SRC, file),
        line: contents.slice(0, match.index).split('\n').length,
        source: match[0].replace(/\s+/g, ' ').trim(),
      });
      match = construction.exec(contents);
    }
  }

  return sites;
}

/**
 * Floor for the number of constructions the walk must find.
 *
 * Without it, a regex that stops matching — or a directory walk that silently
 * returns nothing — reports "no duplicates" and passes forever. Set below the
 * current count so ordinary additions and removals do not trip it; it only fires
 * when the scanner itself has broken.
 */
const MINIMUM_EXPECTED_SITES = 10;

describe('RedisStore prefix uniqueness', () => {
  it('finds enough constructions for the scan to be meaningful', () => {
    const sites = collectPrefixSites();
    expect(sites.length).toBeGreaterThanOrEqual(MINIMUM_EXPECTED_SITES);
  });

  it('assigns every limiter its own prefix', () => {
    const byPrefix = new Map<string, PrefixSite[]>();
    for (const site of collectPrefixSites()) {
      const existing = byPrefix.get(site.prefix);
      if (existing) existing.push(site);
      else byPrefix.set(site.prefix, [site]);
    }

    const collisions = [...byPrefix.entries()].filter(([, sites]) => sites.length > 1);

    // Report the offenders verbatim — a bare count would leave the next reader
    // grepping for which two limiters actually clash.
    const detail = collisions
      .map(([prefix, sites]) =>
        `  ${prefix}\n${sites.map((s) => `    ${s.file}:${s.line}  ${s.source}`).join('\n')}`
      )
      .join('\n');

    expect(collisions, `Rate-limit prefixes shared by more than one store:\n${detail}`).toEqual([]);
  });

  it('never lets a store fall back to the default prefix', () => {
    // An omitted prefix is the collision that is easiest to introduce and hardest
    // to see: two such stores agree without either naming a prefix at all.
    const defaulted = collectPrefixSites().filter((site) => site.prefix === DEFAULT_PREFIX);
    const detail = defaulted.map((s) => `  ${s.file}:${s.line}  ${s.source}`).join('\n');

    expect(defaulted, `RedisStore constructed without a prefix:\n${detail}`).toEqual([]);
  });
});
