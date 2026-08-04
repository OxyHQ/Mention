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
   `drizzle/channels-plans` @ `1b60437b` — **535 files, 6,373 tests, ALL
   passing, zero files dead at load** — and confirmed by CI rather than by one
   machine, which is what changed (see the #124 note in §6). The local run and
   the CI run agree, including on the per-file coverage floors.

   **This supersedes the `b017809c` baseline of 504 files / 5,939 tests /
   1 failing**, and the difference is 300-odd commits, not a regression: the
   parked `closedValueSets.test.ts` › *"has no set that disagrees with the
   vocabulary Mongo holds"* failure is gone. **Anything red now is new.**

   Re-take with `bun run --cwd packages/backend test` plus
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

**That `~86` has since been superseded — the measured in-window total is
`≈105 minutes`, and §6 carries the per-step table.** It moved for two reasons,
not one: the copy drifted (72m41s), and §3.4c was added afterwards, which is a
second full pass over Mongo. **The argument above is unaffected** — the audit
stays inside the window either way; only the arithmetic changed.

Run the day-before pass anyway. It costs ~29 minutes, blocks nothing, and a
BLOCK finding found the day before is a scheduling decision rather than a
window-length crisis. Run it against the **probe**, not production: it reads
production Mongo either way, and its verdict is about the SOURCE.

```bash
aws ecs run-task --cluster oxy-cluster --launch-type FARGATE \
  --task-definition <pgaudit revision pointing at PROBE_DATABASE_URL> \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-08f5cc132b3cab15c,subnet-0bfb367f29d1fd375],securityGroups=[sg-0f0ca416eacab578c],assignPublicIp=ENABLED}' \
  --overrides '{"containerOverrides":[{"name":"mention","command":[
     "bun","packages/backend/dist/scripts/backfill-mongo-to-postgres.js",
     "--source-database=mention-production","--audit-only"]}]}'
```

**`--source-database` is REQUIRED on every mode, and the name in these commands
was taken from this document and from `resolutions.ts`, not measured against the
cluster.** It is the mirror of `--target-database`: the operator states which
Mongo database they believe `MONGODB_URI` points at, and the run refuses unless
the driver's own `db.databaseName` agrees. That closes the direction nothing
guarded — a wrong-but-connectable URI makes every collection read as empty, so
the copy writes nothing and exits 0, and `--verify-only` cannot catch it because
it reads the same URI.

**Confirm the name on this run, the day before.** If it is wrong the audit
refuses immediately and says both sides — which is the failure you want, here,
outside the window rather than inside it.

Read the log by paging `get-log-events` with `nextForwardToken` to exhaustion and
**confirm you reached the verdict banner**. `filter-log-events` truncates at
10,000 events silently, and a truncated read is indistinguishable from a clean
one.

Expected verdict (last measured, 2026-08-03): `0 finding(s) BLOCK the copy`,
FK coverage `47/47`, row cardinality `58/58`.

**That verdict did not hold in the window of 2026-08-04, and the cause is now
answered in code rather than by hand.** The copy refused with TWO BLOCK
findings — `federated_actors_acct_key` and
`federated_actors_domain_username_key` — from ONE cause: two `federatedactors`
rows for `hmans.dev@bsky.brid.gy` under two Bluesky DIDs, the same person either
side of a DID rotation, reaching us over ActivityPub through Bridgy Fed. Nothing
referenced either row (0 posts, 0 federated follows either way, 0 media cache).
`KEEP_FRESHEST_FEDERATED_ACTOR` already promised in prose that such rows are
answered by a re-key; only the `handle.invalid` sentinel was implemented, so the
code under-implemented its own documentation. **The re-key now covers the whole
property it was always described as covering** — an `acct` that does not
identify the row carrying it, whether because another `uri` claims it or because
it is the sentinel that identifies nobody — and it drops nothing. So expect the
audit to report both findings CARRYING THE RULE rather than blocking, and expect
one additional resolution record under `keep-freshest-federated-actor` naming
whichever of those two rows is not the freshest by `lastFetchedAt`.

Patching the DATA by hand instead is what NOT to do here, and it was tried and
reverted in that window. A hand edit and the rule can disagree on BOTH axes,
neither of which is visible while you are making the edit: **which row moves**
(the rule takes the one that is not the freshest by `lastFetchedAt`; by eye you
take the one that looks less real — the one with no `oxyUserId`, say — and those
are not the same question) and **what it moves to** (the rule writes the row's
whole `uri`, unique by `federated_actors_uri_key`; by eye you write the DID out
of it, which for a Mastodon-shaped URI would not be unique at all). A collision
the algorithm can answer must be answered by the algorithm, or the copy and the
report describe different databases.

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

**Scaling to zero and arming the deploy's zero-count exemption are ONE step with
two halves. Do both here, and do them BEFORE the merge in §3.4.**

```bash
aws ecs update-service --cluster oxy-cluster --service mention --desired-count 0
gh variable set ALLOW_ZERO_DESIRED_COUNT --body "mention:$(date -u -d '+2 days' +%F)"
```

**Why it must be set before the merge, not after.** The deploy has **no manual
trigger** — `deploy-aws.yml` fires on `workflow_run` when CI completes on `main`,
so merging starts it automatically about four minutes later with nobody at the
controls. `vars` is read when the deploy job runs, so setting it here (well
before §3.4) removes the race entirely. Set it after the merge and you are
betting on beating CI.

**Without it the deploy exits 1** at `deploy-ecs-image.sh`'s desiredCount
pre-check, with traffic already stopped and the copy already done — see §3.4 for
the full reasoning and the unset half.

**The value carries an EXPIRY — `mention:<YYYY-MM-DD>` — and both halves are
checked.** Give it a date a day or two out. If the window slips past it the
deploy **refuses**, loudly, and you fix it in thirty seconds by re-setting the
variable; it can never fail toward permitting. The expiry is a backstop for the
unset in §3.4 being skipped, not a replacement for it — a forgotten variable
disarms itself the day after rather than leaving this repo permanently easier to
deploy onto nothing.

**A variable left set cannot authorise anything on its own** either, which is
what makes this pairing acceptable rather than merely convenient: the script consults it
only when `desiredCount` is ALREADY 0, and that takes a deliberate scale-down. It
needs a second deliberate act to become live. Do not "clean up" the pairing on
the theory that the variable alone is the danger — it is the scale-down that
arms it, and the unset in §3.4 is what keeps the two lifetimes equal.

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
   "bun","packages/backend/dist/src/db/migrate.js","--target-database=mention"]}]}'
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

