#!/usr/bin/env bun

/**
 * Enforces one dependency direction: product code (`services/`, `mtn/`,
 * `routes/`, `db/`) must reach a federation protocol through its PUBLIC
 * connector — `@oxyhq/federation`'s `NetworkConnector` contract, or the
 * connector class itself (`ActivityPubConnector` / `AtprotoConnector`) — never
 * through one of that protocol's internal modules (`constants.ts`,
 * `helpers.ts`, `actor.service.ts`, a mapper, and so on).
 *
 * ## Why a baseline, not a hard ban
 *
 * A repo-wide grep for this today finds real, live imports of ActivityPub
 * internals from `PostHydrationService`, `channelDeletionFederation`,
 * `profileLinkMentions`, and several others (issue #701). None of that is
 * fabricated for this guard, and fixing all of it is a real refactor this
 * change does not perform — issue #701 is explicit that landing the boundary
 * check must not require a behaviour change. So this guard is DEFAULT-DENY
 * (an import outside the allowed surface fails unless named below) with a
 * hand-written, per-file BASELINE of what already crosses the line and why.
 *
 * Two things make the baseline a gate and not a rubber stamp:
 *
 *   - A NEW file, or an EXISTING file reaching into a NEW protocol-internal
 *     module, is not in the baseline and fails immediately.
 *   - The baseline can only SHRINK. An entry naming an import that no longer
 *     exists (because someone fixed it) fails the run until the entry is
 *     deleted — the same discipline `validate-no-mongo.mjs`'s
 *     `KNOWN_EXCEPTIONS` and `validate-lockfile.mjs`'s
 *     `ACCEPTED_OVERRIDE_RANGE_VIOLATIONS` already use here, so a fix cannot
 *     silently go stale into a permission nobody re-examines.
 *
 * ## What is deliberately OUT of scope for this first cut
 *
 * `scripts/**` (operator-run, one-shot admin/backfill tools), `queue/`, and
 * `appRoutes.ts` (the one place Express routers are legitimately assembled)
 * are excluded — the issue's own architecture diagram is about PRODUCT code,
 * and a one-shot repair script reaching into `signedFetch` is a different risk
 * profile than a request-serving service doing the same. Widen the scope
 * before trusting this against those directories.
 *
 * Usage: bun scripts/validate-architecture-boundaries.mjs
 */

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "backend");

/** Each protocol's internal tree, and the ONE file outside it may be imported directly. */
const PROTOCOLS = [
  { id: "activitypub", dir: "src/connectors/activitypub/", publicEntry: "src/connectors/activitypub/ActivityPubConnector.ts" },
  { id: "atproto", dir: "src/connectors/atproto/", publicEntry: "src/connectors/atproto/AtprotoConnector.ts" },
];

/** Importer prefixes this first cut does not police — see the module docblock. */
const EXEMPT_IMPORTER_PREFIXES = ["src/scripts/", "src/queue/"];
const EXEMPT_IMPORTER_FILES = new Set(["src/appRoutes.ts"]);

/**
 * Known, reasoned crossings of the boundary, as of this guard landing. Each
 * entry excuses ONE importer file reaching into ONE protocol's internals —
 * not specific modules within it, so a file already named here can rearrange
 * which internal file it imports without a spurious failure, while a
 * DIFFERENT file reaching into the same protocol still needs its own entry.
 */
const BASELINE = [
  {
    file: "src/services/federation/BlockedDomainPurgeReconciler.ts",
    protocol: "activitypub",
    reason:
      "Lives in services/federation/, the federation-glue subtree, not general product code; reads the block "
      + "policy type to reconcile Oxy's purge queue against it.",
  },
  {
    file: "src/services/federation/blockedDomainPolicySource.ts",
    protocol: "activitypub",
    reason:
      "Lives in services/federation/; re-exports the SAME committed block policy array the public transparency "
      + "page and enforcement both read (see AGENTS.md § Federation Blocklist) — intentional, not incidental.",
  },
  {
    file: "src/services/federation/BlocklistProposalService.ts",
    protocol: "activitypub",
    reason: "Lives in services/federation/; drafts blocklist proposals from the same policy/registry AP enforcement reads.",
  },
  {
    file: "src/services/federation/BlocklistProposalScheduler.ts",
    protocol: "activitypub",
    reason: "Lives in services/federation/; gates its sweep on the same FEDERATION_ENABLED flag the connector reads.",
  },
  {
    file: "src/services/FederationJobScheduler.ts",
    protocol: "activitypub",
    reason:
      "A scheduler dedicated to federation delivery jobs — reaches the connector instance directly to check "
      + "outbox-failure classification the public NetworkConnector surface does not expose.",
  },
  {
    file: "src/services/PostHydrationService.ts",
    protocol: "activitypub",
    reason:
      "TRACKED DEBT, not endorsed: the single most product-central service in the app reaches into "
      + "actor.service/constants/bridgy directly for federated-author display fields. This is exactly the "
      + "coupling issue #701 exists to shrink — narrow it to the NetworkConnector surface before adding a "
      + "third protocol.",
  },
  {
    file: "src/services/MediaMetadataService.ts",
    protocol: "activitypub",
    reason: "TRACKED DEBT: imports one AP attachment TYPE for media metadata mapping; should come from a normalized DTO.",
  },
  {
    file: "src/services/profileLinkMentions.ts",
    protocol: "activitypub",
    reason:
      "TRACKED DEBT: resolves @mentions in post bodies by reaching into AP's own domain/acct helpers instead of "
      + "a protocol-neutral identity lookup.",
  },
  {
    file: "src/services/channelDeletion/channelDeletionFederation.ts",
    protocol: "activitypub",
    reason:
      "TRACKED DEBT: performs channel-teardown federation side effects (follow/delivery services) directly "
      + "instead of emitting a LocalNetworkEvent through the connector registry.",
  },
  {
    file: "src/mtn/feed/feeds/FeedGeneratorFeed.ts",
    protocol: "atproto",
    reason:
      "TRACKED DEBT: the atproto feed-generator surface imports the atproto post mapper directly rather than "
      + "through fetchPosts() on the connector.",
  },
];

