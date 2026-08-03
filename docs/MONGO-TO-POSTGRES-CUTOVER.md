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

**Re-derive every value below. Do not read them off this page.** The right-hand
column is the point of the table; the middle column is a worked example of what
the answer looks like, and it is already wrong.

| what | last observed (STALE — re-derive) | how to re-derive |
|---|---|---|
| live task definition | `oxy-mention:167` | `aws ecs describe-services --cluster oxy-cluster --services mention --query 'services[0].taskDefinition'` |
| live image digest | `sha256:01bdb8af9e8634b20678c9993856b2b53b20b87c4509412884ca3ef6ab06f2f9` | `aws ecs describe-task-definition --task-definition <the revision above> --query 'taskDefinition.containerDefinitions[0].image'` |
| desired count | `2` | same query, `desiredCount` |

This is not a hypothetical caution. That pin has already moved TWICE while this
runbook sat unchanged — `oxy-mention:167` → `:173` → `:176` — because every
ordinary deploy to `main` cuts a new revision, and the cutover is preceded by
more deploys than usual. Rolling back to a revision written down weeks ago does
not restore the service that was running an hour ago: it reverts whatever
shipped in between, silently, at the worst possible moment. The digest has the
same problem and is worse to debug, since a stale one still *resolves*.

Re-derive at the start of the window, paste the answers into the incident
channel rather than into this file, and treat a value here that matches what you
measured as a coincidence.

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
4. **The pre-flight audit is clean.** Run it the day before (§2) — and note it
   runs AGAIN inside the window. See §2 for why the skip was designed, approved,
   and then cancelled.
5. `drizzle/foundation` is merged to `main` and CI is green.
6. **The trunk's test suite is at its verified baseline.** Measured on
   `drizzle/channels-plans` @ `b017809c`, three consecutive full runs agreeing
   exactly: **504 files, 5,939 tests collected, 5,938 passing, 1 failing, zero
   files dead at load.** The single failure is `closedValueSets.test.ts` ›
   *"has no set that disagrees with the vocabulary Mongo holds"* — the
   `notifications.entityType` case, parked pending the production `distinct()`
   in §2. Anything else red is new and is not this baseline. Re-take with
   `bun run --cwd packages/backend test` plus
   `bun run check:suite-collection <report.json> packages/backend/src`.

   The collection gate matters here specifically: a test file that dies before
   its first `it()` collects zero tests, so it cannot fail an assertion and the
   pass RATIO goes UP. That is not hypothetical — it hid 296 tests behind a
   99.9% pass rate on this very branch. **Zero files collecting zero is part of
   the baseline, not a detail.**

---

## 2. The day before — pre-flight audit and the production readings

### 2.0 The audit stays INSIDE the window — this reversed

`--skip-audit` was designed, approved, and then **cancelled**. It is not a
pending task; it is a decision, and the reason should stop anyone re-proposing
it at 03:40 because the window looks long.

