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

| Trigger                            | What it reads                       | Where                                |
| ---------------------------------- | ----------------------------------- | ------------------------------------ |
| Someone opens a profile            | The newest author-feed page         | `connectors/federatedProfileSync.ts` |
| Someone follows the account        | The newest author-feed page         | `AtprotoConnector.followActor`       |
| Periodic sync of followed accounts | The newest page of each due account | `syncFollowedAtprotoAccounts`        |
| Periodic history backfill          | Older pages, from a saved cursor    | `advanceAtprotoHistoryBackfills`     |

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