**This step now HAS a target-database guard.** `--target-database=<name>` is
REQUIRED — including for `DRY_RUN` — and is asserted against `current_database()`
as the FIRST statement on the connection, before the ledger read and before
`ensureExtensions`. The task definition is therefore no longer the only thing
deciding.

The three task definitions below still look right and are still wrong. What the
guard changes is what happens when somebody picks one: **a silent success becomes
a refusal that names both databases.** That matters here more than it does for
the copy, because this step is the one that fails success-shaped — aimed at the
wrong database the copy dies on a missing table, while the migrator finds an
empty ledger, applies the whole journal, logs `Applied 19` and exits 0, leaving
the real database untouched for the copy to write into a schema that does not
exist.

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
nothing, not even the ledger table. The guard now answers "which database am I
pointed at" on its own — and `--target-database` is required on the dry run too,
deliberately, so the rehearsal exercises the same refusal the real run does
rather than being the one mode that skips it:

```bash
--overrides '{"containerOverrides":[{"name":"mention",
   "environment":[{"name":"DRY_RUN","value":"true"}],
   "command":["bun","packages/backend/dist/src/db/migrate.js",
   "--target-database=mention"]}]}'
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

### §3.1a — PIN THE COMMIT, AND FREEZE THE TRUNK, BEFORE ANY OF THIS

**Every step below names "the image" as though there were one. Nothing here says
which commit it comes from, and the trunk takes commits continuously** — CI now
runs on it directly, so green is not a moment, it is a stream.

**Write the SHA down before §3.2 and use it everywhere:**

```bash
CUTOVER_SHA=$(git rev-parse origin/drizzle/channels-plans)
```

- **Build the image FROM that SHA**, and check the deployed task definition
  carries the tag derived from it — not `latest`, and not "the newest green
  build", which is a different artefact the moment anyone pushes.
- **Announce a freeze on the trunk for the window**, and mean it as "no pushes
  until the flip is done or rolled back" rather than as a request. The failure
  it prevents is specific: an image built at §3.2 and a rollback image resolved
  at §5 that are not the same code, discovered while deciding whether to roll
  back.
- **`journalEntries` is what makes the pin CHECKABLE rather than declared** — the
  count travels in the image, so the dry run proves which build you are holding
  before any DDL runs. That is the whole reason it is read on the two
  "nothing happened" lines.

**Why this is written down rather than assumed:** the runbook contained no word
about freezing or pinning until 2026-08-04, while simultaneously instructing a
rebuild in the middle of the window. Both are correct individually; together and
unpinned they let the window deploy something CI never saw.

Then the real run: expect `Applied 21 Postgres migration(s)` and exit 0.

> **21 as of trunk `79a3c73e` — `0000`–`0020`, verified as a SET and not a
> count.** 21 SQL files and 21 journal entries is a coincidence-shaped fact, so
> it was checked both ways: no `.sql` missing from the journal (which `migrate`
> would SKIP IN SILENCE, leaving the schema short and the first symptom a query
> failing in production after the flip), no journal entry missing its file
> (which throws, and is the benign half), `idx` contiguous `0..20`. The previous
> figure in this line was **19**, correct at `94ba6797` and wrong by two after
> `0019_atproto_graph_sync_lease` and `0020_moderation_outbox_urgency` landed.

**Re-derive that number rather than trusting this line** — the instruction
outlives the number, which is the point, and §1 records the real database as
holding no ledger, so every
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
   "--source-database=mention-production","--target-database=mention"]}]}'
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

**Budget `72m41s`, not the `65m45s` above.** That table is the REHEARSAL; the
full copy of production data ran **72m41s, exit 0, 4,989,522 rows** — about
seven minutes longer, on the real source. Budget the production reading.

The audit is inside both figures and stays there — see §2.0. `runBackfill`
always audits, and the flag that would have skipped it was cancelled rather than
left pending, so there is nothing to wait for and nothing to enable. **~36
minutes is not an option on the table**, and neither is the copy alone: §3.4c
adds another **18m18s** to the window (§6 has the full per-step table).

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

**`ALLOW_ZERO_DESIRED_COUNT` was already set to `mention:<date>` in §3.1** — it is
the second half of the scale-to-zero step, not a separate action here, and it had
to be set before this merge (see §3.1 for the race). `deploy-aws.yml` passes it
through as `${{ vars.ALLOW_ZERO_DESIRED_COUNT }}`. **Without it the deploy
refuses and exits 1** — traffic already stopped, copy already done, window
burning.

**CONFIRM DELIVERY FROM THE DEPLOY LOG, not from having run `gh variable set`.**
Whether GitHub actually hands the variable to the job is the one link in this
chain no test covers: the guard's behaviour is mutation-tested on every value,
but nothing here has ever exercised real variable delivery, and a rehearsal
deploy to production days before the window is a worse risk than the gap.

It fails in the safe direction — an undelivered variable reads as empty, and the
guard **refuses before any mutating AWS call** (measured: the pre-check exits at
`deploy-ecs-image.sh`'s desiredCount guard, well before `register-task-definition`
and `update-service`; the test asserts the mocked AWS log is empty). So the
failure is loud, early, and fixed in thirty seconds by re-setting the variable —
not a silent deploy onto zero capacity.

**Both signals are in the log. Look for one of them:**

| log line | meaning |
| --- | --- |
| `Deploying mention at desiredCount=0, authorised by ALLOW_ZERO_DESIRED_COUNT=…` | delivered; the deploy is proceeding on the exemption |
| `must have a positive desiredCount before deployment` | NOT delivered (or expired/misspelled) — re-set the variable and re-run |

The first line also names the expiry, so it doubles as the check that the window
has not outlived it.

**Confirm the deploy run actually STARTED.** This workflow is `workflow_run`-
triggered off CI, and a `workflow_run` that never fires looks identical to one
that was not needed: no run, no jobs, no alarm. Do not infer from a green merge
that a deploy began — open Actions and see it.

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
step that ends the outage, and it must not be moved earlier. **Scaling back up
and disarming the exemption are ONE step with two halves, the mirror of §3.1:**

```bash
aws ecs update-service --cluster oxy-cluster --service mention --desired-count 2
gh variable delete ALLOW_ZERO_DESIRED_COUNT
```

Leaving it set does not authorise anything by itself — the script only consults
it when `desiredCount` is already 0 — but the point of the pairing is that the
exemption's lifetime is exactly the window's. Unset it here and the next person
to scale this service to zero gets the loud refusal they should get.

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

### 3.4b Four EXPECTED conditions — do not diagnose these as defects

All four are known, all four look like corruption to a completeness check, and
all four will be met by someone under time pressure who did not write them down.

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

**(c) If you verify while anything is still writing to Mongo, the mismatches are
not data loss.**

`verifyCollection` streams the source with **no upper `_id` bound**, so any
document created after the copy read that collection is counted as a row
Postgres should hold and does not. It looks exactly like loss: a per-table count
mismatch, with real numbers.

**This is measured, not theoretical.** The referential audit hit the same shape
on 2026-08-03 and reported **407 orphans** — every one an id created inside the
run's last four minutes, every parent present in Mongo the whole time. That audit
now passes an explicit `upTo` bound for this reason; the verifier does not,
because in the window it runs against a source nothing is writing to.

So: **run §3.4c with the service at `desiredCount 0`.** If you verified early and
see mismatches, re-run the verification after the writes have stopped before
concluding anything. **A cutover rolled back over this would be a cutover rolled
back over nothing.**

**(d) A field mismatch can be POSITIONAL — the same rows, re-ranked — and no
document-count delta will ever explain it.**

The other three conditions are all arrivals or absences: something was created,
deleted, or never there. This one is neither, which is why it needs naming
separately — every value is present on both sides and every row exists; only
which row holds which value moved.

**It was demonstrated, not theorised.** The production verify reported four
`authorId` mismatches forming a **closed 4-cycle** — row A's *expected* value
was row B's *found* value, all the way round and back to A — with the
interaction counts rotating in step with them. **Same four authors, re-ranked.**

The diagnostic is the cycle itself. Sum the mismatched values on each side: if
the multiset of expected values equals the multiset of found values, nothing was
lost or gained, and you are looking at ordering, not corruption. **Do not try to
subtract it out of a count** — it does not move a count at all, in either
direction, so a completeness check that agrees exactly can still print these.

### 3.4c Verify the copy against the SOURCE

**This is the only step in the whole window that compares what Postgres holds
against what Mongo actually contains.** Everything else compares the copy with
its own account of itself — the resolution-log reconciliation checks that the
report's record count matches the rows written to the log table, and the row
counts in §3.5 are read against *the copy's own report*. Both are
self-consistency checks. Neither can see a document that never became a row.

Run it after §3.4 and before admitting anyone:

```bash
--overrides '{"containerOverrides":[{"name":"mention","command":[
   "bun","packages/backend/dist/scripts/backfill-mongo-to-postgres.js",
   "--source-database=mention-production","--verify-only","--target-database=mention"]}]}'
