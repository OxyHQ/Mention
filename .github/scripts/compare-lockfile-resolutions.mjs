#!/usr/bin/env bun
/**
 * Decides whether a committed `bun.lock` that DIFFERS from a clean reproduction
 * is nonetheless acceptable.
 *
 * `verify-lockfile.sh` reproduces the lockfile by restoring the base one and
 * re-resolving against this revision's manifests. That is the right shape for
 * catching a manifest change committed without its lockfile — but it has a
 * blind spot the script's own comments already name: **bun carries a resolution
 * forward from the lockfile it starts with.** So an edge the base pinned at a
 * stale version survives the reproduction, and a commit that deliberately
 * re-resolves it — the only way to move a transitive dependency off a published
 * advisory without inventing an override — is reported as a defect.
 *
 * That is not hypothetical. It is why a security exception for
 * GHSA-rgw5-rvv9-x895 was written with the reason "the patch satisfies the range
 * its dependent already declares, no override needed", then expired unactioned:
 * nothing re-resolved the edge, and the gate would have refused the lockfile
 * that did.
 *
 * The rule this applies instead: the committed lockfile may be **AHEAD** of the
 * reproduction on an edge, never **BEHIND** it, and never a different package.
 * Forgetting `bun install` still fails — that leaves the committed file behind
 * the reproduction or missing edges entirely, both of which this refuses.
 */
const [committedPath, reproducedPath] = process.argv.slice(2);
if (!committedPath || !reproducedPath) {
  console.error('usage: compare-lockfile-resolutions.mjs <committed> <reproduced>');
  process.exit(2);
}

/** `"key": ["name@1.2.3", …]` — the only shape this needs from bun.lock. */
function resolutions(text) {
  const found = new Map();
  const line = /^\s*"([^"]+)":\s*\[\s*"((?:@[^/]+\/)?[^@"]+)@([^"]+)"/gm;
  for (const m of text.matchAll(line)) found.set(m[1], { name: m[2], version: m[3] });
  return found;
}

/** Numeric-segment compare; a prerelease or non-numeric tail never counts as ahead. */
function compareVersions(a, b) {
  const parse = (v) => {
    const core = v.split(/[-+]/, 1)[0];
    const parts = core.split('.').map((n) => Number.parseInt(n, 10));
    return parts.length === 3 && parts.every(Number.isInteger) ? parts : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a === b ? 0 : null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  // Equal cores with different tails is a prerelease difference, not an upgrade.
  return a === b ? 0 : null;
}

const committed = resolutions(await Bun.file(committedPath).text());
const reproduced = resolutions(await Bun.file(reproducedPath).text());

// A traversal that finds nothing must not read as agreement.
if (committed.size < 100 || reproduced.size < 100) {
  console.error(`::error::refusing to judge: parsed ${committed.size} committed and ${reproduced.size} reproduced resolutions, which is too few to be a real lockfile`);
  process.exit(2);
}

const ahead = [];
const deduped = [];
const problems = [];
const committedNames = new Set([...committed.values()].map((r) => r.name));

for (const [key, repro] of reproduced) {
  const mine = committed.get(key);
  if (!mine) {
    // Not necessarily a loss: re-resolving an edge often DEDUPES it onto a copy
    // another key already carries, so the key disappears while the package
    // stays resolvable. That is what moving a transitive dependency off an
    // advisory usually looks like. Losing the package entirely is a different
    // thing and still fails.
    if (committedNames.has(repro.name)) { deduped.push(`${key} (${repro.name}@${repro.version})`); continue; }
    problems.push(`${key}: present in a clean resolve, and ${repro.name} resolves nowhere in the committed lockfile`);
    continue;
  }
  if (mine.name !== repro.name) { problems.push(`${key}: committed ${mine.name}, a clean resolve gives ${repro.name}`); continue; }
  const order = compareVersions(mine.version, repro.version);
  if (order === 0) continue;
  if (order === 1) { ahead.push(`${key}: ${repro.version} -> ${mine.version}`); continue; }
  problems.push(
    order === -1
      ? `${key}: committed ${mine.version} is BEHIND the ${repro.version} a clean resolve gives`
      : `${key}: committed ${mine.version} and resolved ${repro.version} are not comparable`,
  );
}

for (const key of committed.keys()) {
  if (!reproduced.has(key)) problems.push(`${key}: in the committed lockfile, absent from a clean resolve`);
}

if (problems.length > 0) {
  for (const p of problems.slice(0, 20)) console.error(`::error::${p}`);
  if (problems.length > 20) console.error(`::error::…and ${problems.length - 20} more`);
  process.exit(1);
}

console.log(
  `bun.lock is ahead of a clean resolve on ${ahead.length} edge(s), deduped on ${deduped.length}, and behind on none.`,
);
for (const a of ahead.slice(0, 20)) console.log(`  ahead:   ${a}`);
for (const d of deduped.slice(0, 20)) console.log(`  deduped: ${d}`);
const shown = Math.min(ahead.length, 20) + Math.min(deduped.length, 20);
const total = ahead.length + deduped.length;
if (total > shown) console.log(`  …and ${total - shown} more`);
