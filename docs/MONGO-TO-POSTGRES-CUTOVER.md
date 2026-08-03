# Mongo → Postgres cutover runbook

The sequence, the commands, and the two numbers that must be written down before
the window opens. The *why* is `packages/backend/src/db/MIGRATION-CONTRACT.md`;
this file is what someone follows at 3am.

Everything below marked **measured** was measured against production or against
a rehearsal that used production Mongo as its source. Everything marked
**unverified** is called out rather than smoothed over.

---

## 0. Write these down before anything starts

The rollback is cheap, correct, and worthless if nobody recorded the pin while
the service was still healthy.

| what | value | how to re-derive |
|---|---|---|
| live task definition | `oxy-mention:167` | `aws ecs describe-services --cluster oxy-cluster --services mention --query 'services[0].taskDefinition'` |
| live image digest | `sha256:01bdb8af9e8634b20678c9993856b2b53b20b87c4509412884ca3ef6ab06f2f9` | `aws ecs describe-task-definition --task-definition oxy-mention:167 --query 'taskDefinition.containerDefinitions[0].image'` |
| desired count | `2` | same query, `desiredCount` |

All AWS commands: `--profile oxy --region us-west-2`. Cluster `oxy-cluster`,
service `mention`.

**Re-derive them on the day and confirm they match.** A pin copied from this file
without checking is a pin to whatever was live when this file was written.

---

## 1. Preconditions

Each is a fact to CHECK, not to assume.

1. **PostGIS is installed in the target database.** The application role cannot
   install it — `permission denied to create extension "postgis"`, measured
   twice, on a database it owns. Production has it already (`spatial_ref_sys`
   owner `rdsadmin`). On any NEW database a role with `rds_superuser` must run
   `CREATE EXTENSION postgis;` once, or migration `0000` fails with
   `type "geography" does not exist`. See `drizzle/0000_furry_shocker.sql`.
2. **The production `mention` database is empty of application tables.**
   Measured: 1 table (`spatial_ref_sys`), no `drizzle.__drizzle_migrations`, no
   rows. This is what makes the copy's own `assertTargetsEmpty` a real guard
   rather than a formality.
3. **The `mention` role owns the `mention` database** (`pg_database.datdba`),
   so it holds `CREATE` on `public` through `pg_database_owner` and owns every
   table it creates. No grant is needed anywhere. Measured.
4. **The pre-flight audit is clean.** Run it the day before (§2). The audit is
   purely a refusal gate — the copy consumes nothing it produces — so it does
   not have to be inside the window.
5. `drizzle/foundation` is merged to `main` and CI is green.

---

## 2. The day before — pre-flight audit

The audit costs ~29 minutes and blocks nothing. Run it against the **probe**, not
production: it reads production Mongo either way, and its verdict is about the
SOURCE.

```bash
aws ecs run-task --cluster oxy-cluster --launch-type FARGATE \
  --task-definition <pgaudit revision pointing at PROBE_DATABASE_URL> \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-08f5cc132b3cab15c,subnet-0bfb367f29d1fd375],securityGroups=[sg-0f0ca416eacab578c],assignPublicIp=ENABLED}' \
  --overrides '{"containerOverrides":[{"name":"mention","command":[
     "bun","packages/backend/dist/scripts/backfill-mongo-to-postgres.js","--audit-only"]}]}'
```

Read the log by paging `get-log-events` with `nextForwardToken` to exhaustion and
**confirm you reached the verdict banner**. `filter-log-events` truncates at
10,000 events silently, and a truncated read is indistinguishable from a clean
one.

Expected verdict (last measured, 2026-08-03): `0 finding(s) BLOCK the copy`,
FK coverage `47/47`, transform fidelity `58/58`.

**A clean pre-flight is clean AS OF ITS BOUND.** The last run excluded 251
documents that arrived while the pass ran. Whatever arrives between the audit and
the copy is un-audited, and if it violates a constraint the copy fails partway —
loudly, and resumable from its checkpoint. That is the trade for taking the audit
out of the window, and it was accepted deliberately.

---

## 3. The window

Ordering is forced, not preferred: the ported code reads Postgres, so deploying
before the data lands gives an app reading an empty database.

**stop → migrate → copy → deploy → verify → admit.**