```

`VERIFY PASS` is the line to look for. A failure prints, per table, the row count
the transforms produced against the row count Postgres holds — and **a count
mismatch here is the signal that means the copy lost something.**

**Two costs, and both land on the window's clock:**

- **It re-reads the entire source.** The verifier recomputes what Postgres
  *should* hold by streaming every document again and re-running each plan's
  transform. Budget a second full pass over Mongo, not a quick tail check —
  **measured at `18m18s` against production data**, and it was not in the
  window's budget at all until it was.
- **It must run with the service still at `desiredCount 0`** — see §3.4b(c).
  Verify first, admit users second.

**What a PASS covers, and what it does not** — the two halves have different
reach, and a reader at 3am must not have to infer this:

- **Row counts are TOTAL.** Every document of every mapped collection, every
  table including child tables, no sampling. This is the half that answers "did
  we lose data".
- **Field fidelity is SAMPLED** — 200 documents per collection — and it compares
  only columns the transform actually supplied. A column the plan never sets is
  invisible to it by design: an omitted column is one the database default
  filled, so the transform is not claiming a value there.
- **No audit runs during the copy at all.** The column-coverage pass — the one
  that answers "which columns got filled" — runs only under `--audit-only` or
  `--start-from-empty`, and §3.4 rules the latter out on a first cutover. The
  §1 pre-flight audit is where that question is answered, and it is answered
  about the PLANS rather than about the copied rows.
- **The verifier and the copy read Mongo through the same code.** If a
  truncation cause ever lived in that shared reader, both would truncate
  identically and this step would report PASS. That limit is stated rather than
  papered over; the mitigation is that a driver-level cursor failure propagates
  as a thrown error rather than a short read, so the loud case stays loud. **Do
  not build a second reader to close this** — two readers that disagree for their
  own reasons would be worse than one whose limit is written down.

### 3.5 Verify BEFORE admitting users

Traffic is already flowing at this point (the service is up and the ALB will
route to healthy targets), so treat this as the decision point for rollback
rather than a gate you can hold traffic behind. If a check fails, §4.

- Tasks reach `RUNNING` and stay there. A boot-time refusal appears as tasks
  cycling, not as an error page.
- `.github/scripts/smoke-mention.sh` runs as part of the deploy — read its result
  rather than assuming.
- `VERIFY PASS` from §3.4c. **This is the source-to-target comparison**; the row
  counts below it are the copy's own account of itself and cannot stand in for
  it.
- Row counts in Postgres against the copy's own report. Two independent paths
  agreed to the row in rehearsal; they should again — but note this compares the
  copy against what the copy said it wrote, not against Mongo.
- One authenticated read of a real feed, and one profile.
- One federation round trip: the actor JSON at
  `https://api.mention.earth/ap/users/<user>` returns 200 with a `publicKey`
  whose id host matches the actor id host.

