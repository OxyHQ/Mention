# MongoDB → PostgreSQL migration — Mention's binding contract

Read this before touching migration work. It lives in the repo on purpose: the
sibling oxy-api port kept its copy in a session scratchpad, it evaporated when
that session ended, and seven agents were handed a path to a file that no longer
existed.

The ecosystem-wide rules and the reasoning behind them are oxy-api's
`packages/api/src/db/MIGRATION-CONTRACT.md`. **This file holds only Mention's
deltas.** The per-table conventions are in `schema/CONVENTIONS.md`.

Stack: Drizzle ORM over **`postgres.js`** (`drizzle-orm/postgres-js`), migrations
applied by `src/db/migrate.ts`. Package manager: bun only.

## The cutover itself

The sequence, the commands, the rollback pin and the open items live in
[`docs/MONGO-TO-POSTGRES-CUTOVER.md`](../../../../docs/MONGO-TO-POSTGRES-CUTOVER.md).
This file is the WHY; that one is what someone follows at 3am.

## PREREQUISITE: PostGIS, installed by a privileged role, once per database

**A new target database needs one statement before the migrator can run, and the
application role cannot issue it.**

```sql
CREATE EXTENSION postgis;   -- as the master user (rds_superuser), once
```

Without it, migration `0000` fails at the first `geography` column:

```
ERROR:  type "geography" does not exist
LINE 66:  "content_geo" "geography" GENERATED ALWAYS AS (ST_MakePoint...
```

`ensureExtensions` runs `create extension if not exists postgis` ahead of every
migration and looks like it covers this. It does not: `IF NOT EXISTS`
short-circuits on the duplicate check **before** the privilege check, which is
exactly what makes it a no-op for an unprivileged role on a database that
already has the extension — and a hard failure on one that does not.

```
create extension postgis;
ERROR:  permission denied to create extension "postgis"
```

Measured 2026-08-03 against RDS as `mention`, on a database `mention` **owns**,
reproduced twice. Ownership is not enough — PostGIS is not a trusted extension.

Production is already satisfied: `spatial_ref_sys` there is owned by `rdsadmin`,
so someone ran exactly this once and it was never recorded. The futures where
this bites are the ones with no context available — disaster recovery, a staging
environment, a region migration.

## Who owns what, and why a probe database misrepresents it

`pg_database.datdba` for the production `mention` database is **`mention`**, the
application role itself. Since PG15 `public` is owned by `pg_database_owner`, so
the owning role gets `CREATE` on it, runs the migrator, **owns every table the
migration creates**, and holds full DML by ownership — no `GRANT` anywhere.

This matters when rehearsing. A throwaway database created by `oxyadmin` gives
the same role none of that, and a copy run there fails on privileges production
does not have: two separate `42501`/`42501`-shaped failures during the cutover
rehearsal were read as production facts before anyone measured the production
side. **A rehearsal target must be created `OWNER mention`**, or it is testing a
configuration that will never exist.

## Mention is independent, and that is the whole reason it can move

Mention owns its OWN logical database (`mention-production`) on the shared Mongo
instance. No other app reads its collections — apps talk through oxy-api over
HTTP. So Mention can migrate and cut over on its own schedule.

## `postgres.js`, never `bun-sql`

The ECS image runs `bun packages/backend/dist/server.js`, so `drizzle-orm/bun-sql`
looks tempting. It is wrong: `packages/backend/package.json` runs the test suite
under **node** (`node ../../node_modules/vitest/vitest.mjs`), and `bun-sql`
reaches for the `Bun` global and hard-fails the moment anything loads it outside
Bun. `postgres.js` serves the container, `bun --watch`, and vitest from one code
path.

## There is no `users` table, and there never will be

Oxy owns identity. Every `oxy_user_id` in this schema is a foreign SERVICE's
primary key reached over HTTP, so no foreign key can point at a user. This is the
single biggest structural difference from oxy-api's port and it is enumerated in
`schema/deferredForeignKeys.ts`, not left implicit.

## IDs — decided, do not relitigate

Existing 24-char ObjectId hex strings are preserved **verbatim** in `text`
columns. The backfill copies `_id` as-is: zero remapping, so every FK survives by
construction. New rows post-cutover get **uuid v7**, generated in the application.

For Mention the argument is stronger than "a remap table is hard". A remapped id
is **unfixable from our side** in three places:

1. **The MTN chain is signed over the id.** `MtnUri` is
   `mtn://<oxyUserId>/<collection>/<rkey>` and every emitter passes
   `String(post._id)` / `String(like._id)` / `String(boost._id)` as the `rkey`.
   `rkey`, `collection` and `subject` are all inside `SignedRecordSigningFields`,
   so a remapped id invalidates every record ever signed — including the
   `prev`-chained history and the atproto bridge's `at://…/<rkey>` projection.
