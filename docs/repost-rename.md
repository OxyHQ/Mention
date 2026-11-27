# The boost -> repost rename in storage

"Boost" is being freed up for the paid feature (`docs/boost.md`); until now it
meant _repost_ in code, on the wire and in the database. Code and wire names moved
first; this is the storage half. It runs as expand / contract, so a deploy that
rolls (old and new pods side by side) never meets a name it cannot read.

## Status

The storage columns are done: expand (0126-0128), backfill, validation and indexes (0129-0131),
switch of every read and write, and contract (0132-0134, which drop the old columns, their sync
triggers and the old indexes, and give the `_v2` indexes back their names). What remains is the
stored VALUE `'boost'` of `posts.type`, `notifications.type`, `feed_interactions.event` and the
federation import reasons, which are renamed the same way (widen the CHECK, write the new value,
backfill, narrow).

## The stored value `'boost'` -> `'repost'`

`posts.type`, `notifications.type`, `feed_interactions.event` and the federation import reasons
(`boost_dependency`) hold the old word, and so do the payloads clients read. The owner chose a clean cut,
done in three releases so a rolling deploy never meets a value it rejects:

1. **Tolerate** (this release): every CHECK, the two trigger functions that hardcode the value and a
   new unique index accept both names, and every reader goes through `REPOST_TYPE_VALUES` /
   `isRepostType` (shared) or `typeIsRepost` (queries). Nothing writes `'repost'` yet.
2. **Write** (this release): the enums flip to `'repost'`, writers and the wire emit it, the stored rows are copied by a
   resumable backfill. Native apps older than the release that understands `'repost'` show reposts
   badly until they update.
3. **Narrow**: the old value leaves the CHECKs, the list, the readers and the old unique index.

## What people read

The words people read were renamed too: the profile tab, the notification, the counters, the empty states, the
settings and the Insights labels say "repost" in every language (they said boost, impulso, продвижение or
ブースト in twelve of the fifteen). Where a statistics payload still calls the counter `boosts` the label alone
is mapped. The URLs `/@name/boosts` and `/p/:id/boost` redirect to `/reposts`. "Boost" is left to the paid feature.

## Phases

1. **Expand** (migration 0126). `posts` gains `repost_of`, `stats_reposts_count`,
   `stats_federated_reposts_count` and `metadata_is_reposted`. The trigger
   `posts_sync_repost_columns` keeps each old/new pair equal whichever name a
   writer used. The foreign key is added `NOT VALID`.
2. **Backfill.** `backfillRepostColumns` copies the old columns of rows older than
   the trigger into the new ones, in short transactions, touching only rows whose
   pair differs.
3. **Validate** the foreign key (a migration of its own, nothing else in it) and
   build the new indexes `CONCURRENTLY` out of band, as `MIGRATION-CONTRACT.md`
   requires for an index on a hot table.
4. **Switch.** Code reads and writes the new names only; the old columns are
   still there and still kept equal by the trigger.
5. **Contract.** Once nothing reads the old names: drop the old columns, indexes
   and the trigger (`deploy-phase=post`).

## The smaller tables

Migrations 0127 and 0128 add the twin columns for `author_post_counts.reposts_count`,
`user_behavior_authors.reposts`, `custom_feeds.include_reposts`,
`blocked_domain_purge_runs.removed_reposts`, `blocked_domain_purges.measured_reposts`
and `user_settings.notify_reposts` (`user_settings` is hot, so alone in 0128), each with
a trigger that keeps the pair equal. The tables with a few thousand rows are copied inside
the migration; `author_post_counts` is copied by the backfill. At the contract step the
two blocklist tables need their `CHECK` constraints re-stated over the new columns before
the old ones are dropped.

## Running the backfill

After the deploy that carries 0126:

```
bun packages/backend/dist/src/scripts/backfillRepostColumns.js --dry-run
CONFIRM_ADMIN_MUTATION=backfillRepostColumns bun packages/backend/dist/src/scripts/backfillRepostColumns.js
```

It is idempotent: a second run over a finished corpus writes nothing.

## Running the value backfill

`backfillRepostValues` (`--dry-run` first, then `CONFIRM_ADMIN_MUTATION=backfillRepostValues`,
optionally `--shard=k/N`) is IO-bound on the shared instance, so its CLI run, like the other corpus
backfills (`backfillPostHashtags`, `backfillPostHasLinks`, `backfillFederatedRepostCounts`,
`backfillVariantPostCreatedAt`, `backfillUpstreamPostKeys`, and the window alone for
`backfillPostLanguages`), goes through `scripts/lib/backfillThrottle.ts`. Batches run only inside an
off-peak UTC window, `BACKFILL_WINDOW_UTC=01-07` by default (`HH-HH`, may wrap midnight, e.g. `22-04`;
`always` turns the window off and logs a warning); outside it the task sleeps until the window opens.
Each batch is timed against the median of the first five: one slower than `BACKFILL_SLOW_FACTOR`
(default 2) times that, or than `BACKFILL_SLOW_BATCH_MS` (default 60000), backs off from 15 s,
doubling up to `BACKFILL_BACKOFF_MAX_MS` (default 300000). After `BACKFILL_MAX_SLOW_BATCHES`
(default 10) slow batches in a row the run stops with exit code 75 and records its cursor in
`admin_script_cursors` (script `backfillRepostValues`, scope `throttle-stop:<table>`, with
`/<k>of<N>` for a shard); `--table=<table> --after=<cursor>` (plus the same `--shard`) resumes that
table there. Re-running from the start is also safe, only slower.
