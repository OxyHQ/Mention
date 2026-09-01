#!/usr/bin/env bun

/**
 * Enforces two dependency directions in the backend. Both are DEFAULT-DENY with
 * a hand-written, shrink-only BASELINE of what already crosses the line; that
 * shape is the point, and is described once here for both.
 *
 * ## Rule 1 — a federation protocol is reached through its PUBLIC connector
 *
 * Product code (`services/`, `mtn/`, `routes/`, `db/`) must reach a federation
 * protocol through `@oxyhq/federation`'s `NetworkConnector` contract or the
 * connector class itself (`ActivityPubConnector` / `AtprotoConnector`), never
 * through one of that protocol's internal modules (`constants.ts`,
 * `helpers.ts`, `actor.service.ts`, a mapper, and so on).
 *
 * ## Rule 2 — a route or controller does not reach into `db/`
 *
 * The intended path is route/controller -> service -> repository. A repo-wide
 * scan finds 88 (file, db-area) crossings of that today, so this rule lands the
 * same way rule 1 did: the debt is baselined, and the baseline can only shrink.
 *
 * ## Why a baseline, not a hard ban
 *
 * Neither rule's findings are fabricated for the guard, and fixing either set
 * is a real refactor these checks do not perform — issue #701 is explicit that
 * landing a boundary check must not require a behaviour change. So each rule is
 * DEFAULT-DENY (a crossing outside the allowed surface fails unless named
 * below) with a hand-written BASELINE of what already crosses and why.
 *
 * Three things make a baseline a gate and not a rubber stamp:
 *
 *   - A NEW file, or an EXISTING file reaching into a NEW protocol-internal
 *     module / a NEW db area, is not in the baseline and fails immediately.
 *   - The baseline can only SHRINK. An entry naming a crossing that no longer
 *     exists (because someone fixed it) fails the run until the entry is
 *     deleted — the same discipline `validate-no-mongo.mjs`'s
 *     `KNOWN_EXCEPTIONS` and `validate-lockfile.mjs`'s
 *     `ACCEPTED_OVERRIDE_RANGE_VIOLATIONS` already use here, so a fix cannot
 *     silently go stale into a permission nobody re-examines.
 *   - Vacuity floors fail the run when the file listing looks broken, because a
 *     broken listing reports a clean tree.
 *
 * ## What is deliberately OUT of scope
 *
 * Rule 1: `scripts/**` (operator-run, one-shot admin/backfill tools), `queue/`,
 * and `appRoutes.ts` (the one place Express routers are legitimately assembled)
 * are excluded — the issue's own architecture diagram is about PRODUCT code,
 * and a one-shot repair script reaching into `signedFetch` is a different risk
 * profile than a request-serving service doing the same. Widen the scope before
 * trusting this against those directories.
 *
 * Rule 2: see the four decisions recorded above the `LAYER_*` constants below.
 *
 * Regenerating the rule 2 baseline after a merge:
 * docs/architecture-boundary-gate.md.
 *
 * Usage: bun scripts/validate-architecture-boundaries.mjs
 *
 * Environment (self-test only, see test-validate-architecture-boundaries.mjs):
 *   ARCHITECTURE_VALIDATOR_ROOT           scan a scratch checkout instead of this repo
 *   ARCHITECTURE_VALIDATOR_FIXTURE_FLOORS relax the vacuity floors for a fixture tree
 */

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = process.env.ARCHITECTURE_VALIDATOR_ROOT
  ? resolve(process.env.ARCHITECTURE_VALIDATOR_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendRoot = resolve(repositoryRoot, "packages", "backend");
const fixtureFloors = process.env.ARCHITECTURE_VALIDATOR_FIXTURE_FLOORS === "1";

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

// ========================================================== RULE 2 config ===
//
// Route/controller -> `db/`. Four decisions shape what this rule can even see;
// each was made deliberately and each is reversible in one place.
//
// 1. TYPE-ONLY IMPORTS ARE ALLOWED OUTRIGHT, not baselined. `import type
//    { PostRecord } from '../db/posts/postRecord'` is erased at compile time:
//    it puts nothing in the module graph, nothing in the runtime require chain,
//    and cannot execute a query. The thing this rule exists to stop is a
//    request handler OWNING persistence behaviour, and naming a row shape is
//    not that. Baselining the 5 such imports in the tree would also make the
//    shrink-only property adversarial — the only way to "fix" one is to
//    duplicate the row type somewhere else, which is worse than the import.
//    Mixed imports still count: `{ insertLane, type LaneRow }` binds a value.
//
// 2. THE BOUNDARY IS ALL OF `src/db/`, but the message distinguishes two kinds,
//    because they are not the same defect:
//      - QUERY SURFACE (`src/db/postgres.ts`, `src/db/schema/**`) — the
//        connection/transaction handle and the drizzle table objects. Importing
//        either means the handler is AUTHORING SQL. `schema/` looks innocuous
//        (it is "just table definitions") but a table object is a value, and a
//        route holding one plus `getDb()` is a query. This is the sharper half:
//        57 of the 88 (file, area) pairs.
//      - REPOSITORY (everything else under `src/db/`) — calling a query
//        function that already lives in `db/`. The persistence stays where it
//        belongs; only the service seam is missing. Milder, and the half that
//        should shrink first.
//    Both are denied by default. Neither is exempt, because "schema is only
//    types" is exactly the argument that lets `getDb()` follow it in.
//
// 3. `src/mtn/controllers/**` IS IN SCOPE. Rule 1's exemptions (`scripts/`,
//    `queue/`, `appRoutes.ts`) are all "not a request handler"; these three
//    files are request handlers — they take an `OxyAuthRequest` and a
//    `Response` and are mounted as Express routes. They live under `mtn/` for
//    feature-locality, not because they are a different tier. Exempting them
//    would leave a directory a new controller could be created in to dodge the
//    rule. The rest of `src/mtn/**` (the feed engine, its modules) is NOT a
//    route/controller tier and stays out.
//
// 4. BASELINE GRANULARITY IS (file, db AREA), where an area is one directory
//    under `src/db/` or one top-level file in it. Per-file alone is too coarse
//    — `feed.controller.ts` would be excused for reaching into ANY db module
//    forever, including `getDb()` it does not touch today. Per-imported-module
//    is too brittle: renaming `postRepository.ts` would fail 18 entries that
//    describe an unchanged fact. The area is the unit that survives a rename
//    inside `db/` while still making "this file started writing its own SQL"
//    (a new `src/db/postgres.ts` or `src/db/schema/` entry) a hard failure.
//    88 entries, 6 shared reasons.

/** Tiers whose files serve HTTP requests, and must not own persistence. */
const LAYER_IMPORTER_PREFIXES = ["src/routes/", "src/controllers/", "src/mtn/controllers/"];

const DB_ROOT = "src/db/";

/** Areas whose exports are the raw query surface rather than a query function. */
const QUERY_SURFACE_AREAS = new Set(["src/db/postgres.ts", "src/db/schema/"]);

/**
 * Six reasons cover 88 entries, because six distinct things are actually going
 * on. Written once and referenced, rather than restated 88 times in words
 * chosen to look different.
 */
const REASONS = {
  BYPASSES_REPOSITORY:
    "Builds its own drizzle query over tables that DO have a repository module, reaching past it to `getDb()` "
    + "and the table objects for a projection, aggregate or join the repository does not expose. The fix is to "
    + "move the query into the repository and call it through a service — not to move this file.",
  NO_REPOSITORY:
    "Builds its own drizzle query over tables that have NO repository module at all (engagement: bookmarks, "
    + "likes, mutes, mute words, pokes, entity follows, post subscriptions; discovery: notifications, push "
    + "tokens). The handler is currently the only reader and writer, so the SQL has nowhere else to live yet. "
    + "Extracting the repository is the fix, and it is a bigger change than this guard.",
  REPOSITORY:
    "Calls repository functions directly, skipping the service tier. The narrower crossing of the two: the "
    + "query itself stays in `db/`, only the orchestration seam is missing. This is the group expected to "
    + "shrink first, because each fix is one thin service module.",
  TRANSACTION_IN_ROUTE:
    "Opens and orchestrates `getDb().transaction(...)` inside the route, and takes `Transaction` / "
    + "`DatabaseOrTransaction` as parameters of its own helpers — transaction scope is a persistence concern "
    + "that has leaked furthest out of `db/` anywhere in the tree. Worth fixing before the rest of the list.",
  HEALTH_PROBE:
    "Imports only `checkPostgresHealth` for a liveness/readiness endpoint. A health route reporting on the "
    + "database is not the layering defect this rule is about, but it is not exempt either: if the probe ever "
    + "grows a real query, the entry stops describing it and someone has to look.",
  SCHEMA_ENUM:
    "Imports the `TrendingType` TypeScript `enum` from `schema/discovery`. It is a value import only because "
    + "`enum` compiles to an object; nothing here touches the database. The clean fix is to move the "
    + "vocabulary into `@mention/shared-types`, which the schema would then import.",
};

/**
 * Known, reasoned route/controller -> `db/` crossings as of this rule landing.
 * PATH-SORTED, and regenerated mechanically rather than transcribed — see
 * docs/architecture-boundary-gate.md for the regeneration procedure.
 */
const LAYER_BASELINE = [
  { file: "src/controllers/articles.controller.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/articles.controller.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/feed.controller.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/feed.controller.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/feed.controller.ts", area: "src/db/userProfile/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/polls.controller.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/polls.controller.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/postEditSource.controller.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/postEditSource.controller.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/posts/bookmarks.ts", area: "src/db/postgres.ts", reason: REASONS.NO_REPOSITORY },
  { file: "src/controllers/posts/bookmarks.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/posts/bookmarks.ts", area: "src/db/schema/", reason: REASONS.NO_REPOSITORY },
  { file: "src/controllers/posts/createPost.ts", area: "src/db/polls/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/posts/createPost.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/posts/createThread.ts", area: "src/db/polls/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/posts/createThread.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/posts/deletePost.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/posts/deletePost.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/posts/deletePost.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/posts/engagementLists.ts", area: "src/db/postgres.ts", reason: REASONS.NO_REPOSITORY },
  { file: "src/controllers/posts/engagementLists.ts", area: "src/db/schema/", reason: REASONS.NO_REPOSITORY },
  { file: "src/controllers/posts/geo.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/posts/geo.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/posts/geo.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/posts/postSettings.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/posts/postSettings.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/posts/postSettings.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/posts/readPosts.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/posts/readPosts.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/posts/scheduledPosts.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/posts/scheduledPosts.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/posts/scheduledPosts.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/posts/translation.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/posts/updatePost.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/posts/updatePost.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/controllers/posts/updatePost.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/statistics.controller.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/controllers/statistics.controller.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/mtn/controllers/feed.controller.ts", area: "src/db/federation/", reason: REASONS.REPOSITORY },
  { file: "src/mtn/controllers/feedPreferences.controller.ts", area: "src/db/feeds/", reason: REASONS.REPOSITORY },
  { file: "src/mtn/controllers/feedPreferences.controller.ts", area: "src/db/userProfile/", reason: REASONS.REPOSITORY },
  { file: "src/routes/channelWriters.routes.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/channelWriters.routes.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/customFeeds.routes.ts", area: "src/db/feeds/", reason: REASONS.REPOSITORY },
  { file: "src/routes/customFeeds.routes.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/customFeeds.routes.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/entity-follow.routes.ts", area: "src/db/postgres.ts", reason: REASONS.NO_REPOSITORY },
  { file: "src/routes/entity-follow.routes.ts", area: "src/db/schema/", reason: REASONS.NO_REPOSITORY },
  { file: "src/routes/hashtags.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/hashtags.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/routes/hashtags.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/health.routes.ts", area: "src/db/postgres.ts", reason: REASONS.HEALTH_PROBE },
  { file: "src/routes/lanes.routes.ts", area: "src/db/channels/", reason: REASONS.REPOSITORY },
  { file: "src/routes/lanes.routes.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/lanes.routes.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/legacyRoot.routes.ts", area: "src/db/postgres.ts", reason: REASONS.HEALTH_PROBE },
  { file: "src/routes/lists.ts", area: "src/db/postgres.ts", reason: REASONS.TRANSACTION_IN_ROUTE },
  { file: "src/routes/lists.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/routes/lists.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/mtn-nodes.routes.ts", area: "src/db/mtn/", reason: REASONS.REPOSITORY },
  { file: "src/routes/mute.routes.ts", area: "src/db/postgres.ts", reason: REASONS.NO_REPOSITORY },
  { file: "src/routes/mute.routes.ts", area: "src/db/schema/", reason: REASONS.NO_REPOSITORY },
  { file: "src/routes/muteWords.routes.ts", area: "src/db/postgres.ts", reason: REASONS.NO_REPOSITORY },
  { file: "src/routes/muteWords.routes.ts", area: "src/db/schema/", reason: REASONS.NO_REPOSITORY },
  { file: "src/routes/notifications.ts", area: "src/db/postgres.ts", reason: REASONS.NO_REPOSITORY },
  { file: "src/routes/notifications.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/routes/notifications.ts", area: "src/db/schema/", reason: REASONS.NO_REPOSITORY },
  { file: "src/routes/pokes.ts", area: "src/db/postgres.ts", reason: REASONS.NO_REPOSITORY },
  { file: "src/routes/pokes.ts", area: "src/db/schema/", reason: REASONS.NO_REPOSITORY },
  { file: "src/routes/posts.ts", area: "src/db/gates/", reason: REASONS.REPOSITORY },
  { file: "src/routes/profileDesign.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/profileDesign.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/profileDesign.ts", area: "src/db/userProfile/", reason: REASONS.REPOSITORY },
  { file: "src/routes/profileSettings.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/profileSettings.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/routes/profileSettings.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/profileSettings.ts", area: "src/db/userProfile/", reason: REASONS.REPOSITORY },
  { file: "src/routes/reports.routes.ts", area: "src/db/moderation/", reason: REASONS.REPOSITORY },
  { file: "src/routes/reports.routes.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/search.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/search.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
  { file: "src/routes/search.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/starterPacks.ts", area: "src/db/postgres.ts", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/starterPacks.ts", area: "src/db/schema/", reason: REASONS.BYPASSES_REPOSITORY },
  { file: "src/routes/subscriptions.ts", area: "src/db/postgres.ts", reason: REASONS.NO_REPOSITORY },
  { file: "src/routes/subscriptions.ts", area: "src/db/schema/", reason: REASONS.NO_REPOSITORY },
  { file: "src/routes/trending.routes.ts", area: "src/db/schema/", reason: REASONS.SCHEMA_ENUM },
  { file: "src/routes/webShell.routes.ts", area: "src/db/posts/", reason: REASONS.REPOSITORY },
];

const SOURCE_FILE = /\.tsx?$/;

/** Rule 1 only needs the specifier, so it reads every import position at once. */
const IMPORT_SPECIFIER = /(?:from\s*|require\(\s*|import\(\s*)(['"])((?:\.\.?\/)[^'"]+)\1/g;

/**
 * Rule 2 needs the import CLAUSE as well, to tell a type-only import from a
 * value one — so it reads static imports and dynamic ones separately.
 *
 * The clause is anchored at a line start and forbidden from crossing a `;`, or
 * a greedy scan would swallow the preceding `import ... from "express";` and
 * report a type-only import as a value one. Measured: without the anchor, two
 * of the five type-only db imports in the tree are misclassified.
 */
const STATIC_IMPORT_CLAUSE = /^[ \t]*(?:import|export)\b([^;]*?)\bfrom\s*(['"])((?:\.\.?\/)[^'"]+)\2/gm;
const DYNAMIC_IMPORT = /(?:require|import)\(\s*(['"])((?:\.\.?\/)[^'"]+)\1\s*\)/g;

function trackedFiles() {
  const listed = spawnSync("git", ["ls-files", "-z", "--", "packages/backend/src"], {
    cwd: repositoryRoot,
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

/**
 * True when the clause binds NO runtime value: `import type ...`, or a named
 * list in which every specifier carries its own `type` keyword. A default or
 * namespace binding always binds a value, so an opening `{` is required.
 */
function isTypeOnlyClause(clause) {
  const text = clause.trim();
  if (/^type\b/.test(text)) return true;
  if (!text.startsWith("{")) return false;
  const names = text
    .slice(1, text.lastIndexOf("}"))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((name) => /^type\b/.test(name));
}

/** The baseline unit: one directory under `src/db/`, or one file directly in it. */
function dbAreaOf(resolved) {
  const rest = resolved.slice(DB_ROOT.length);
  const head = rest.split("/")[0];
  return rest.includes("/") ? `${DB_ROOT}${head}/` : `${DB_ROOT}${head.replace(/\.ts$/, "")}.ts`;
}

/**
 * An entry without a reason is a permission, not a record — and the
 * `--print-layer-baseline` placeholder `REASONS.PICK_ONE_AND_JUSTIFY_IT`
 * resolves to `undefined`, so this is what stops a regenerated baseline being
 * committed with the reasons left unwritten.
 */
function baselineShapeFailures(name, entries) {
  return entries
    .filter((entry) => typeof entry.reason !== "string" || entry.reason.trim().length === 0)
    .map((entry) =>
      `${name} entry for ${entry.file} (${entry.protocol ?? entry.area}) carries no reason — `
      + "write one saying what would have to change for the entry to go away",
    );
}

function isLayerImporter(importer) {
  return LAYER_IMPORTER_PREFIXES.some((prefix) => importer.startsWith(prefix));
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

/**
 * Guarded by `import.meta.main` so the self-test can import the baselines
 * without running a scan of the real repository as a side effect.
 */
async function main() {
  const tracked = trackedFiles();
  const sources = tracked.filter((path) => SOURCE_FILE.test(path));
  const layerImporters = sources.filter((path) => !isExempt(path) && isLayerImporter(path));
  const dbModules = sources.filter((path) => path.startsWith(DB_ROOT));

  const findings = [];
  const layerFindings = [];

  for (const importer of sources) {
    if (isExempt(importer)) continue;

    const text = await readFile(resolve(backendRoot, importer), "utf8");

    // ------------------------------------------------------------- rule 1 ---
    // The whole connectors/ tree — the registry, cross-protocol identity
    // resolution, shared media helpers, route mounting, and each protocol's own
    // subdirectory — IS the "protocol adapter" layer the issue's own diagram
    // names as its own tier. Free crossing WITHIN it is the point of having a
    // dedicated adapter layer; the boundary this guard enforces is between that
    // layer and product code outside it.
    if (!importer.startsWith("src/connectors/")) {
      for (const match of text.matchAll(IMPORT_SPECIFIER)) {
        const resolved = resolveSpecifier(importer, match[2]);
        for (const protocol of PROTOCOLS) {
          if (!resolved.startsWith(protocol.dir)) continue;
          if (`${resolved}.ts` === protocol.publicEntry || resolved === protocol.publicEntry.replace(/\.ts$/, "")) continue;
          findings.push({ importer, protocol: protocol.id, resolved, line: match[2] });
        }
      }
    }

    // ------------------------------------------------------------- rule 2 ---
    if (isLayerImporter(importer)) {
      const crossings = [];
      for (const match of text.matchAll(STATIC_IMPORT_CLAUSE)) {
        if (isTypeOnlyClause(match[1])) continue;
        crossings.push({ resolved: resolveSpecifier(importer, match[3]), line: match[3] });
      }
      // A dynamic `import()` / `require()` always binds a value at runtime.
      for (const match of text.matchAll(DYNAMIC_IMPORT)) {
        crossings.push({ resolved: resolveSpecifier(importer, match[2]), line: match[2] });
      }
      for (const crossing of crossings) {
        if (!crossing.resolved.startsWith(DB_ROOT)) continue;
        const area = dbAreaOf(crossing.resolved);
        layerFindings.push({
          importer,
          area,
          line: crossing.line,
          kind: QUERY_SURFACE_AREAS.has(area) ? "the raw query surface" : "a repository",
        });
      }
    }
  }

  // A merge can invalidate LAYER_BASELINE entries wholesale (a sibling branch
  // moves a controller, or fixes a crossing), and a stale entry hard-fails.
  // `--print-layer-baseline` re-derives the array from the tree, carrying every
  // surviving entry's reason across and marking only genuinely new pairs, so
  // reconciling a merge is mechanical rather than a puzzle. It VALIDATES
  // NOTHING and is never what CI runs.
  if (process.argv.includes("--print-layer-baseline")) {
    const reasonKeyOf = (reason) => Object.entries(REASONS).find(([, text]) => text === reason)?.[0];
    const pairs = [...new Set(layerFindings.map((f) => `${f.importer}\u0000${f.area}`))].sort();
    console.log("const LAYER_BASELINE = [");
    for (const pair of pairs) {
      const [file, area] = pair.split("\u0000");
      const existing = LAYER_BASELINE.find((b) => b.file === file && b.area === area);
      const key = existing ? reasonKeyOf(existing.reason) : undefined;
      console.log(
        key
          ? `  { file: "${file}", area: "${area}", reason: REASONS.${key} },`
          : `  { file: "${file}", area: "${area}", reason: REASONS.PICK_ONE_AND_JUSTIFY_IT },`,
      );
    }
    console.log("];");
    return;
  }

  // ----------------------------------------------------------- verdict ---

  const unexcused = findings.filter(
    (f) => !BASELINE.some((b) => b.file === f.importer && b.protocol === f.protocol),
  );

  const honoured = new Set();
  for (const f of findings) {
    const entry = BASELINE.find((b) => b.file === f.importer && b.protocol === f.protocol);
    if (entry) honoured.add(entry);
  }
  const staleBaseline = BASELINE.filter((b) => !honoured.has(b));

  const layerUnexcused = layerFindings.filter(
    (f) => !LAYER_BASELINE.some((b) => b.file === f.importer && b.area === f.area),
  );

  const layerHonoured = new Set();
  for (const f of layerFindings) {
    const entry = LAYER_BASELINE.find((b) => b.file === f.importer && b.area === f.area);
    if (entry) layerHonoured.add(entry);
  }
  const staleLayerBaseline = LAYER_BASELINE.filter((b) => !layerHonoured.has(b));

  // Vacuity floors. Every input to both rules is a file listing or a regex, and
  // both fail QUIET: a broken listing reports a clean tree, and so does a regex
  // that stopped matching. These are STRUCTURAL counts, not debt counts, so they
  // keep working as the baselines shrink towards nothing.
  const MINIMUM_SOURCE_FILES = fixtureFloors ? 1 : 400;
  const MINIMUM_LAYER_IMPORTERS = fixtureFloors ? 1 : 40;
  const MINIMUM_DB_MODULES = fixtureFloors ? 1 : 30;

  const failures = [
    ...baselineShapeFailures("BASELINE", BASELINE),
    ...baselineShapeFailures("LAYER_BASELINE", LAYER_BASELINE),
  ];
  if (sources.length < MINIMUM_SOURCE_FILES) {
    failures.push(
      `${sources.length} backend source files scanned is below the ${MINIMUM_SOURCE_FILES} floor — `
      + "the file listing is probably broken, and a broken listing reports a clean tree",
    );
  }
  if (layerImporters.length < MINIMUM_LAYER_IMPORTERS) {
    failures.push(
      `${layerImporters.length} route/controller files scanned is below the ${MINIMUM_LAYER_IMPORTERS} floor — `
      + `rule 2 cannot have inspected the tier it polices (${LAYER_IMPORTER_PREFIXES.join(", ")})`,
    );
  }
  if (dbModules.length < MINIMUM_DB_MODULES) {
    failures.push(
      `${dbModules.length} files under ${DB_ROOT} is below the ${MINIMUM_DB_MODULES} floor — `
      + "rule 2 has nothing to find a crossing INTO, so it would pass whatever the routes do",
    );
  }

  if (
    unexcused.length > 0
    || staleBaseline.length > 0
    || layerUnexcused.length > 0
    || staleLayerBaseline.length > 0
    || failures.length > 0
  ) {
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
    for (const f of layerUnexcused) {
      console.error(
        `  ${f.importer}: reaches into ${f.kind} at ${f.area} ("${f.line}") with no LAYER_BASELINE entry — `
        + "a route or controller must go through a service, which owns the repository call; "
        + "or add a reasoned LAYER_BASELINE entry in scripts/validate-architecture-boundaries.mjs",
      );
    }
    for (const b of staleLayerBaseline) {
      console.error(
        `  LAYER_BASELINE entry for ${b.file} (${b.area}) no longer matches anything — the crossing was fixed; `
        + "delete the entry so the baseline keeps describing the tree",
      );
    }
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }

  console.log(
    `Architecture boundary guard passed — ${sources.length} backend source files scanned.\n`
    + `  rule 1 (protocol internals): ${findings.length} baseline crossing(s) honoured, 0 new violations.\n`
    + `  rule 2 (route/controller -> db): ${layerFindings.length} crossing(s) across `
    + `${LAYER_BASELINE.length} baselined (file, area) pair(s) over ${layerImporters.length} `
    + "route/controller files, 0 new violations.",
  );
}

if (import.meta.main) await main();

export { BASELINE, LAYER_BASELINE, LAYER_IMPORTER_PREFIXES, QUERY_SURFACE_AREAS, PROTOCOLS, baselineShapeFailures };
