-- One NATIVE boost per account per post — the constraint that makes "have you
-- already boosted this?" answerable.
--
-- WHY: `feed.controller` reads for an existing boost and then inserts, with
-- nothing between the two, so two concurrent boosts both read "no" and both
-- insert. Nothing downstream copes with the second row: unboost deletes ONE and
-- leaves the other, so the user unboosts and the boost is still there, and
-- `stats.boosts_count` drifts by however many duplicates were made. The read
-- cannot be made authoritative by ordering it better or by locking a row that
-- does not exist yet — only an index can be the authority, so the read is now an
-- optimisation and this is the rule. The insert catches this constraint by NAME
-- and answers the same 400 the read would have.
--
-- `federation_activity_id is null` IS THE LOAD-BEARING HALF, and the first
-- version of this migration left it out. A federated boost is a MIRROR of a
-- remote actor's Announce, deduped by the Announce's own id
-- (`posts_federation_activity_id_key`) because that is the only identity a
-- remote instance guarantees. Mastodon's unboost-then-reboost emits a NEW
-- Announce id, so when the intervening `Undo(Announce)` never arrives — an
-- ordinary federation failure — two rows for one (actor, original) is the
-- CORRECT state. The wider index rejected that insert with SQLSTATE 23505 inside
-- the BullMQ inbox worker, which would have retried it forever.
-- `backfillFederatedBoostCounts.test.ts` (two Announces from one booster) went
-- red and was right to. So this constrains Mention's OWN boost action, which is
-- the only one Mention decides.
--
-- `type = 'boost'` and `boost_of is not null` narrow it further: `boost_of` is
-- NULL on every other post and Postgres treats NULLs as distinct, so those two
-- would hold by accident. Stating them says what the rule IS, and keeps the
-- index the size of the native-boost set rather than of the table.
--
-- THIS MIGRATION REFUSES TO RUN ON DATA THAT ALREADY VIOLATES IT, on purpose.
-- Creating the index straight away fails with `Key (oxy_user_id, boost_of)=(…)
-- is duplicated` — one example pair, no count, no repair instruction, discovered
-- in the middle of a cutover. The block below fails FIRST, says how many pairs
-- are duplicated and how many rows that is, and names the repair. Repairing
-- means keeping the OLDEST boost per pair (it is the one whose federation and
-- counters already happened) and deleting the rest:
--
--   delete from posts p using (
--     select oxy_user_id, boost_of, min(created_at) as keep_at
--     from posts
--     where type = 'boost' and boost_of is not null
--       and federation_activity_id is null
--     group by 1, 2 having count(*) > 1
--   ) d
--   where p.type = 'boost' and p.federation_activity_id is null
--     and p.oxy_user_id = d.oxy_user_id
--     and p.boost_of = d.boost_of and p.created_at > d.keep_at;
--
-- then recomputing `stats.boosts_count` for the affected originals with
-- `scripts/recomputeFederatedEngagement.ts`, and re-running this migration. That
-- deletion is NOT performed here: removing rows is a data decision, and a DDL
-- migration is the wrong place to make one silently.
--
-- STATUS AT WRITING: every database reachable from the workstation this was
-- written on carries zero duplicates — and all of them are EMPTY (one post
-- between `mention-development`, `mention-dev` and Postgres `mention_dev`), so
-- that number establishes nothing about production. The production count is an
-- OUTSTANDING PREREQUISITE. Run against production Mongo before the cutover:
--
--   db.posts.aggregate([
--     { $match: { type: 'boost', boostOf: { $ne: null },
--                 'federation.activityId': null } },
--     { $group: { _id: { u: '$oxyUserId', b: '$boostOf' }, n: { $sum: 1 } } },
--     { $match: { n: { $gt: 1 } } },
--     { $count: 'duplicateGroups' },
--   ])
--
-- The block below makes discovering it late loud rather than cryptic; it does
-- not make discovering it late acceptable.
--
-- NOT online. `CREATE INDEX CONCURRENTLY` cannot run inside the migrator's
-- transaction, and it would also defeat the preflight — a concurrent build fails
-- asynchronously and leaves an INVALID index behind. If `posts` grows to where
-- the exclusive lock matters, split this into a repair migration plus a
-- concurrent build run outside the migrator.

do $$
declare
  duplicate_groups bigint;
  duplicate_rows bigint;
begin
  select count(*), coalesce(sum(n - 1), 0)
    into duplicate_groups, duplicate_rows
  from (
    select count(*) as n
    from posts
    where type = 'boost'
      and boost_of is not null
      and federation_activity_id is null
    group by oxy_user_id, boost_of
    having count(*) > 1
  ) d;

  if duplicate_groups > 0 then
    raise exception using
      message = format(
        'posts already contains %s (account, boosted post) pairs with more than one NATIVE boost, %s rows to remove',
        duplicate_groups, duplicate_rows
      ),
      hint = 'Keep the OLDEST boost per pair and delete the rest, then recompute stats.boosts_count. The exact statements are in the header of this migration file.';
  end if;
end $$;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_one_boost_per_account_key" ON "posts" USING btree ("oxy_user_id","boost_of") WHERE "posts"."type" = 'boost' and "posts"."boost_of" is not null and "posts"."federation_activity_id" is null;
