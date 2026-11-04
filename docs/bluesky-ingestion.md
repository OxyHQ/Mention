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