### 3.1 Stop taking traffic

```bash
aws ecs update-service --cluster oxy-cluster --service mention --desired-count 0
```

Confirm it stopped — do not trust the command's exit code:

```bash
aws ecs describe-services --cluster oxy-cluster --services mention \
  --query 'services[0].{running:runningCount,pending:pendingCount}'
# expect running: 0
```

Both `api.mention.earth` and the apex `mention.earth` are served by this one
service, so both stop. The ALB returns **503** with no healthy targets, which is
correct and deliberate: Mastodon treats 5xx as retryable and will redeliver.
**Do not "helpfully" serve a 4xx** — a 410 or 404 ends delivery from that
instance permanently (see AGENTS.md § Fediverse Discovery).

### 3.2 Apply the Postgres migrations to the REAL database

The copy needs the schema, so this precedes it. The deploy in §3.4 runs the same
migrator again; it is idempotent and the second run is a no-op.

Run it with a task definition whose `DATABASE_URL` secret is
`/oxy/mention/DATABASE_URL`:

```bash
--overrides '{"containerOverrides":[{"name":"mention","command":[
   "bun","packages/backend/dist/src/db/migrate.js"]}]}'
```

Expect `Applied 17 Postgres migration(s)` and exit 0. Measured at 0.5s against an
empty database, run by the application role holding no grants.

### 3.3 The copy — **the most dangerous step in this migration**

Every safety built during the rehearsal points at `mention_audit_probe`. This run
inverts that. Read this section before running anything.

**`--target-database` is REQUIRED and is checked against `current_database()`
before anything is read or written.** The `DATABASE_URL` secret still decides
where the connection goes; the flag is the operator stating where they believe it
goes, and a mismatch refuses with both names in the message. A stale probe URL, a
wrong environment, or a database recreated under another name all fail closed.

```bash
--overrides '{"containerOverrides":[{"name":"mention","command":[
   "bun","packages/backend/dist/scripts/backfill-mongo-to-postgres.js",
   "--target-database=mention"]}]}'
```

Still true and still worth doing, now as belt-and-braces rather than as the only
protection:

- Use a task definition revision whose `DATABASE_URL` is
  `/oxy/mention/DATABASE_URL`, carrying **no** `PG_MASTER_PASSWORD` and no probe
  credential.
- `assertTargetsEmpty` refuses a fresh run against a target that already holds
  rows. If it refuses, **stop and read** — either the copy already ran, or you
  are somewhere unexpected.
- `--start-from-empty` TRUNCATES every target table and now requires
  `--confirm-truncate=mention` naming the same database. Do not use it on a
  first cutover: there is nothing to truncate, which is exactly what would make a
  stray one invisible until the resumed run destroys what was already copied.

Sizing: the rehearsal ran on 4 vCPU / 30 GB. **Use a larger task for the real
run** — cost for one run is negligible and the copy is CPU-bound in the
transform (44% of it, measured). No code change is needed for that to be correct.

Expected, from the full rehearsal against production Mongo (2026-08-03):

| phase | measured |
|---|---|
| discovery | 2s |
| in-run audit | 29m18s (18m48s on another run — budget the upper figure) |
| copy | 35m58s, of which `posts` alone is 32m52s |
| **total** | **65m45s**, exit 0 |
| rows | 4,986,482 across 58 collections |
| resolution records | 2,348 written = 2,348 claimed |

If the audit has been taken out of the window (§2), the copy alone is ~36
minutes. **That skip needs a flag that does not exist yet** — `runBackfill`
always audits. Until it exists, budget the full 66 minutes.

**If it dies partway:** the checkpoint is in Postgres
(`mention_backfill_checkpoints`), so re-running RESUMES. Do not clear it, do not
add `--start-from-empty`. A partially-written batch converges on resume — see the
CLI's header for why.

### 3.4 Deploy

Push/merge to `main`. `.github/workflows/deploy-aws.yml` runs the Postgres
migration one-shot, then the Mongo one, then `update-service` — in that order,
before the rollout, by design. `assertPostgresMigrationsCurrent` is the other
half: a task refuses to become ready if migrations are pending, so a bypassed
migration step surfaces as a task that will not serve rather than one that serves
wrongly.

Bring the service back up as part of this step:

