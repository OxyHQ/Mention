# Post lifecycle and identity

Deep detail behind the "Post lifecycle" and "Post and identity rules"
sections of `AGENTS.md`. See also `docs/channels-and-lanes.md` for
channel/lane-specific authorship rules and `docs/feed-ranking.md` for how a
post is classified and ranked once it exists.

## Post lifecycle

- **A cascade delete filter naming a field the schema lacks is a silent
  no-op that reports success.** `deletePost` passes the deleted post
  DOCUMENT to `cascadeDeletedPost` (`services/PostDeletionCascade.ts`),
  scored against `POST_REFERENCE_PROBE_NAMES`
  (`scripts/lib/adminDeletionPreflight.ts`) — every known post reference
  with a disposition (`cascade`/`cancel-pending`/`retain`). A new field
  naming a post needs a probe added there. Six direct-FK children are left
  to `ON DELETE CASCADE` on purpose (re-implementing them would be
  permanently untestable); `EngagementOutbox`/`FederationDeliveryQueue` are
  `cancel-pending` (unindexed, so an unscoped delete would scan); a `Report`
  stays `retain`ed (a resolving CrowdSource decision must not strand).
- **`authorship[]` is REQUIRED on every post**; there is no read-time legacy
  fallback. A post with a pending collaborator invite does NOT federate
  until the last invite resolves (`maybeFederateOnResolve`). Invites are
  published-only — a scheduled post and a server draft (`status: 'draft'`)
  both defer invites/MTN/notifications/federation until they go live. Threads
  reject `collaboratorIds` with 400.
- **A server draft publishes through the scheduled pipeline.**
  `POST /posts/:id/publish` claims a draft with the same conditional UPDATE a
  scheduled post uses (`claimUnpublishedPost`, `from: 'draft'`), so it runs
  `publishScheduledPost` exactly once. The claim names ONE state: the sweep
  cannot publish a draft, and a draft publish cannot reach the queue. The claim
  restamps a draft's `created_at` to the publish moment; a scheduled post keeps
  its own. A draft is edited in place (`PUT /posts/:id`, exempt from the
  30-minute window like a scheduled post) and is never part of a thread.
- **Erasing an ACCOUNT is not a loop over `deletePost`.** When Oxy reports an
  account deleted, `services/accountErasure/erasePosts.ts` walks the account's
  posts in batches and reuses `cascadePostReferences`, but it KEEPS other
  people's replies (`parent_post_id` → NULL, `is_reply` stays true) where the
  single-post delete removes direct replies: erasing a person must not destroy
  what others wrote. Counters on surviving posts are decremented in the batch's
  own transaction. The whole disposition, table by table, is
  `docs/account-erasure.md`.
- **An engagement event's side effects are independent.** The engagement
  outbox (`services/EngagementOutboxDispatcher.ts`) attempts a like's MTN
  record, author notification and federation delivery every time, records
  each one that lands in `engagement_outbox.completed_effects`, and retries
  only the rest. Never chain them again: an MTN append that could not
  succeed once kept one account's like notifications and federation
  deliveries from running for five weeks. A like notification older than
  `LIKE_NOTIFICATION_MAX_AGE_MS` (24 h) is skipped, so a drained backlog
  does not reach authors as a burst of stale pushes.
- **A chain head behind its own ledger turns `chain_conflict` permanent.**
  The append builds `seq = head.seq + 1`, so a row already holding that seq
  without the head pointing at it collides on every re-read.
  `signAndAppend` reconciles once per append (`MentionRecordStore.reconcileHead`):
  it fast-forwards the head over rows that extend it and archives the rest
  as forks (`chain_status = 'conflict'`, `seq`/`prev` cleared, envelope
  untouched). The Mongo → Postgres cutover left one account in that state.

## Post and identity rules

- **Post DTOs MUST come from `PostHydrationService`**
  (`services/PostHydrationService.ts`). Controllers never hand-build post
  `user`, notification embedded posts, or feed shapes.
- **`post.user` / `authors[]` / `boost.actor` are the canonical Oxy `User`
  shape**, passed through unchanged. No `avatarUrl`, no flat
  `displayName`/`handle`, no Mention-local adapter. Every renderer derives
  the handle via `getNormalizedUserHandle`.
- Degraded author (Oxy resolve miss) = empty `username` + `'Unknown user'`;
  a degraded FEDERATED author is enriched from Mention's own
  `FederatedActor` record but never invents `displayName`, and is never
  cached.
- Valid profile URLs: `/@username` and `/@username@domain`. A duplicate
  suffix (`/@user@domain@domain`) is a handle-normalization bug.