**Why it reversed:** the plans changed materially after the flag was approved,
and in the hours that followed **the audit's own instruments caught silent data
loss twice** — a rehearsal scoring a perfect `58/58` on rows while dropping
eleven populated columns (#92), and a set of carried fields nobody had checked
(#93). Its value went up at exactly the moment it looked skippable. A gate is
worth most when you are most tempted to skip it, which is the moment its subject
has changed.

**Consequence: budget ~86 minutes, not ~36.** Measured components: CI ~4 min,
deploy ~9 min, copy ~66 min with the audit inside it, plus stop/migrate/verify.

Run the day-before pass anyway. It costs ~29 minutes, blocks nothing, and a
BLOCK finding found the day before is a scheduling decision rather than a
window-length crisis. Run it against the **probe**, not production: it reads
production Mongo either way, and its verdict is about the SOURCE.

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
FK coverage `47/47`, row cardinality `58/58`.

**Every number this audit reports describes ROWS.** None of them describes
whether a row's columns were filled. A rehearsal scoring `58/58` was found to be
silently dropping eleven columns that hold real values in production — see #92.
Column coverage is a separate check (`db/backfill/columnCoverage.ts`) with its
own line in the report; do not read either number as standing for the other.

**A clean pre-flight is clean AS OF ITS BOUND.** The last run excluded 251
documents that arrived while the pass ran. Whatever arrives afterwards is
un-audited by *that* pass — which is now covered, because the in-window audit
re-reads the source at copy time.

### 2.1 Production readings that must be taken BEFORE the copy

Four queries against production Mongo. Each decides something, and two of them
can break the copy if taken afterwards instead.

```js
db.notifications.distinct('entityType')
db.lanes.distinct('displayMode')
db.posts.countDocuments({ 'metadata.collabFederationDeferred': true })
db.posts.countDocuments({ 'metadata.federationDelivered': true })
```

- **`notifications.entityType`** — decides whether the Postgres CHECK constraint
  may be tightened. **Tightening that vocabulary before knowing what production
  holds breaks the copy at a constraint**, mid-window, on a table nobody is
  watching. One trunk test is parked on this exact reading (§1.6).
- **`lanes.displayMode`** — one row expected; closes a documented handoff to
  `EnumAudit`.
- **The two `metadata.*` counts** — expected **zero**. They confirm there is no
  retro-federation backlog (§3.4b). If either is non-zero the federation
  behaviour change stops being backlog-free and needs a decision before the
  flip, not after.

Host access note: these are DB-level queries and are unaffected by the broken
host-level access described in §4.

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

**This step needs a task definition that does not exist by default, and the
reason is the whole trap. Read the next three paragraphs before running
anything.**

`migrate.ts`'s docblock says a one-shot can reuse the LIVE task definition with
only `command` overridden, and that is true in general. **It is false here.** At
this point in the window the live `oxy-mention` revision is still built from
`main`, and `main` has **no `postgres` dependency and no `drizzle/` directory at
all** — measured 2026-08-03. Its image contains neither
`dist/src/db/migrate.js` nor a single migration. Point this step at it and you
get `Cannot find package 'postgres'`, not a migration.

And the trunk-built image that *does* contain them is produced by the merge at
**§3.4 — one step LATER**, which §3.3 cannot be moved ahead of because the copy
needs the schema. **So §3.2 is not satisfiable with the artefacts a normal
deploy leaves lying around.** `containerOverrides` cannot override `image`, so
this is not fixable with a flag.

**Register a dedicated task definition** pairing a **trunk-built image** with the
real `/oxy/mention/DATABASE_URL`, and run the migrator on that:

```bash
--overrides '{"containerOverrides":[{"name":"mention","command":[
   "bun","packages/backend/dist/src/db/migrate.js"]}]}'
```

**Assert the image before you trust the result** — see the `journalEntries`
paragraph below, which is exactly the check that tells a right image from a
wrong one when both exit 0.

There is a read-only sibling for inspecting the live database without touching
it: **`oxy-mention-LIVE-PROD-DB-readonly`**, a trunk-built image plus the
production connection whose DEFAULT command is a read-only check, so a bare
`run-task` on it cannot do anything but read. It is deliberately named to make a
reader hesitate. Use it for questions (does PostGIS exist, who owns the
database, is it empty); never for the migration.

#### Three other task definitions look right, and every one of them is wrong

**This step has NO target-database guard.** `--target-database` protects the copy
in §3.3; nothing equivalent protects this one. `migrate.ts` applies the journal to
whatever `DATABASE_URL` names and cannot tell one database from another, so **the
task definition is the only thing deciding** — the precise failure
`db/backfill/targetDatabase.ts` exists to make impossible one step later.

Measured 2026-08-03:

| Task definition | Its `DATABASE_URL` resolves to | Verdict |
| --- | --- | --- |
| `oxy-mention` | `/oxy/mention/DATABASE_URL` | **the one you want** |
| `oxy-mention-pgaudit` | `/oxy/_tmp/mention-pg-audit/PROBE_DATABASE_URL` | rehearsal only — the PROBE |
| `oxy-pg-migrate` | `/oxy/oxy-api/DATABASE_URL` | **oxy-api's. Not Mention's.** |
| `oxy-pg-backfill` | `/oxy/oxy-api/DATABASE_URL` | **oxy-api's. Not Mention's.** |

`oxy-pg-migrate` is the name somebody half-remembering "the Postgres migration
task" reaches for, and it runs an `oxy/oxy-api` image against oxy-api's database —
the wrong application entirely, not merely the wrong database.

`oxy-mention-pgaudit` is the subtler one, because everything about it is right
except the ending: right image, right application, **probe** database. Used here
it applies the whole journal to `mention_audit_probe`, prints `Applied 19` and
exits 0 — while the real database stays unmigrated and §3.3 then copies five
million rows into a schema that does not exist.

**So dry-run first.** `DRY_RUN=true` reports what WOULD be applied and writes
nothing, not even the ledger table, which makes it the cheapest way to find out
which database you are actually pointed at before any DDL runs:

```bash
--overrides '{"containerOverrides":[{"name":"mention",
   "environment":[{"name":"DRY_RUN","value":"true"}],
   "command":["bun","packages/backend/dist/src/db/migrate.js"]}]}'
```

Expect `DRY RUN — 19 migration(s) would be applied; nothing was written`.

**Read `journalEntries` off that line and compare it against
`meta/_journal.json` in the tree you built the image from. Refuse if they
disagree.** This is the one assertion that makes a wrong migrate result LOOK
wrong, and it is worth more than the rest of the output combined.

The reason is that every other field is identical in the good case and the bad
one. **The migrations ship INSIDE the image** (`Dockerfile`:
`COPY … packages/backend/drizzle/`), so an image built before a migration
existed carries a journal that has never heard of it. Run the migrator from that
image and it finds nothing above the ledger's high-water and prints
`No pending Postgres migrations`, exit 0 — which is byte-identical to the
genuinely-current case. `Applied N` has the same shape, the exit code is the
same, and an empty pending list reads as *"we are current"* when it actually
means *"this image cannot see the migration you need."*

`journalEntries` separates them, because the count comes from the journal the
IMAGE carries rather than from the database. Measured 2026-08-03: an image built
at `b9b4318f` reports **18** and silently no-ops; the image rebuilt after `0018`
landed reports **19** and applies it. Nothing else in either output differs.

**The field is logged on exactly two lines, and this is why the dry run is not
optional.** `migrate.ts` attaches `journalEntries` to `No pending Postgres
migrations` and to the `DRY RUN` line — and to neither `Applying` nor `Applied`.
So a real run that succeeds never tells you which journal it used. The two
places the number IS printed are precisely the two "nothing happened / nothing
would happen" states, which is where the ambiguity lives: a stale image
announces itself on the `No pending` line if you read the field, and a correct
image proves itself on the `DRY RUN` line before you commit to any DDL.

**This also fixes the ordering.** Because the journal travels in the image, a
probe or a database can only be brought to a migration the image contains — so
**build first, then migrate.** Migrating before rebuilding is a no-op that
reports success.

Then the real run: expect `Applied 19 Postgres migration(s)` and exit 0.
**Re-derive that number rather than trusting this line** — it is `0000`–`0018` as
of `94ba6797`, and §1 records the real database as holding no ledger, so every
journal entry is pending and the count is simply `len(meta/_journal.json entries)`
at whatever commit you deploy. It has already been wrong twice here, reading `17`
after `0017` landed and `18` after `0018` landed. Measured at 0.5s against an
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

**Budget the full ~66 minutes.** The audit is inside this figure and stays there
— see §2.0. `runBackfill` always audits, and the flag that would have skipped it
was cancelled rather than left pending, so there is nothing to wait for and
nothing to enable. **~36 minutes is not an option on the table.**

#### A count in this runbook is a snapshot, and the run will legitimately see a different one

Every number in the table above describes one run against a source that keeps
moving. The resolution rules are deliberately never read from a frozen list —
`db/backfill/resolutions.ts` says why, and it is worth reading in place: *"a
precomputed list would miss exactly the rows that arrived since, copy them, and
violate the foreign key having reported nothing."* That design is right, and it
has a consequence worth stating: **the populations those rules act on move while
you are reading about them.**

The same file measures it. `DROP_BOOST_OF_A_POST_MENTION_NEVER_HELD` records its
decision as taken "over ALL 348 such rows live in `mention-production`" on
2026-08-03 — and notes that the **348th arrived 81 seconds after the audit's
bound closed**. An independent recount of that same population, the same day,
returned **347**. Neither number is wrong; one boost-of-a-missing-post arrived or
was deleted in between.

Do not confuse that recount with the *other* 347 in the same docblock: "347 of
the 348 are federated" is a breakdown of the population, not a second measurement
of its size. Two different quantities, one digit apart, a few lines apart.

So: **do not stop a cutover because a count disagrees with the prose.** A
different N is the expected behaviour of a live source, not drift to
investigate. Investigate a count only if it moves by an **order of magnitude**,
or if the **shape** changes — a new constraint name, a new collection, a rule
firing that never fired before. Those are signals; a number ticking by one is
not.

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

**Set `ALLOW_ZERO_DESIRED_COUNT=mention` on this deploy.** Without it the deploy
**refuses and exits 1** — traffic already stopped, copy already done, window
burning.

`.github/scripts/deploy-ecs-image.sh` requires a positive `desiredCount`, in two
places: a pre-check before anything mutates, and a steady-state check that
refuses to accept a zero-task rollout. That guard is right for every ordinary
deploy — a zero-count service means capacity was lost, and rolling a new image
onto nothing is a green deploy and an outage.

**The cutover is the one case where zero is deliberate, and the reason is data,
not convenience.** §3.1 stopped traffic at `desiredCount 0`; the image still on
the service is `main`-built and therefore **Mongo-backed**. Scaling up before
the new image is live would let real user writes land in the store being
abandoned, *after* the copy has already read it — and the copy is not
incremental, so nothing recovers them. **Downtime is acceptable here; losing
writes is not.** Keeping the service at zero for the whole window is what
prevents that, and the opt-in is what lets the deploy proceed anyway.

It **names the service** rather than being a boolean, for the same reason
`--confirm-truncate` names the database: a bare `true` pasted out of a runbook
authorises a zero-count deploy of anything.

**Bring the service back up only AFTER the rollout has completed** — this is the
step that ends the outage, and it must not be moved earlier:

```bash
aws ecs update-service --cluster oxy-cluster --service mention --desired-count 2
```

If a rollback happens instead, note that `rollback_service` reuses the
`desiredCount` it captured at the start rather than assuming 2 — so a rollback
during a zero-count deploy restores zero, and this same command is still what
brings the service back.

### 3.4a The one thing in the deploy that can block the window

**The flip deploy still runs a Mongo one-shot, and it runs it minutes after the
copy streamed 3.2 million documents out of that same Mongo.** This is the only
step in the sequence whose failure leaves the service stopped and the flip
un-applied, so know it before you meet it.

What runs: `src/migrations/task.ts` — connect to Mongo, then
`assertMongoTransactionalTopology()`, then the 25 (all already applied, all
skipped), then the blocked-domain reconciliation.

The bounds, read from the code rather than guessed:

- Server selection is **20s** (`MONGODB_SERVER_SELECTION_TIMEOUT_MS`, default
  `20_000`), so an unreachable or still-electing primary fails fast.
- The topology assertion is a single `db.admin().command({ hello: 1 })` — a
  cheap state read, not `replSetGetStatus` and not a data scan.
- That one-shot sets `socketTimeoutMS: 60 * 1000`. **A connection that succeeds
  and then stalls mid-command burns a minute inside the window** before failing,
  against a deploy-helper task deadline of 20. It was 15 minutes until this risk
  was written down: the long timeout existed for index builds and bounded
  backfills, and this task no longer does either — all 25 migrations skip and the
  only live payload is Postgres-only. The 60s does not truncate the lease wait,
  which is 60 seconds of 500 ms polls rather than one long operation.

**If it fails, the deploy exits before `update-service`.** That is by design
(`deploy-ecs-image.sh` stops the release when a migration one-shot fails), and it
means: the copy is done, Postgres holds the data, the Postgres migration one-shot
already succeeded — and the service is still stopped on the old task definition.

What to do, in order:

1. **Do not re-run the copy.** It completed; re-running is not the problem and
   `assertTargetsEmpty` will refuse it anyway.
2. **Re-run the deploy.** Everything in it is idempotent: the Postgres
   migrations skip, the 25 Mongo migrations skip, only the topology assertion
   and the reconciliation re-execute.
3. **Check whether a migration task is still running before re-running.** The
   deploy warns about this explicitly because the deploy role cannot call
   `ecs:StopTask` — a task left running against the database is the one thing
   that makes a second attempt unsafe to start blindly.
   `aws ecs list-tasks --cluster oxy-cluster --family oxy-mention --desired-status RUNNING`
4. **If Mongo itself is degraded, prefer §4 (rollback) over pushing through.**
   Mongo is still the rollback target; a Mongo that cannot answer `hello` is a
   reason to stop, not a reason to retry harder.

**This risk exists for exactly ONE deploy.** #83 removes the Mongo connection,
the topology assertion and the 25 migrations, keeping the blocked-domain
reconciliation as a Postgres-only step — and it is deliberately scheduled AFTER
the cutover, so this deploy is the last one that carries it.

### 3.4b Two EXPECTED conditions — do not diagnose these as defects

Both are known, both look like corruption to a completeness check, and both will
be met by someone under time pressure who did not write them down.

**(a) 834 posts will have no `post_authorships` row. This is correct.**

Measured 2026-08-03 09:55Z against 594,889 posts — **a reading at a timestamp,
not a constant; re-measure it.** These posts carry no `authorship` array in
Mongo. In Postgres authorship is a separate table, so the copy faithfully
produces 834 posts with no child row, and any "every post has an author" check
will flag exactly 834.

It is **pre-existing, not caused by the migration**: the leak was closed
2026-07-07, all 834 are federated, **no local user is affected**, and 567 of the
834 are recoverable by a later backfill (#78). **It is not a rollback trigger.**
A completeness check reporting 834 is reporting the state of Mongo, faithfully
carried.

**(b) Collaborative posts will begin federating. This is new behaviour, and it is
the intended behaviour.**

`maybeFederateOnResolve` fans a collaborative post out to the fediverse once the
last invite resolves. **That path has been dead since it shipped:** it gates on
`metadata.collabFederationDeferred`, which `PostMetadataSchema` never declared,
so Mongoose strict mode discarded it on every save and the gate has always read
`undefined`. The flag reached the database zero times across 597,109 posts.

Postgres has it as a real column (`metadata_collab_federation_deferred`), so
**the gate starts working the moment we flip** — unscheduled, on outbound
federation. Expect first-time outbound `Create(Note)` activity for collaborative
posts.

Nothing about this duplicates existing content: the guard that prevents a second
delivery (`metadata.federationDelivered`) was dead in the same way and starts
working at the same moment. They fail and recover together.

**There is no retro-federation backlog, and this is a property of the default
rather than a decision anyone made** — so it is worth stating before somebody
changes the default. Both columns are `NOT NULL DEFAULT false`, the fields are
absent on every Mongo post, so **every backfilled row lands `false`** and no
pre-cutover post fans out. Only posts created after the flip carry a `true`.
Confirm with the two counts in §2.1.

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

> **HOST-LEVEL ACCESS TO `oxy-mongo` IS BROKEN. READ THIS BEFORE THE WINDOW
> OPENS, NOT DURING IT.**
>
> The root volume is **100% full**, and SSM returns **success-shaped nothing** —
> a command that appears to succeed and produces no output. That is the worst
> possible failure mode for a diagnostic path: it is indistinguishable from
> "nothing to report".
>
> **Why this matters more than it looks: Mongo is the rollback target for the
> entire window.** The rollback below is only cheap because Mongo is untouched
> and healthy — and right now nobody can log in to check that claim by hand.
>
> - **Database-level access still works**, and everything this runbook needs at
>   the DB level (§2.1, the row counts, the rollback itself) goes through it.
> - **Host-level diagnosis is unavailable** until the disk is cleared. If the
>   window needs it — disk, memory, process state, logs on the box — there is
>   currently **no working path**.
> - Cause and fix are recorded in `oxy-infra/docs/runbooks/10-mongo-restore.md`,
>   which also carries the working DB-access path. The fix is small (a dead
>   container's 13GB log), but **it must be done before the window, not
>   discovered inside it**.

**Mongo is untouched and authoritative throughout.** The copy only reads it, by
construction (`mongoSource.ts` hands out a Proxy that throws on anything but a
read). So rollback is redeploying the pre-cutover image; no data is restored,
because none was moved out of Mongo.

Use the revision you re-derived in §0 — NOT the one written below, which is the
example that has already gone stale twice:

```bash
aws ecs update-service --cluster oxy-cluster --service mention \
  --task-definition oxy-mention:<REVISION FROM §0> --desired-count 2 --force-new-deployment
```

Then confirm the running tasks carry the pinned digest — not the tag:

```bash
aws ecs describe-services --cluster oxy-cluster --services mention \
  --query 'services[0].taskDefinition'
```

That pre-cutover revision already carries `DATABASE_URL` from
`/oxy/mention/DATABASE_URL` and ignores it, so the rollback needs no secret
changes.

**Postgres is left populated.** That is intentional and harmless — nothing reads
it once the old image is back. A second attempt must then either resume from the
checkpoints or be run against a freshly recreated database; it must NOT be a
fresh run into the populated one (`assertTargetsEmpty` will refuse it, correctly).

---

## 5. The parked-file re-port

Some files were deliberately parked rather than re-ported, to be done in one
pass when `main` goes quiet. Two things about it belong here rather than in a
task description.

### 5.0 THE TRAP — read before touching `PostHydrationService.ts`

**Dropping main's Mongoose imports from `services/PostHydrationService.ts` also
drops `disclosesWriters` — the only place the `kind === 'channel'` check lives.**

Without it, writer disclosure falls back to the settings row alone. **A settings
row is not consent.** `UserSettings.channel.signPosts` is keyed on the CHANNEL's
account, and the disclosure decision is supposed to fail closed at three
independent points, of which the account-kind check is one.

**Getting this wrong de-anonymises every channel writer** — it publishes the
human behind each anonymous channel post. It is silent, it is not a crash, and
no test currently fails on it. Treat any diff that removes an import from that
file as touching a safety control until proven otherwise.

### 5.1 Step 0 is `git merge-tree`, before any worktree exists

```bash
git merge-tree --write-tree <trunk> <main>
```

Free, needs no checkout, no worktree, and no branch — and it gives the **real**
conflict surface rather than a remembered one.

**Conflict-vs-clean is a property of DRIFT, not of the files.** Any per-file
list in this document or a task is a reading with a timestamp, and `main` has
been taking roughly ten commits an hour. **Re-measure with the command above
rather than trusting a list**, and note that a clean merge is not automatically
the right merge — see #102, where git merges cleanly and the result is wrong.

---

## 6. Open items — read before scheduling

- **`--skip-audit` was CANCELLED, not deferred.** The audit stays inside the
  window; budget ~86 minutes end to end. See §2.0 for why it reversed — this is
  a decision with a reason, not a missing feature. (#76)
- **~47% of the `posts` copy time is unattributed.** It is a remainder from
  subtraction, not a measured component, and it must not be quoted as one. (#86)
- **`src/migrations/task.ts` runs 25 Mongo migrations inside the production
  deploy**, and it is what makes `purgeBlockedDomainContent` production-reachable.
  Mongo cannot be decommissioned until it is retired — but it does not block this
  cutover, because Mongo keeps running through it. (#83)
- **Readiness now gates on Postgres — CLOSED (#89), ships in the flip deploy.**
  `/health/ready` and the legacy `/` both require a real `select 1`
  (`checkPostgresHealth`), not a pool-exists check, because a pool object
  survives exactly the failure being caught. Before this, Postgres was not
  checked at all and a task whose database had become unreachable kept reporting
  ready and kept taking traffic. Mongo stays in the gate while Mongo runs;
  removing it is decommission work (#82) and must not be forgotten, because
  `isDatabaseConnected()` pins readiness false forever once Mongo is off.
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
  cutover blocker, needs its own backfill. **Expected in-window — see §3.4b(a)
  before treating a completeness check's 834 as corruption.** (#78)
- **`oxy-mongo` host access is broken** — root volume 100% full, SSM
  success-shaped nothing. **Fix before the window**; Mongo is the rollback
  target. Full detail in the §4 banner. (#104)
- **A failed copy writes no resolution log.** `persistResolutionLog` runs only
  after the copy returns, so the audit trail is empty for exactly the runs that
  need it most. (#79)
