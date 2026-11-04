# Bluesky ingestion

How Mention reads Bluesky (AT Protocol). The connector only reads: it never
writes a record into anyone's repository. Code is in
`packages/backend/src/connectors/atproto/`.

## Every request goes through one client

`connectors/atproto/xrpcClient.ts` makes every atproto GET: AppView queries, PLC lookups, did:web
documents, `.well-known` handles. It is SSRF-safe (core's `safeFetch`, pinned IP,
no redirects, a byte cap and a deadline). It is also where Mention backs off:

- **A bounded number of requests in flight per host** from one process
  (`MAX_IN_FLIGHT_PER_HOST`). Later callers queue in the client instead of piling
  onto the host.
- **A 429 or 503 pauses the whole host.** The pause lasts as long as the host
  asked (`Retry-After`, else atproto's `RateLimit-Reset`, else an exponential
  backoff with jitter), and the request is retried up to `MAX_ATTEMPTS` times. Bluesky limits per
  client IP, and every Mention task leaves through the same NAT, so a request
  that ignored a sibling's 429 would only make the penalty longer.
- **A pause longer than `MAX_RETRY_WAIT_MS` is not waited out inside a request.** Until it ends,
  calls to that host fail at once with a `429` `XrpcError`, without a request.
  Every caller already fails soft, so the next sync tick or profile view picks
  the work up.

An array parameter is sent as the key repeated once per value
(`app.bsky.feed.getPosts?uris=a&uris=b`), which is how XRPC encodes arrays.

## How posts arrive

Every Bluesky post is imported through one path: an AppView `PostView` mapped by
`connectors/atproto/post.mapper.ts` and created through `getPostCreator().create`,
deduped on its AT-URI (`posts.federation_activity_id`). The triggers differ:

| Trigger                            | What it reads                                              | Where                                |
| ---------------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| Someone opens a profile            | The newest author-feed page                                | `connectors/federatedProfileSync.ts` |
| Someone follows the account        | The newest author-feed page                                | `AtprotoConnector.followActor`       |
| Periodic sync of followed accounts | The newest page of each due account                        | `syncFollowedAtprotoAccounts`        |
| Periodic history backfill          | Older pages, from a saved cursor                           | `advanceAtprotoHistoryBackfills`     |
| Jetstream, live                    | New posts of followed accounts; deletes of any stored post | `connectors/atproto/jetstream/`      |

### Followed accounts are re-read in the background

`syncFollowedAtprotoAccounts` (`connectors/atproto/accountSync.ts`) is the
Bluesky half of the `syncFollowedActorsPosts` periodic job; the ActivityPub
outbox sync is the other half, and each half's failure is isolated from the
other, and reaches it through `AtprotoConnector`. It reads, through
`importAccountPosts` (the import behind `fetchPosts`, which a profile view uses),
the followed accounts whose `last_outbox_sync_at` is older than
`FOLLOWED_SYNC_DUE_MS`. It takes at most `FOLLOWED_SYNC_BATCH` per tick, the
longest-waiting first, `FOLLOWED_SYNC_CONCURRENCY` at a time.

- **No thundering herd.** Due-ness is one stamp that a profile view writes too, so
  an account someone just opened is not fetched again, and a large follow list
  spreads over several ticks instead of arriving at once.
- **A failed read is still stamped** (the profile-view rule). The account goes to
  the back of the queue rather than being retried every tick.

### Full history: paginated author feed, not the repository CAR

`advanceAtprotoHistoryBackfills` is the Bluesky half of
`syncRecentOutboxBackfills`. It pages `app.bsky.feed.getAuthorFeed`
(`HISTORY_PAGE_SIZE` items a page), `HISTORY_PAGES_PER_RUN` pages per account per
run, and stops at `HISTORY_MAX_PAGES` pages, the per-account cap, or at the end
of the feed. Progress is in the `outbox_backfill_*` columns the ActivityPub walk
uses: the cursor holds the AppView's opaque cursor, and a lease stops two tasks
from walking the same account. An account is a candidate when someone follows
it, or when someone has opened it and its whole history is at most
`HISTORY_CHEAP_POSTS` posts. A 400 (an account the AppView will never serve)
marks it `unavailable`; any other failure leaves it `failed`, retried on a later
run.

Reading the account's repository from its PDS (`com.atproto.sync.getRepo`, a CAR
file) was the alternative. It was rejected for four reasons:

- **The mapper reads views, not records.** A raw record has no Bluesky moderation
  labels (only self-labels), no CDN image URLs, no handle and no reply context.
  Every post would still have to be hydrated through `app.bsky.feed.getPosts`,
  25 to a call, which costs more requests than `getAuthorFeed`'s 100 to a page.
  Mapping raw records directly would be a second mapper.
- **A CAR cannot be bounded.** It is the whole repository: every like, follow,
  block and repost. That can be tens of megabytes for an active account, with no
  way to ask for posts only or for the newest N.
- **No maintained CAR/DAG-CBOR library is in the tree.** Neither Mention nor Move
  has one.
- **Move made the same choice.** It reads full histories with paginated
  `getAuthorFeed` (its Bluesky source, in OxyHQ/Move).

Pagination also brings reposts (stored as boosts) and the pinned post, which a
repository walk would have to re-derive.

## Live posts and deletes: Jetstream

