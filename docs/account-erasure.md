# Account erasure

When a person deletes their Oxy account, Mention erases what it holds for them.
This page covers the trigger, the guarantees, exactly what is deleted and what is
kept (and why), federation, MTN, the operator script, and how to verify a run.
Origin: [OxyHQ/Mention#1169](https://github.com/OxyHQ/Mention/issues/1169).

The code is `packages/backend/src/services/accountErasure/`. The table-by-table
disposition is `erasureMap.ts`; this page summarises it and the map is the
authority.

## Trigger: push and pull, signed events only

Oxy's `DELETE /users/me` writes a signed `account.deleted` Security Event Token
(RFC 8417 shape, `typ: secevent+jwt`, EdDSA, Oxy's published JWKS) for every
relying application, in the same transaction as the deletion. That covers both
outcomes: a hard delete, and an archive kept for financial records
(`retained: true`). Mention erases either way.

- **Push.** Oxy posts the raw token to
  `POST https://api.mention.earth/webhooks/oxy/account-events`
  (`Content-Type: application/secevent+jwt`). The route
  (`packages/backend/src/routes/oxyAccountEvents.routes.ts`) verifies the token
  with `@oxy.so/core`'s `verifyAccountEvent` (signature, `typ`, issuer, audience
  = Mention's application), records the event, schedules the job and answers
  `202`. A bad signature is `401`, a body that is not a compact JWS is `400`, a
  wrong content type is `415`, and a token that could not be *checked* (key set
  unreachable) is `503` so Oxy retries. The route is mounted before the JSON
  parser and every auth, admission and CSRF layer (the token is the
  authentication), with a 16 KB body limit and a per-IP rate limit. Oxy retries
  a non-2xx with backoff for about 3.5 days.
- **Pull.** A leader-only job (`AccountEventReconciliationJob.ts`, every 5
  minutes, single-flight across tasks through leader election) reads
  `listAccountEvents({ after })` forward from a cursor stored in
  `oxy_account_event_cursors`, verifies every token again, and records each
  event. The cursor moves only past a page whose every event was recorded. A
  token that fails verification is refused, counted and skipped; a failure to
  reach Oxy or to check a token leaves the cursor where it was.

**Mention never infers a deletion.** A 404 from Oxy, a missing profile or a failed
lookup starts nothing. Only a verified event (or an operator, below) does.

## Idempotency and durability

`account_erasures` is both the idempotency ledger and the job's durable state:
one row per event, unique on `event_id`. The row is written before the webhook
answers, so a `202` means the event cannot be lost. A redelivered event, or the
same event arriving by push and by pull, finds the existing row.

The job runs on the BullMQ queue `account-erasure` (`packages/backend/src/queue`)
with retries. A run takes a lease on the row (`claimAccountErasure`), so one
account is never erased by two tasks at once. A crash leaves the row `running`
with a lease that lapses, or `failed` with `last_error`; the reconciliation job
re-schedules both. Every step is keyed on the account id and converges: a re-run
finds only what survived, and a run for an unknown or already-erased account is a
successful no-op. Large sets are deleted in bounded batches (1,000 rows per
statement, 100 posts per transaction).

Each run logs start and end with per-category row counts (never content) and
writes the same counts to `account_erasures.counts`. Metrics:
`account_erasure_completed_total`, `account_erasure_failed_total`,
`account_event_refused_total`, `oxy_account_event_webhook_total`.

## What is deleted

In order (the order is what each step reads before another deletes it):

1. **Queued outbound activities** the account sent are cancelled, so a queued
   `Create` cannot race the Deletes. Queued `Delete` activities are kept.
2. **Posts**: every post, reply, boost, quote, draft and scheduled post the
   account owns, in keyset batches. Each batch sends `Delete(Tombstone)` for its
   public posts, removes every reference no foreign key covers
   (`PostDeletionCascade.cascadePostReferences`: post notifications, post labels,
   gates, telemetry, queued deliveries), repairs counters on surviving posts, and
   deletes the rows; their media rows, polls (with options and votes), articles,
   language variants, links, mentions, corrections, import records and trend
   memberships go with them by foreign key. **Other people's boosts** of these
   posts go too (a boost is an empty card that only renders its original).
3. **The actor** is sent a `Delete`.
4. **Engagement**: likes and downvotes, saves, poll votes, feed telemetry, and
   the account's place in other posts' reply-avatar strips (recomputed from the
   surviving replies).
5. **Everything keyed on the account**: settings (appearance, privacy, profile
   design, notification and feed tuning), saved feeds, the ranking profile,
   follower snapshots, mutes both ways, muted words, pokes both ways, hashtag and
   list follows, notifications to, from and about the account, push tokens, owned
   lists (and other people's follows of them), list memberships, owned starter
   packs and memberships, owned custom feeds and memberships, feed likes and
   reviews, feed generators, the account's labelers (with their labels), labels
   on the account, lanes and lane mutes, subscriptions both ways, collaborator
   entries on others' posts, mentions of the account, queued engagement and
   endorsement work, MCP connections, codes and receipts, job applications (with
   answers and the employer's notes on them), jobs published under the account,
   and the MTN signed-record chain, head and witnesses.
6. **Federation rows**: follow edges with remote actors, identity links, actor
   rows and legacy key material.
7. **Redis caches** keyed by the account (user summary, fediverse-sharing flag,
   viewer relations, seen posts, recent topics).

## What is kept, and why

| Kept | Form | Why |
| --- | --- | --- |
| Other people's replies to the account's posts | Unchanged text, `parent_post_id` NULL | They wrote those words. `is_reply` stays true, so an orphaned reply never becomes a root post in a feed. (The single-post delete removes direct replies; erasing a person does not destroy other people's writing.) |
| Other people's quotes of the account's posts | Unchanged text, `quote_of` NULL | Same reason; the quote card disappears. |
| Counters on other people's posts | Decremented by exactly what was removed | Like, downvote, save, reply and boost counts stay correct and anonymous. Each decrement commits in the same statement as the delete, so a retry cannot apply it twice. |
| Aggregates (`trending.author_count`, starter-pack `use_count`, feed ratings, job metrics) | Unchanged numbers | Anonymous totals with no id in them. |
| Reports the account filed that reached CrowdSource | Reporter replaced by `erased:<report id>`, free-text details cleared | An inbound CrowdSource decision is matched to the row; without it the decision retries until it expires. Undelivered reports are deleted. |
| Reports and enforcement records ABOUT the account or its posts | Unchanged (ids, categories, a content hash) | Moderation records filed by other people, kept for the establishment and defence of moderation decisions (GDPR Art. 17(3)(e); DSA record-keeping). They hold no reported content. |
| Labels the account applied under an official labeler; an official labeler it created | Creator replaced by the sentinel `erased:account` | Platform moderation outcomes on content, not the person's data. |
| Employer records the account created as an operator (job rows, notes on applicants), blocklist decisions it made | Author replaced by the sentinel | The organization's records; the person's id goes. |
| Channel posts the account wrote as a channel writer, corrections it made to them | `written_by_oxy_user_id` NULL; corrector replaced by the sentinel | The channel's posts; the pointer to the person goes. |
| A managed MTN vault registration | Marked `revoked` | That row is the signal the node-fleet reconciler tears the per-user volume down from. A self-hosted node row is deleted. |
| The `account_erasures` row | Account id, event id, counts; the handle for 14 days | The idempotency key and the proof the erasure ran. The handle is needed to sign the Deletes still retrying, and is cleared 14 days after completion. |
| Other people's rows that embed the id in a string (feed descriptors, module params) | Unchanged | Opaque labels that resolve to nothing once the account is gone, with no content of their own. |

## Federation

Mention mints ActivityPub ids from the handle (`/ap/users/<username>`), and Oxy
signs on Mention's behalf (`POST /federation/sign`) with a key pair addressed by
that handle. Oxy keeps the key pair after the account is deleted, and the event
carries the handle, so the Deletes can still be addressed and signed:

- one `Delete(Tombstone)` per public, published, local post, sent before the post
  rows are deleted;
- one `Delete` of the actor (a deterministic id, so a re-run dedupes per inbox),
  sent while the follow edges delivery reads are still there.

Both go through the normal delivery queue to every follower inbox and retry on
its schedule (about 63 hours). The delivery worker resolves a sender's handle
from Oxy, and falls back to `account_erasures.username` for an erased sender.
Without a handle (an old token, an account with none), nothing is sent and the
local erasure still runs.

**Limits.** Remote servers are asked, not forced: a server may ignore a Delete,
and one that stays down past the retry budget never hears it. Posts that were
never public were never federated and get no Delete.

## Channels and other managed accounts

A channel is an Oxy account (`kind: 'channel'`). Deleting one in Mention runs
Mention's own cascade first (`services/channelDeletion/`, the order is explained
in `routes/channelDeletion.routes.ts`), and then the client archives the account
in Oxy (`DELETE /accounts/:id`).

Archiving a managed account (a channel, organization, project or bot) also
records an `account.deleted` event with `retained: true`, the same event as a
person's deletion (OxyHQ/Mention#1178). The reasons:

- **The archive is permanent.** It writes an account closure fence, and Oxy has
  no path that restores an archived account, so the id is gone for every relying
  party.
- **Mention is not the only door.** The Oxy Accounts managed-accounts screen, the
  Oxy Console and the services SDK's account settings all archive a channel
  directly. Before this change, a channel archived there kept its posts, actor and
  follows in Mention forever, because nothing told Mention.
- **Other relying parties hold managed-account ids too** (a channel is a
  CrowdSource subject author, for example).

When the deletion starts in Mention, the cascade has already removed almost
everything by the time the event arrives, so the erasure finds residue at most
and converges. When the archive starts anywhere else, the event is what erases
the channel. The event carries the handle, so the erasure can still address
the actor `Delete` after Oxy stops resolving the account.

## MTN records

The account's chain (`mention_signed_records`, `mention_repo_heads`,
`mention_node_ingest_witnesses`) is **deleted, not tombstoned**. A tombstone is
an appended record that supersedes a key but leaves the original signed envelope,
with the post text, in the chain, so it is not erasure. Every reader of the chain
reads Mention's own table (the atproto bridge and the node export), so deleting
the rows removes the records from every surface Mention serves. The channel
cascade makes the same call. A self-hosted node is the person's own server and
copy; Mention stops syncing it. A managed vault is revoked for teardown.

## Outside Mention

- **Oxy** owns the identity, graph, blocks and every uploaded media file (post
  media are bare Oxy file ids), so erasing them is Oxy's `DELETE /users/me`, not
  Mention's. Mention holds no media store of its own: its federated-media cache
  re-hosts REMOTE media in Oxy, keyed by remote URL, not by a local account.
- **CrowdSource** holds reports delivered to it and community notes or ratings
  authored under the account's id. Mention has no erasure call into CrowdSource
  today; that is a follow-up on the CrowdSource side.
- **Search** is Postgres full-text over post variants, which go with the posts.
  User search is Oxy's.
- **Caches** that cannot be found by account id (per-post view markers, the
  search overview, anonymous feed pages) expire on their TTL, at most 24 hours.

## The gate

`packages/backend/src/__tests__/services/accountErasureCoverage.test.ts` fails
when a schema column that can hold an Oxy account id has no entry in the map, or
an entry has no step. It finds account columns three ways: the schema's own
`isOxyAccountColumn` predicate, an explicit list of account ids under other names,
and a greedy name heuristic whose false positives are dismissed in writing. A new
table with an account column therefore fails CI until someone decides what
erasure does to it.

## Operator script

For an account deleted in Oxy before the webhook existed (it never produced an
event), run the erasure by hand through the GitHub workflow
`.github/workflows/run-account-erasure.yml` (an ECS one-shot inside the VPC, from
`main`, restricted to the logins in the repository variable
`ACCOUNT_ERASURE_OPERATORS`):

```bash
# 1. Dry run: per-category counts, writes nothing.
gh workflow run run-account-erasure.yml -R OxyHQ/Mention --ref main \
  -f oxy_user_id=<oxy user id> -f username=<handle, if known> -f dry_run=true

# 2. The erasure.
gh workflow run run-account-erasure.yml -R OxyHQ/Mention --ref main \
  -f oxy_user_id=<oxy user id> -f username=<handle, if known> \
  -f dry_run=false -f confirm_write='ERASE ACCOUNT'
```

The dry run's log line is readable: the logger keeps a finite number under a
`counts` or `preview` key under its category name (`posts.oxyUserId`, …), where
its name heuristic would otherwise redact every category, since each name ends in
`id` (`utils/logger.ts`, OxyHQ/Mention#1178). Anything that is not a number
inside those maps is still sanitized as usual.

The script (`packages/backend/src/scripts/eraseOxyAccount.ts`) refuses an account
Oxy still resolves as active, or one Oxy cannot answer for; only a 404 or an
`archived` account proceeds. It records `operator:<oxy user id>` in
`account_erasures` and runs the same job, so a re-run resumes the same row.

## How to verify

For an account id `U`:

1. `GET https://api.mention.earth/profile/design/U` answers `404` (it answered
   `200` with the account's settings before, which is what the issue saw).
2. The ledger row is `completed`:
   `select status, attempts, completed_at, counts from account_erasures where oxy_user_id = 'U';`
3. No map column still names the account. The Postgres test
   (`packages/backend/src/__tests__/services/accountErasure.test.ts`) runs this
   check over every executable map entry; the same query per table, run against a
   read replica, is the production spot check:
   `select count(*) from posts where oxy_user_id = 'U';` and so on.
4. The delivery queue carries the Deletes: rows in `federation_delivery_queue`
   (or BullMQ `federation-delivery` jobs) with `sender_oxy_user_id = 'U'` and
   `activity_json->>'type' = 'Delete'`. A remote server that followed the account
   should show it as gone once its delivery lands.