const SOURCE_FILE = /\.tsx?$/;
const IMPORT_SPECIFIER = /(?:from\s*|require\(\s*|import\(\s*)(['"])((?:\.\.?\/)[^'"]+)\1/g;

function trackedFiles() {
  const listed = spawnSync("git", ["ls-files", "-z", "--", "packages/backend/src"], {
    cwd: resolve(backendRoot, "..", ".."),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr ?? listed.error}`);
  }
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .filter((path) => path.startsWith("packages/backend/"))
    .map((path) => path.slice("packages/backend/".length));
}

function isExempt(importer) {
  if (EXEMPT_IMPORTER_FILES.has(importer)) return true;
  if (EXEMPT_IMPORTER_PREFIXES.some((prefix) => importer.startsWith(prefix))) return true;
  if (importer.includes("/__tests__/") || importer.endsWith(".test.ts")) return true;
  return false;
}

/** Resolve a relative specifier against the importing file's directory, repo-relative. */
function resolveSpecifier(importerPath, specifier) {
  const importerDir = importerPath.split("/").slice(0, -1);
  const parts = specifier.split("/");
  const stack = [...importerDir];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

const tracked = trackedFiles();
const sources = tracked.filter((path) => SOURCE_FILE.test(path));

const findings = [];

for (const importer of sources) {
  if (isExempt(importer)) continue;
  // The whole connectors/ tree — the registry, cross-protocol identity
  // resolution, shared media helpers, route mounting, and each protocol's own
  // subdirectory — IS the "protocol adapter" layer the issue's own diagram
  // names as its own tier. Free crossing WITHIN it is the point of having a
  // dedicated adapter layer; the boundary this guard enforces is between that
  // layer and product code outside it.
  if (importer.startsWith("src/connectors/")) continue;

  const text = await readFile(resolve(backendRoot, importer), "utf8");
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const resolved = resolveSpecifier(importer, match[2]);
    for (const protocol of PROTOCOLS) {
      if (!resolved.startsWith(protocol.dir)) continue;
      if (`${resolved}.ts` === protocol.publicEntry || resolved === protocol.publicEntry.replace(/\.ts$/, "")) continue;
      findings.push({ importer, protocol: protocol.id, resolved, line: match[2] });
    }
  }
}

// ------------------------------------------------------------- verdict ---

const unexcused = findings.filter(
  (f) => !BASELINE.some((b) => b.file === f.importer && b.protocol === f.protocol),
);

const honoured = new Set();
for (const f of findings) {
  const entry = BASELINE.find((b) => b.file === f.importer && b.protocol === f.protocol);
  if (entry) honoured.add(entry);
}
const staleBaseline = BASELINE.filter((b) => !honoured.has(b));

const MINIMUM_SOURCE_FILES = 400;
const failures = [];
if (sources.length < MINIMUM_SOURCE_FILES) {
  failures.push(
    `${sources.length} backend source files scanned is below the ${MINIMUM_SOURCE_FILES} floor — `
    + "the file listing is probably broken, and a broken listing reports a clean tree",
  );
}

if (unexcused.length > 0 || staleBaseline.length > 0 || failures.length > 0) {
  console.error("Architecture boundary guard failed:\n");
  for (const f of unexcused) {
    console.error(
      `  ${f.importer}: imports ${f.protocol} internal "${f.line}" with no BASELINE entry — `
      + "route through the connector's public class, @oxyhq/federation's NetworkConnector contract, "
      + "or add a reasoned BASELINE entry in scripts/validate-architecture-boundaries.mjs",
    );
  }
  for (const b of staleBaseline) {
    console.error(
      `  BASELINE entry for ${b.file} (${b.protocol}) no longer matches anything — the import was fixed; `
      + "delete the entry so the baseline keeps describing the tree",
    );
  }
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `Architecture boundary guard passed — ${sources.length} backend source files scanned, `
  + `${findings.length} baseline crossing(s) honoured, 0 new violations.`,
);
