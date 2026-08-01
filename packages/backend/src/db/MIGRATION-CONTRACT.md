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
and some FAIL OPEN.** The full inventory is in the migration report; the ones
that matter:

- **`services/moderation/ModerationEnforcementService.ts:77`** — `loadPostState`
  returns `null` for a non-ObjectId id, and the caller answers
  `"The reported post no longer exists"`. Every CrowdSource enforcement action
  becomes a silent no-op **with a plausible-looking reason in the audit log**.
  This is the closest analogue of the oxy-api `mediaPrivacyService` bug.
- **`services/LabelService.ts:189`** — a subscribed labeler whose id is not
  24-hex is dropped from the viewer's effective label set with no log, so their
  hide/warn/blur preferences stop applying.
- **`utils/feedQueryBuilder.ts:135` and `:235`** — both drop label filters and
  then return "nothing hidden". Currently DEAD code; fix or delete before it is
  revived into a non-ObjectId world.
- **`services/ContentAffinityService.ts:781`** — the doc comment describes an
  `isValid` guard that **was never written**. Do not audit this file by comment.

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
