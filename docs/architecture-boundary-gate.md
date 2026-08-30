# The architecture boundary gate

`scripts/validate-architecture-boundaries.mjs` enforces two dependency
directions in `packages/backend`. It runs as `bun run
validate:architecture-boundaries`, which also runs its mutation self-test
`scripts/test-validate-architecture-boundaries.mjs`, and is part of
`check:workspace`.

| | Rule 1 | Rule 2 |
| --- | --- | --- |
| Forbids | product code importing a federation protocol's internal modules | `src/routes/**`, `src/controllers/**`, `src/mtn/controllers/**` importing `src/db/**` |
| Allowed instead | the connector class, or `@oxyhq/federation`'s `NetworkConnector` | route/controller → service → repository |
| Baseline | `BASELINE`, keyed on (file, protocol) | `LAYER_BASELINE`, keyed on (file, db area) |
| Size at landing | 10 entries / 17 crossings | 88 entries / 110 crossings |

Both rules are **default-deny with a shrink-only baseline**: an unlisted
crossing fails immediately, and a listed crossing that no longer exists also
fails, until its entry is deleted. A fix therefore cannot rot into a permission
nobody re-examines.

## Rule 2: the four decisions

**Type-only imports are allowed outright, not baselined.** `import type
{ PostRecord } from '../db/posts/postRecord'` is erased at compile time: it adds
nothing to the module graph and cannot execute a query. The defect the rule
exists to stop is a request handler *owning persistence behaviour*, and naming a
row shape is not that. Baselining the five such imports in the tree would also
make the shrink-only property adversarial, because the only way to "fix" one is
to duplicate the row type elsewhere. A **mixed** import still counts:
`{ insertLane, type LaneRow }` binds a value.

**The boundary is all of `src/db/`, but the message names two kinds.**
`src/db/postgres.ts` and `src/db/schema/**` are the *raw query surface* — the
connection handle and the drizzle table objects. Importing either means the
handler is authoring SQL; `schema/` looks innocuous because it is "just table
definitions", but a table object is a value, and a route holding one plus
`getDb()` is a query. That is 57 of the 88 (file, area) pairs and the sharper half.
Everything else under `src/db/` is a *repository*: the query stays where it
belongs and only the service seam is missing. Both are denied by default —
exempting `schema/` is exactly the argument that lets `getDb()` follow it in —
but the finding text tells a reader which fix is being asked for.

**`src/mtn/controllers/**` is in scope.** Rule 1's exemptions (`scripts/`,
`queue/`, `appRoutes.ts`) all share one property: not a request handler. Those
three files are request handlers — they take an `OxyAuthRequest` and a
`Response` and are mounted as Express routes. They live under `mtn/` for feature
locality, not because they are a different tier, and exempting them would leave
a directory in which a new controller could be created to dodge the rule. The
rest of `src/mtn/**` (the feed engine and its modules) is not a route/controller
tier and stays out.

**Baseline granularity is (file, db area)**, where an area is one directory
under `src/db/` or one top-level file in it. Per-file alone is too coarse:
`feed.controller.ts` would be excused for reaching into *any* db module forever,
including the `getDb()` it does not touch today. Per-imported-module is too
brittle: renaming `postRepository.ts` would fail 18 entries that describe an
unchanged fact. The area survives a rename inside `db/` while still making "this
file started writing its own SQL" — a new `src/db/postgres.ts` or
`src/db/schema/` entry — a hard failure.

## Reasons

88 entries share six reasons, defined once in `REASONS` and referenced:

- `BYPASSES_REPOSITORY` (37) — hand-written drizzle over tables that *do* have a repository.
- `REPOSITORY` (31) — calls a repository directly, skipping the service tier. Cheapest group to fix.
- `NO_REPOSITORY` (16) — hand-written drizzle over tables with no repository at all (engagement, discovery).
- `HEALTH_PROBE` (2) — imports only `checkPostgresHealth`.
- `TRANSACTION_IN_ROUTE` (1) — `src/routes/lists.ts` orchestrates `getDb().transaction(...)` itself.
- `SCHEMA_ENUM` (1) — `src/routes/trending.routes.ts` imports the `TrendingType` enum and touches no database.

## Regenerating `LAYER_BASELINE` after a merge

A merge can invalidate entries wholesale — another branch moves a controller,
renames a route, or fixes a crossing — and a stale entry hard-fails the guard.
Do not hand-edit 88 paths. Regenerate:

```bash
cd <worktree>
bun scripts/validate-architecture-boundaries.mjs --print-layer-baseline
```

That re-derives the array from the merged tree and **carries every surviving
entry's reason across unchanged**, so the diff is exactly the entries the merge
added or removed. Any genuinely new pair is emitted as
`reason: REASONS.PICK_ONE_AND_JUSTIFY_IT`, which is not a defined key and so
resolves to `undefined`; the guard rejects any entry without a reason, so a
regenerated baseline cannot be committed with the reasons left unwritten. Paste the output over the
`const LAYER_BASELINE = [ ... ];` literal, replace each placeholder with a real
reason, and re-run the guard.

`--print-layer-baseline` validates nothing and exits 0. It is never what CI
runs.

Rule 1's `BASELINE` is 10 hand-written entries and has no regenerator; edit it
directly.

## Adding a crossing on purpose

Don't, if the fix is small. If it genuinely is not, add an entry with a reason
that says what would have to change for the entry to go away. A reason generic
enough to fit any entry is not a reason.