`connectors/atproto/jetstream/` holds one WebSocket subscription to Bluesky's
[Jetstream](https://bsky.network/docs/jetstream/) v2
(`network.bsky.jetstream.subscribeEvents`; public, free, no authentication).
It is configured with `ATPROTO_JETSTREAM_ENABLED` (on with the connector) and
`ATPROTO_JETSTREAM_URL`: one or more comma-separated origins, by default
`wss://jetstream.us-west.bsky.network` (the backend's own region) then
`wss://jetstream.us-east.bsky.network`.

**Where it runs.** On the scheduler leader. It is started and stopped with the
other leader-gated jobs (`runtime/schedulers.ts`), so exactly one task in the
fleet holds the subscription. Today that is one of the `combined` API tasks.
Once the fleet is split (`MENTION_PROCESS_ROLE=worker`), the worker holds the
leadership and the stream moves with it, with no code change. It is not a
BullMQ job: it is one long-lived connection, not a unit of work.

**One connection, filtered by collection, not by account.** The subscription asks
for `kinds=commit` and the handlers' collections, and every handler filters
accounts itself. The lexicon allows 10,000 `dids` per subscription, but the
public instances refuse a request line over about 8 KB (measured 2026-11-04: a
414 from their proxy at about 215 DIDs). A DID filter would therefore need a
connection per ~200 accounts, re-sharding, and a reconnect on every follow. The
handlers that come next cannot be written as a DID filter either: a like or a
follow is ours when its subject is ours, whoever wrote it. The whole post stream
is about 70 events/s and 65 KB/s (about 6 GB a day), which costs little to read
and discard.

**What the post handler does** (`postHandler.ts`):

- A **create** by an account a local user follows is imported by its AT-URI
  (`importPostsByUri`): hydrated through `app.bsky.feed.getPosts` with the posts
  it replies to, then through the one post mapper. It therefore has the same
  moderation labels, media and links as an author-feed import. The author comes
  from the stored actor row, so no profile read is needed. The followed set is
  re-read from `federated_follows` every minute. An account nobody follows is
  left to the profile-view sync.
- A **delete** removes any stored Bluesky post with that AT-URI, whoever wrote it,
  through `deleteFederatedPostSubtree`, the cascade an ActivityPub `Delete` runs.
  It costs one indexed lookup. Before this, a post deleted on Bluesky stayed on
  Mention.
- An **update** is ignored. Bluesky has no post editing.

**Delivery and the cursor.** Delivery is at-least-once, so every handler is
idempotent on the record's AT-URI. A post that is already stored costs one query
and no AppView call. Commits are handed to handlers in stream order, in batches,
about once a second. The resume cursor is the `witnessedAt` of the newest frame
received before the batch, as unix microseconds. Jetstream reads a value of 1e15
or more as a timestamp and resumes from it inclusively, and unlike `seq` it is
valid on every instance. The cursor is stored in `jetstream_cursors` (row
`bluesky`), at most every few seconds and on stop. It only moves past work that
was handled:

- **A handler that throws** (AppView down, database unreachable) does not move it.
  The connection is dropped and reopened from the last good cursor, so the batch
  comes again.
- **A queue that outgrows its bound** reconnects the same way. That is the
  backpressure.
- **Reconnects back off** exponentially, up to a minute, and the backoff resets
  after a connection has stayed up. Each reconnect moves to the next origin, so a
  degraded instance is left behind; the timestamp cursor is valid on every one.
- **A stream that falls behind live is reconnected.** An instance can stay
  connected while delivering a trickle of old events (us-east on 2026-11-04: one
  event a second, then none, while us-west delivered fifty). Every two minutes
  the consumer checks that the stream's own clock, the newest `witnessedAt`,
  advanced by at least half the time that passed. A live tail advances one for
  one and a replay faster, so one that does not has stalled.
- **An outage longer than Jetstream's replay window** (36 h) starts at the oldest
  event it still has, with an `OutdatedCursor` notice in the log. The periodic
  author-feed sync covers the gap.

### Adding a collection (the extension point)

To follow likes, reposts or follow edges, write a `JetstreamCollectionHandler`
(`JetstreamConsumer.ts`):

```ts
const likeHandler: JetstreamCollectionHandler = {
  collection: 'app.bsky.feed.like',
  async handle(commits) {
    // Every like and unlike, from every account, in stream order.
    // Filter to the ones that are ours; be idempotent on commit.uri.
  },
};
```

Then add it to `jetstreamHandlers()` in `connectors/atproto/jetstream/index.ts`.
That is all. The consumer subscribes to every listed collection (up to 100),
batches, retries, and shares the one cursor. A handler throws only for a failure
that may pass, because a throw replays the batch. `deleteStoredAtprotoRecords`
(`postHandler.ts`) deletes a stored post or boost by the record's AT-URI, which
is what an unrepost needs: an author-feed import stores a repost as a boost under
the repost's own AT-URI. A new collection multiplies the stream's volume (likes
alone are several times the posts). Check the bandwidth before adding one.

### Deploying

No infrastructure change is needed. The stream runs inside the existing backend
service's leader task and leaves through the same NAT as every AppView read.

1. Merge. The deploy's migration one-shot creates `jetstream_cursors`
   (`0115_jetstream_cursors`, pre-deploy phase, a new empty table).
2. The new leader logs `[jetstream] connecting`, then `[jetstream] deleted posts`
   and `imported posts` lines. The first start has no cursor, so it begins at the
   live tip.
3. To turn it off, set `ATPROTO_JETSTREAM_ENABLED=false` on the task definition
   (the backend-config workflow) and redeploy. The periodic sync keeps working.
4. Optional, later: when the API and worker roles are split, nothing changes
   here. The stream follows the scheduler leadership onto the worker service.