### 3.6 What sends us back rather than forward

- Tasks that will not stay `RUNNING`.
- The copy did not complete, or §3.4c reported a count mismatch that **survives a
  re-verify against a quiesced source** — an early verify against a live one is
  §3.4b(c), not loss.
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

**CORRECTED 2026-08-04, and the correction inverts the warning. What this
section used to say is left in place below, because a reader who remembers it
needs to know it was wrong rather than find it quietly replaced.**

**It used to say:** *"Dropping main's Mongoose imports from
`services/PostHydrationService.ts` also drops `disclosesWriters` — the only
place the `kind === 'channel'` check lives … Getting this wrong de-anonymises
every channel writer … no test currently fails on it."*

**Three things in that are false, measured against trunk `d348cc5a` and main
`366e0651`:**

1. **`disclosesWriters` is not a Mongoose import, so dropping the Mongoose
   imports does not drop it.** On main it is line 11,
   `import { disclosesWriters, loadSigningChannelIds } from './channelWriterDisclosure'`
   — a sibling SERVICE. The model imports are lines 4–10. **Someone following the
   old wording literally — dropping 4–10, keeping 11 — does the right thing and
   believes they dodged a trap that was never armed that way**, and therefore
   stops looking for the one that is actually there.
2. **The trunk is NOT missing the account-kind check**, so `disclosesWriters` is
   not "the only place it lives". `PostHydrationService.ts` on the trunk has
   `user.kind === 'channel'` in a fail-closed conjunction with
   `signingChannelIds.has(authorId)` and a writer being present, above a comment
   naming every clause, plus its own signing-set read. **A trunk-ward resolution
   therefore de-anonymises nobody.** It keeps both clauses, inline.
