# Mongo → Postgres cutover (historical)

Mention ran on MongoDB until August 2026 and now runs on PostgreSQL only. This
file used to be the 3am runbook for the switch. **The switch is done, the
machinery it drove has been deleted, and none of the commands it carried can be
run against this tree any more**, so what is left here is a short account of
what happened and where to look for the detail.

## What happened

- The application schema moved to PostgreSQL, expressed as Drizzle tables under
  `packages/backend/src/db/schema/` and applied from `drizzle/` by
  `packages/backend/src/db/migrate.ts`.
- The cutover itself landed as PR #663 (`cutover: flip Mention to PostgreSQL`,
  merged 2026-08-05). The copy moved 4,989,522 rows across 58 collections from
  3,246,360 source documents; the in-window total was about 105 minutes,
  dominated by the copy and a source-to-target verification pass.
- Two guards shipped with it and are still live: the deploy refuses a rollout
  when Postgres is empty (PR #650, floor corrected in PR #652,
  `packages/backend/src/scripts/assertPostgresPopulated.ts`), and a task refuses
  readiness unless the deploy's migration one-shot has brought the schema
  current (`packages/backend/src/db/migrationsFolder.ts`).
- Mongo was then removed in stages: the web task stopped opening it and it left
  the readiness gate (PR #667), the unused models and scripts went (PR #678),
  the local Compose stack was repointed at Postgres (PR #689), and the backfill
  copier, the remaining Mongoose models, the index manifest, the `mongoose` and
  `mongodb-memory-server` dependencies and every `MONGODB_*` config binding were
  deleted under issue #706. Nothing in this repository opens Mongo.

## What to know now

- Per-table conventions for the Postgres schema live in
  [`packages/backend/src/db/schema/CONVENTIONS.md`](../packages/backend/src/db/schema/CONVENTIONS.md).
  Read that, not this file, before adding a table or a column.
- The 24-hex ids in `text` id columns are ported Mongo ObjectIds. New rows get
  uuid v7. The two spaces interleave under text collation, which is why no
  chronological query may order or page by id — see the id helpers in the
  external `@oxyhq/db` package (not a file in this repo) and
  `mtn/feed/CursorBuilder.ts`.
- PostGIS is a privileged prerequisite on any NEW database: the application role
  cannot install it even on a database it owns, so a fresh target needs an
  `rds_superuser` to run `CREATE EXTENSION postgis;` once or the first migration
  fails on `type "geography" does not exist`.
- One data item was carried across rather than fixed: a few hundred posts have
  no `authorship` row (834 as of 2026-08-03, a reading and not a constant).
  Pre-existing in Mongo, faithfully copied, still awaiting its own backfill.

## Where the detail went

The runbook's step-by-step sequence, the rehearsal measurements, the copier's
resolution-log design and the verifier's known defects are in git history, along
with the code they described. `git log --diff-filter=D -- packages/backend/src/db/backfill`
finds the copier; `git log --follow -- docs/MONGO-TO-POSTGRES-CUTOVER.md` finds
every revision of this page, including the full runbook as it stood at the
window.
