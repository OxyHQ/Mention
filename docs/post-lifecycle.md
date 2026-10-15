# Post lifecycle and identity

Deep detail behind the "Post lifecycle" and "Post and identity rules"
sections of `AGENTS.md`. See also `docs/channels-and-lanes.md` for
channel/lane-specific authorship rules and `docs/feed-ranking.md` for how a
post is classified and ranked once it exists.

## Post lifecycle

- **A native edit commits one scalar/content revision.** `updatePostAndContent`
  takes the canonical content advisory lock and then the post row lock before
  writing scalar language/classification and replacing the rendition graph in
  the same transaction. Shadow claims cannot admit a new language with an old
  body, and a failed content insert rolls back scalar changes. Draft/scheduled
  edit eligibility is rechecked under those locks, so publishing while an edit
  waits causes a409 rather than using its former unpublished carve-out. External
  federation/repair callers of `replacePostContent` retain their existing paths.

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
  untouched). One legacy account is in that state.

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

## Native event attendance

A published Mention-native event opens `/events/<postId>`. Attendance defaults to
private; the attendee may opt into the public roster. Organizers (the author or
people currently authorized by Oxy to publish as that authoring account) can read
the full roster. Post hydration and the feed contain no attendee identities.
The detail and roster endpoints are `private, no-store`, scoped to the viewer;
profile labels are resolved in one Oxy batch after the roster is authorized.
The shared post ACL reads local privacy through the event transaction after the
lock, and reads Oxy relations without the feed cache; current account authority
is also checked after waiting. Identity summaries are resolved before the
transaction so they cannot exhaust the pool with nested connections.

`PUT /posts/:id/event/attendance` registers or updates visibility, and `DELETE`
on that path withdraws without revealing the event, including after read access
has been revoked. A parent row lock serializes capacity checks and cancellation.
There is no waitlist. Canceling attendance releases the seat. A capacity cannot
be reduced below current attendance. Registration closes at the event time or
when the organizer cancels it. Existing attendees can still hide their public
attendance through the API or withdraw using the detail screen. Homiio references, federated posts and unpublished
posts cannot use this participation surface.

`PUT /posts/:id/event` requires the event's current revision; `POST` to its
`/cancel` child cancels permanently. These event operations remain available
beyond the post-body edit window. Generic post edits cannot rewrite published
native-event fields or graft a Homiio reference onto them: the canonical content
replacement preserves event facts under the same lock, including stale writes
from enrichment. Draft and scheduled events can still be edited before publication.

A meaningful event change and its attendee inbox notices commit in one database
transaction. The inbox consolidates the latest notice per event, organizer and
kind, marking it unread only on a new revision. A lost-response retry of the same
change does not refresh a read notice or create another one. Existing socket and
push delivery remains best effort after commit; the durable inbox survives a
process exit. These notices contain no private attendee roster.

Migration `0072_ecosystem_references_and_events` adds attendance and event state without
rewriting existing events. Apply it before the new image. The backend image
builds and ships `@oxy.so/mention-contracts`; new clients need the corresponding API.
The generated contract is `packages/contracts/openapi.events.json`, served at
`GET /posts/events/openapi.json`; `bun scripts/event-openapi.ts --check` verifies
freshness. Oxy membership and push provider behavior are tested through fixtures,
not live credentials. Native-device behavior has not been validated in this change.

Ordinary post or thread deletion refuses an attended event until it has been
cancelled, under the same parent lock as registration. After cancellation,
ordinary deletion retains only the existing `event_cancelled` inbox notice
(actor, recipient and opaque post reference; no event facts or attendee roster)
until normal notification expiry. Account erasure, channel removal and
privileged federation/admin removal retain their existing removal semantics
and do not require an attendee workflow to complete.