3. **"No test currently fails on it" was true of the trunk alone.** Main's
   `__tests__/services/channelWriterDisclosure.test.ts` covers `disclosesWriters`
   for `personal`/`organization`/`project`/`bot`, an unknown kind and an
   unresolvable account; drop the kind clause and those go red. Absorbing main
   closes the gap the old text described as open.

**THE HAZARD THE OLD TEXT MISSED ENTIRELY, which is the real one.** Both sides
implement both clauses — correctly, and independently. The trunk's port
faithfully rebuilt the inline read that main's `c23934ab` had refactored OUT into
`services/channelWriterDisclosure.ts`, which exists precisely because **two
surfaces ask this question** (the post byline and the channel's writers list)
**and two implementations of a consent gate is how they come to disagree.** The
risk is not a missing check — it is **TWO consent readers that can drift**, in a
decision where drift in one direction is unrecoverable: a name published without
consent cannot be un-published by a later request that gets it right.

**So the resolution is main's STRUCTURE on the trunk's STORE** — delegate to
`loadSigningChannelIds`/`disclosesWriters`, delete the trunk's inline block — and
**what a reviewer must check is the ONE-READER property, not the presence of a
`kind` check.** Both sides pass a `kind`-check inspection; only one of them
leaves a single reader. The gate is the `signPosts has exactly one reader`
source scan in that test file, which fails while a second reader exists.

**Field name:** the port renamed it. It is `channelAccount.signPosts` (column
`user_settings.channel_account_sign_posts`), not `UserSettings.channel.signPosts`.
The column is NULLABLE and `NULL` means "not a channel", which is why the read is
`=== true` rather than truthy.

**What survives from the old warning:** a diff to this file's imports IS worth
treating as touching a safety control until proven otherwise — just not for the
reason originally given.

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

- **THE DATA HALF IS CLOSED. The source-to-target comparison has been run
  against production data, and every discrepancy is accounted for
  individually** — a claim this runbook has never been able to make before.
  - **Copy:** exit 0, **72m41s**, **4,989,522 rows** across 58 collections from
    3,246,360 documents. Resolution log **2438 written == 2438 claimed**, and
    written **per level** rather than flushed at the end (#79, closed below).
  - **Verify, second run, with the ids named:** **49 missing rows, all
    explained, none of them loss.** **Zero of the 49 predate the copy's start** —
    every one carries an embedded ObjectId timestamp *later* than the moment the
    copy read its collection, and **46 were minted after the copy had finished
    entirely**. 44 of them are **child** rows from the largest collection — old
    parent documents whose field arrays grew — and that collection's primary
    table, `federated_actors`, has **zero** missing rows.
  - **Read the reach as carefully as the result.** Row COUNTS are total, every
    document, no sampling. The **named missing rows are sample-bounded** — the
    200-document limit applies to that check too, not only to field fidelity
    (see the verifier defects below) — so "49, all explained" is 49 of what the
    check could see, and no missing row was a primary row from a collection
    larger than the sample.
  - **This closes the DATA question, not the window.** The two items directly
    below still decide whether a date can be picked at all.
- **~~CI HAS NEVER RUN ON THIS TRUNK~~ — CLOSED 2026-08-04, and the fix removed
  the failure mode rather than the instance. (#124)** `ci.yml` now lists
  `drizzle/channels-plans` under `push:`, so the trunk is checked **independent
  of PR mergeability**, and `main` is fully absorbed besides. First verdict on
  the 330-odd commits: **535 files, 6,373 tests, all green**, plus typecheck,
  lint, lockfile, mcp, shared-types, frontend and the bundle budget.

  **Keep the diagnosis, because it recurs and it is silent.** A `pull_request`
  run builds `refs/pull/N/merge`, which GitHub cannot create while the PR
  conflicts — so **every time `main` lands a commit touching anything this trunk
  touches, every push here dispatches NOTHING.** Not a failure, not a queued run:
  no run, and the checks page is indistinguishable from a branch nobody pushed
  to. Measured that day: four consecutive trunk pushes carrying five merged fixes
  produced zero runs across an hour, and the silence was reported as "CI is
  running" four times before anyone ran `gh run list`. Same shape as the
  `workflow_run` trap in §3.4 — nothing having run looks exactly like nothing
  needing to run.

  **Two safety facts checked before that trigger was added, and worth re-checking
  if anyone touches it:** all three deploy workflows fire on `workflow_run` with
  `branches: [main]`, so a green run on this branch **cannot** deploy it; and
  `concurrency.group` keys on `github.ref`, so trunk runs share no lane with
  `main`'s. **Remove the entry when this branch is deleted** — it is the only
  branch-specific line in that file.

  **One asymmetry to know:** `Frontend bundle budget` is gated to
  `pull_request`, so it does not run on a push. Green-on-push is therefore weaker
  than green-on-PR for the bundle specifically. Immaterial while no frontend file
  changes; if frontend work lands here, get a PR run or measure locally.

- **MERGING THIS TRUNK TO `main` PERFORMS THE CUTOVER — green CI does not change
  that.** `merge → CI on main → green → deploy-aws` (its only conditions are
  `conclusion == 'success'` and `head_branch == 'main'`) → ECS runs the Postgres
  backend against production traffic, and `connectPostgres` throws when
  `DATABASE_URL` is unset. **No human step exists anywhere in that chain.** This
  is called out because `AGENTS.md` says *"Green CI = merge to main… don't park
  it for separate manual review"* — correct for every other PR in this repo and
  exactly wrong here. PR #636 is held as a **draft**, which is the mechanism;
  its title states the consequence rather than a temporary blocker, because a
  guard defended by a reason that expires is a guard somebody removes.
- **`oxy-mongo` host access is broken** — root volume 100% full, SSM
  success-shaped nothing. **Fix before the window**; Mongo is the rollback
  target. Full detail in the §4 banner. (#104)
- **A background wrapper reports the WRAPPER's fate, never the job's — confirm
  by PID.** Every long step here invites a `nohup … &` launcher or a watcher
  loop, and both lie in the same direction: an `exit 0` is the launcher exiting,
  not the run succeeding, and a kill notification names neither, so **a killed
  wrapper and a killed watcher are indistinguishable from the notification
  alone**. Confirm which process died by PID, and confirm the JOB from its own
  log or its ECS task status. Same family as the `workflow_run` item above: the
  absence of the signal you wanted looks exactly like the good case.
- **The window budget is now MEASURED, and it is ~105 minutes, not ~86.** Every
  term below is a stopwatch reading from the full production run, not an
  estimate:

  | step | measured |
  |---|---|
  | §2 pre-flight audit (day before, outside the window) | 36m48s |
  | §3.2 migrate the real database | ~1 min |
  | §3.3 copy, audit inside | **72m41s** |
  | §3.4c verify | **18m18s** |
  | §3.4 deploy + rollout | ~13 min |
  | **in-window total** | **≈105 min** |

  **`~86` was stale in TWO terms, and both need saying.** The copy drifted about
  seven minutes on its own (72m41s against the rehearsal table's 65m45s) — and
  **§3.4c did not exist when `~86` was written**, so that figure omitted a
  second full pass over Mongo entirely. A budget can be wrong because a number
  moved *and* because a step was added; correcting only the first would have
  produced `~93` and a window that still ran over. §2.0 and §3.3 carry the
  earlier figures with a pointer here.
- **The verifier has four known defects. One is fixed, one is filed, two are
  live and you will meet them in the output.**
  1. **The missing-row ids were discarded** — the report held every
     `table:rowId` and printed only the length, which made the single number
     that can mean data loss unactionable. **FIXED on the trunk at `5c93f2d7`**;
     without it, tonight's "49, all explained" would have been "49" and
     unanswerable.
  2. **The 200-document sample bounds the MISSING-ROW check, not just field
     fidelity.** `verifyCollection` only queues a row for the existence probe
     while `documentsSampled < sample`, so on any collection larger than 200
     documents the named missing rows are a sample, while the row COUNTS beside
     them are total. Two different reaches in one report.
  3. **jsonb key-order false positives — a normalisation that stops one level
     short, not an absent one.** `comparable()` documents "arrays and objects to
     sorted JSON" and delivers it for objects (`stableJson`, which sorts at
     every level) but renders a top-level ARRAY with a plain `JSON.stringify`,
     so object keys nested inside array elements keep their original order and
     diff. **87 mismatches in both runs — count-stable, which is itself the
     signature**: churn moves, a rendering bug does not. `stableJson` already
     recurses through arrays correctly, so the fix is that one call.
  4. **The FAILURE path prints no vacuity figures. (#137)** `documentsSampled`
     and `columnsCompared` appear only on the PASS branch, so a failing run
     hands you mismatches with **no denominator** — you cannot tell a run that
     compared everything and found problems from one that compared almost
     nothing.
- **Bun vs Node — CLOSED, and the METHOD is the part worth keeping.** The trunk's
  suite was baselined under Bun; the images run Bun but the `test` script names
  Node, so the two runtimes had never been compared. They agree exactly: **506
  files / 5965 tests / 0 failures** under Node, identical to the Bun baseline.
  Three things made that answer trustworthy, and each one had already produced a
  wrong answer first:
  - **A linked worktree has no `node_modules` of its own**, and
    `packages/backend`'s `test` script resolves vitest through a relative
    `../../node_modules/vitest/vitest.mjs` — so in a worktree the real tree sits
    outside vitest's `root` and transitive ESM imports fail (`Cannot find
    package '@oxyhq/contracts'`). That is the harness, not the code. Symlink the
    repo's `node_modules` into the worktree.
  - **`bunx vitest` silently substitutes the Bun runtime**; it and `node
    …/vitest.mjs run` look interchangeable and are not. Whichever you meant to
    measure, you may have measured the other.
  - **Prove the runtime from INSIDE a worker.** vitest swallows `console.log`
    from within a test, `--silent=false` included, so have the test WRITE
    `process.version` to a file. Anything else is the runtime you believe you
    launched, not the one that ran.
- **`--skip-audit` was CANCELLED, not deferred.** The audit stays inside the
  window. See §2.0 for why it reversed — this is a decision with a reason, not a
  missing feature. (Its "budget ~86 minutes" figure is stale; see the budget
  item above.) (#76)
- **#86 stays DECLINED, and the premise changed without changing the answer.**
  The transform-side speedup on the `posts` copy is still not being taken, and
  the reason is now stronger than the original one. §3.4c's verify re-runs
  `transformDocument` per source document (`verifyCollection`), so the transform
  is no longer just the copy's hot path — **it is what the data-loss check
  derives its expected row counts FROM.** Narrowing it for minutes would narrow
  the check that would have to catch the narrowing, trading acceptable downtime
  for unacceptable risk. Unchanged: the `~47%` unattributed figure is a
  remainder from subtraction, not a measured component, and must not be quoted
  as one. (#86)
- **PostGIS is a PRIVILEGED prerequisite, and production already has it** —
  `spatial_ref_sys` owner `rdsadmin`, measured (§1.1). It is listed here because
  of what it costs when it is absent: the `mention` role **cannot install it on
  a database it owns**, so any NEW target — a fresh probe, a second rehearsal
  database — needs an `rds_superuser` to run `CREATE EXTENSION postgis;` once,
  or migration `0000` dies on `type "geography" does not exist`. That is a
  dependency on somebody else's credential, which makes it a scheduling input
  rather than a step you can take mid-window. Check it as a fact; do not assume
  it from this line. (#80)
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
- **A failed copy writing no resolution log — CLOSED (#79).** It used to be
  flushed once, after the copy returned, so the audit trail was empty for
  exactly the runs that needed it most. It is now written **per level**, and the
  full production run reconciled **2438 written == 2438 claimed**.
