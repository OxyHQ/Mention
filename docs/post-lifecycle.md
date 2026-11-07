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

- **Trailing hashtags are filing, not prose.** `normalizePostHashtags`
  (`utils/textProcessing.ts`) is the one rule every write applies — native
  create/edit through `stripHiddenHashtags` (`services/postVariants.ts`), the
  federated ingest in `connectors/activitypub/apPostContent.ts`. Hashtag-only
  lines at the END of a body are removed from the visible text whole, whatever
  their count; a 4+ block elsewhere keeps only its first tag; a hashtag inside
  a sentence (`I love #Apple`, even as the last word) stays. Every tag still
  lands in the `hashtags` column (derived from the RAW body) and federates in
  the Note's `tag` array. So a post ending in a link ends with that link, and
  the card alone shows it (`frontend/utils/postLinkCards.ts`). Any word,
  emoji, mention or punctuation on a hashtag line keeps the whole line, and a
  post is never emptied: a body of nothing but hashtags stays as written. The
  composer's edit sends no `hashtags`, so an edit keeps the stored tags it
  cannot see. `packages/backend/src/scripts/stripTrailingHashtagLines.ts`
  applied the rule to bodies stored before it.
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
  both defer invites/notifications/federation until they go live. Threads
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
  outbox (`services/EngagementOutboxDispatcher.ts`) attempts a like's author
  notification and federation delivery every time, records each one that
  lands in `engagement_outbox.completed_effects`, and retries only the rest.
  Never chain them again: one effect that could not succeed once kept one
  account's like notifications and federation deliveries from running for
  five weeks. A like notification older than
  `LIKE_NOTIFICATION_MAX_AGE_MS` (24 h) is skipped, so a drained backlog
  does not reach authors as a burst of stale pushes.

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
  cached in Redis. A page that renders one is never written to the anonymous
  feed cache (`hasUnresolvedAuthor`): it records an Oxy failure, not the feed.
  Authors are read with `users.lookupMany`, which tells an id Oxy answered
  WITHOUT (absent: the account is gone, archived or restricted) from one it
  could not ask about (failed: a chunk timed out, 429, 5xx). Only failed ids
  are read again one by one, and a bulk read that failed with
  429/5xx/network/deadline is not retried per id: that would spend the
  exhausted budget once per author. A task answers a failed author with the
  placeholder for 5 s (`OXY_USER_FAILURE_TTL_MS`) and an absent one for 60 s
  (`OXY_USER_ABSENT_TTL_MS`) before asking again. `oxy_user_resolution_partial_total`
  counts the two apart (`reason`: `absent` | `deadline` | `bulk_error` |
  `per_id_error`), and the warn line carries the counts and a sample of absent
  ids. The app re-reads page 1 of a feed showing a degraded author
  (`hooks/useFeedQuery`, bounded backoff), so names come back once Oxy does.
- Valid profile URLs: `/@username` and `/@username@domain`. A duplicate
  suffix (`/@user@domain@domain`) is a handle-normalization bug.

## Visibility

| Visibility                 | Readers                                           | Listed in feeds, profiles, search |
| -------------------------- | ------------------------------------------------- | --------------------------------- |
| `public`                   | everyone                                          | yes                               |
| `followers_only`           | the author's followers                            | follower feeds only               |
| `private`                  | the owner, collaborators, the channel's operators | no                                |
| `direct` (private mention) | the author and its `post_recipients`              | never                             |

`PostHydrationService` is the one read gate; a recipient of a published direct
post is a resource grant there, and Oxy is asked with the `private` audience
(`postSafetyAccess.ts`), so supervised accounts stay behind contact approval.
Every listing filters visibility with an allowlist, which keeps `direct` out
of all of them; only the thread reads (`GET /posts/:id`,
`GET /feed/replies/:parentId`, via `threadReplyVisibilitySql`) and
`GET /posts/private-mentions` admit it, for its participants.

Who a post is for is decided at write time by `resolvePostAudience`
(`db/posts/postAudience.ts`), which `writePostRecord` and `linkReplyToParent`
apply to every path: a reply is never wider than its parent, a reply to a
direct post is direct and addressed to the parent's author and recipients (plus
its own mentions), and only participants can add to a private conversation
natively. A new native direct post is addressed to its mentions and needs at
least one. Direct posts' media is made public by unguessable URL, as Mastodon
serves a DM's, so remote recipients can fetch it.

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

Migration `0075_ecosystem_references_and_events` adds attendance and event state without
rewriting existing events. Apply it before the new image. The backend image
builds and ships `@oxy.so/mention-contracts`; new clients need the corresponding API.
The generated contract is `packages/contracts/openapi.events.json`, served at
`GET /posts/events/openapi.json`; `bun scripts/event-openapi.ts --check` verifies
freshness. Oxy membership and push provider behavior are tested through fixtures,
not live credentials. Native-device behavior has not been validated in this change.

`packages/contracts` and `packages/sdk` are published to npm as
`@oxy.so/mention-contracts` and `@oxy.so/mention-sdk` (Schedio's publishing
client: `POST /posts` with an `Idempotency-Key`, `GET /mcp/bundles/me`). They are
released by merging a version bump to main: `release-packages.yml` publishes them,
contracts first (the SDK pins the same contracts version), once CI passed on that
commit. CI's "Published contracts and SDK" step is their gate.

Ordinary post or thread deletion refuses an attended event until it has been
cancelled, under the same parent lock as registration. After cancellation,
ordinary deletion retains only the existing `event_cancelled` inbox notice
(actor, recipient and opaque post reference; no event facts or attendee roster)
until normal notification expiry. Account erasure, channel removal and
privileged federation/admin removal retain their existing removal semantics
and do not require an attendee workflow to complete.
