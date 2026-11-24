# The boost -> repost rename in storage

"Boost" is being freed up for the paid feature (`docs/boost.md`); until now it
meant _repost_ in code, on the wire and in the database. Code and wire names moved
first; this is the storage half. It runs as expand / contract, so a deploy that
rolls (old and new pods side by side) never meets a name it cannot read.

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