```bash
aws ecs update-service --cluster oxy-cluster --service mention --desired-count 2
```

### 3.5 Verify BEFORE admitting users

Traffic is already flowing at this point (the service is up and the ALB will
route to healthy targets), so treat this as the decision point for rollback
rather than a gate you can hold traffic behind. If a check fails, §4.

- Tasks reach `RUNNING` and stay there. A boot-time refusal appears as tasks
  cycling, not as an error page.
- `.github/scripts/smoke-mention.sh` runs as part of the deploy — read its result
  rather than assuming.
- Row counts in Postgres against the copy's own report. Two independent paths
  agreed to the row in rehearsal; they should again.
- One authenticated read of a real feed, and one profile.
- One federation round trip: the actor JSON at
  `https://api.mention.earth/ap/users/<user>` returns 200 with a `publicKey`
  whose id host matches the actor id host.

### 3.6 What sends us back rather than forward

- Tasks that will not stay `RUNNING`.
- The copy did not complete, or its row counts disagree with the report.
- A feed or profile read that errors rather than merely being slow.
- Any write path returning 5xx.

---

## 4. Rollback

**Mongo is untouched and authoritative throughout.** The copy only reads it, by
construction (`mongoSource.ts` hands out a Proxy that throws on anything but a
read). So rollback is redeploying the pre-cutover image; no data is restored,
because none was moved out of Mongo.

```bash
aws ecs update-service --cluster oxy-cluster --service mention \
  --task-definition oxy-mention:167 --desired-count 2 --force-new-deployment
```

Then confirm the running tasks carry the pinned digest — not the tag:

```bash
aws ecs describe-services --cluster oxy-cluster --services mention \
  --query 'services[0].taskDefinition'
```

`oxy-mention:167` already carries `DATABASE_URL` from `/oxy/mention/DATABASE_URL`
and ignores it, so the rollback needs no secret changes.

**Postgres is left populated.** That is intentional and harmless — nothing reads
it once the old image is back. A second attempt must then either resume from the
checkpoints or be run against a freshly recreated database; it must NOT be a
fresh run into the populated one (`assertTargetsEmpty` will refuse it, correctly).

---

## 5. Open items — read before scheduling

- **No `--skip-audit` flag exists.** Until it does, the window is ~66 minutes,
  not ~36. (#76)
- **~47% of the `posts` copy time is unattributed.** It is a remainder from
  subtraction, not a measured component, and it must not be quoted as one. (#86)
- **`src/migrations/task.ts` runs 25 Mongo migrations inside the production
  deploy**, and it is what makes `purgeBlockedDomainContent` production-reachable.
  Mongo cannot be decommissioned until it is retired — but it does not block this
  cutover, because Mongo keeps running through it. (#83)
- **Readiness gates on the wrong store, and this outlives the cutover.** Read
  from `routes/health.routes.ts`: `/health/ready` is
  `phase === 'ready' && migrationsComplete && mongoReady`. So Mongo-down reports
  **503** and the task drains — that part is correct today and answers the
  question directly. The problem is the mirror: **Postgres reachability is not
  checked at all**, so after the cutover a task whose Postgres connection is gone
  keeps reporting ready and keeps receiving traffic while failing every query.
  Before the cutover that asymmetry matches which store is authoritative; the
  moment the data moves it is exactly backwards. Fix it with the flip, not after.
  (#82)
- **Mongo is also a hard BOOT dependency**: `server.ts` awaits
  `connectToDatabase()` before `connectPostgres()`, and production boot calls
  `assertMongoTransactionalTopology()` — a replica-set assertion. Both must go
  before Mongo can be switched off; neither blocks this cutover, because Mongo
  keeps running through it. Note the Postgres half is already right:
  `assertPostgresMigrationsCurrent` refuses to let a task become ready against an
  unmigrated database, which is what stops a task serving 500s after the deploy's
  one-shot failed to reach it. (#82)
- **834 posts carry no `authorship` row** (as of 2026-08-03 09:55Z — a reading,
  not a constant). Pre-existing in Mongo and carried across faithfully; not a
  cutover blocker, needs its own backfill. (#78)
- **A failed copy writes no resolution log.** `persistResolutionLog` runs only
  after the copy returns, so the audit trail is empty for exactly the runs that
  need it most. (#79)