2. **Remote fediverse servers hold the ids.** Everything below the actor embeds
   one: the Note id, the `Create`/`Announce`/`Update`/`Like`/`Follow` activity
   ids, and — worst — the `Delete` id and its `Tombstone` `object.id`, which MUST
   match the previously published Note id or the deletion is un-honourable.
   (Actor URIs, `keyId`, webfinger `acct:` and hashtag hrefs are username-derived
   and would survive; nothing below them does.)
3. **CrowdSource holds them.** `subject.externalId` is `Post._id.toHexString()`
   and `externalReportId` is `Report._id`; a decision is routed back by those.

## `isValidObjectId` guards get DELETED, not widened

Where they only ever prevented a Mongoose `CastError`, a `text` id simply matches
no rows and the guard has no reason to exist. Where a 400 is a real documented
contract (`middleware/validate.ts` `validateObjectId`, the poll routes), use a
check that accepts BOTH live id shapes.

**Audit each site — several branch on the result rather than merely rejecting,
and some FAIL OPEN.** The full inventory is in the migration report.

`@oxyhq/db`'s `isLiveEntityId` is the ONLY place either id shape is spelled out,
and it exists for the documented-400 case alone (`middleware/validate.ts`
`validateObjectId`, which now accepts both). Reaching for it as a precondition on
a QUERY re-introduces the fail-open bug in a new costume.

The four fail-open sites, all closed by the query phase's batch 0:

- **`services/moderation/ModerationEnforcementService.ts`** — `loadPostState`
  returned `null` for a non-ObjectId id, and the caller answers
  `"The reported post no longer exists"`, so every CrowdSource enforcement became
  a silent no-op **with a plausible-looking reason in the audit log**. The
  closest analogue of the oxy-api `mediaPrivacyService` bug. Guard deleted, file
  ported to Drizzle, suite rebuilt against real rows.
- **`services/LabelService.ts`** — a subscribed labeler whose id was not 24-hex
  was dropped from the viewer's effective label set with no log, so their
  hide/warn/blur preferences stopped applying. Guard deleted; `LabelService` and
  `routes/labeler.routes.ts` ported together (one request path may not span two
  stores). **`getUserEffectiveLabels` still has no callers** — nothing applies a
  label to any feed, so the guard's consequence was masked by a larger gap.
- **`utils/feedQueryBuilder.ts`** — `applyLabelFiltering` and the
  `excludePostIds` filter both dropped label filters and then returned "nothing
  hidden". Verified dead repo-wide (no caller, no producer) and DELETED. Only
  `buildVideosQuery` and `buildMediaFeedQuery` are reachable from production;
  the rest of that class is dead but guard-free.
- **`services/ContentAffinityService.ts`** — the doc comment described an
  `isValid` guard that **was never written**. Do not audit this file by comment.
  Comment corrected; the file's queries belong to the feed/ranking batch, which
  must also fix what the comment concealed: one malformed id in the `$in` throws
  a `CastError` that the `catch` turns into a whole EMPTY batch, not a skipped id.

Not a fail-open guard, checked and left alone: `services/MediaMetadataService.ts`
`isOxyFileId` is a DISCRIMINATOR (Oxy file id vs. a raw federated URL) whose
shape belongs to **oxy-api**, a different service still on Mongo — it must NOT
widen to uuid v7 with Mention's own ids.

## Production safety

Production MongoDB is NOT touched by any code-porting task. It stays live until a
separately-approved cutover. No agent runs a backfill against production, and no
agent creates or modifies anything in AWS — RDS (`oxy-postgres`, us-west-2) and
all infrastructure belong to `~/Oxy/oxy-infra`.

## Verification — evidence, not assertion

Run `bun run test` and `bun run lint` from `packages/backend`, and `bun run build`
from the repo root. A reachable Postgres is a HARD prerequisite of the suite:

```
docker compose -f docker-compose.postgres.yml up -d postgres
```

**The API wire format must not change.** Mention's frontend AND the fediverse
consume it. Prove response parity for endpoints you touch.

**Rewriting a suite means replacing the assertions, not translating them.**
`src/__tests__/setup.ts` mocks mongoose wholesale, so the existing suites assert
that a query was BUILT a certain way and never that a row is correct. Seed real
rows, run the real function, assert what is stored and returned.

**Mutation-test anything load-bearing:** break the guarantee, confirm the test
goes red AND names it, then restore the file **in place** (`cat pristine >
target`, never `mv` — `node_modules` and worktrees are hardlinked and shared
machine-wide) and verify byte-identical.

Report gaps explicitly. A stated gap is worth more than a confident summary.
