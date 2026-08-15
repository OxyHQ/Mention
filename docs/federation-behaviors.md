# Federation behaviors and edge cases

Deep detail behind the rules in `AGENTS.md` § Federation rules. Read
`docs/fediverse.mdx` first for the protocol surface and connector contract —
this file is the accumulated edge-case knowledge on top of it.

## A reposted post: whether we can rebuild it depends on what arrived

Three shapes reach us and they are NOT interchangeable. The rule is the same
one every time — structure comes from structured fields, never from the body
— and the outcome differs only because what the sender chose to include
differs.

- **A real `Announce`** — an ordinary boost. Nothing special.
- **A quote** — the reference arrives in `quote` / `quoteUri` / `quoteUrl` /
  `_misskey_quote` or the FEP-e232 `Link` tag. `extractApQuoteUri` reads all
  of them, and a quoted post we do not hold is FETCHED through
  `ensureQuotedNote` → `ensureFederatedNote`, the same signed, SSRF-safe,
  depth-capped import a boost and a reply ancestor use. Mastodon ALSO renders
  such a post's body as `RE: <url>`; that is a rendering for clients that
  cannot show quotes, and it is never the source — a body carrying `RE: <url>`
  with no quote field yields no quote, and a test pins it.
- **A bridge-flattened retweet** — bird.makeup and mastox publish a plain
  Note, authored by the RETWEETER, opening `RT: @original`, and carrying
  nothing else: `inReplyTo` null, `tag` empty, no quote field, no link to the
  upstream post, no id. Verified field by field on live notes from both.
  There is nothing to rebuild from, so these are DROPPED at ingest
  (`isBridgeFlattenedRetweet`) rather than published under a byline that did
  not write them. Reading the `RT:` prefix is the one place a body decides
  anything, and it is scoped to actors on a reviewed bridge because the
  failure directions are unequal: a missed retweet stores what we stored
  before, a false match destroys a real post.

Do not "fix" the third case by parsing the prefix into an author and fetching
them — that reconstructs from prose a relationship the bridge already
destroyed, and it is the fragility that was deliberately removed from the
identity path.

## Bridge identity comes from the actor's `type`, not from its bio

A bridge on stock server software has nothing to fingerprint. The tempting
tell is the per-account notice it writes into each mirrored bio — and that
fails on LANGUAGE: mastox serves the same sentence in English, French and
Spanish, an entry listing two of them left 18 of 50 held actors unrelabelled,
and nobody would report it because the account merely looks ordinary.

`upstreamHandleFromAutomatedActor` reads `type` instead: every mirror is
published as a `Service`, the operator's own account is a `Person`.
`Application` is refused — that is the SERVER'S own actor
(`https://<host>/actor`, `mastodon.internal`), and accepting it re-labels the
instance itself.

Not "relabel the whole host and exclude the admin": an exclusion list is
unbounded, and one miss publishes a real person as an account on a network
they may not use. Asking each actor what it is needs no list.

## Handles in synced text are qualified only where the result resolves

A handle written on another network means the account THERE, so ingest
qualifies it (`@openai` → `@openai@x.com`) via `qualifyBareHandles`, keyed on
`identityDomainOfActor` — which reads `networkAcct`, NOT `domain`: a
re-labelled actor's `domain` still addresses the bridge.

It answers for re-labelled actors ONLY. An ordinary instance's `@alice`
already means alice there and already resolves, so qualifying it would
lengthen the body of every federated post to say what the reader could
already act on — measured before scoping it: 1,266 of 5,000 sampled posts,
all ordinary Mastodon content.

## A thread federates through `PostCreationService.federatePublishedPost`

A thread federates as N chained `Create(Note)`s from
`connectors/threadFederation.ts`, not from `PostCreationService` directly —
but `PostCreationService.federatePublishedPost` is now the ONE implementation
both the immediate-publish and scheduled-publish paths call. Before this,
`createThread` suppressed the whole side-effect stage (`skipNotifications`,
because it ran its own per-entry notifications and one socket emit), and the
federation stage sat behind the SAME early return — so a published thread
federated nothing while the identical thread SCHEDULED federated completely.
The named `skipFederationDelivery` flag was never the cause; removing it
alone was a no-op.

- **Root-only is not a smaller version of this.** All three AP author
  surfaces filter `parentPostId: null` (outbox count, outbox page,
  `featured`) and a Note we emit advertises no `replies` collection, so a
  continuation that is not PUSHED is unreachable by every other means.
- **Enqueues are ordered, arrivals are not, and that is accepted.** One
  BullMQ job per inbox at `DELIVERY_WORKER_CONCURRENCY` across several
  tasks. Measured against Mastodon's source: a continuation whose parent is
  not yet resolved is dropped from every home timeline (`feed_manager.rb`,
  `reply?` comes from `inReplyTo` being present regardless of resolution);
  `ThreadResolveWorker` then fetches the parent from our dereference route
  and, from v4.3.0 only, re-runs distribution — on 4.2 and older it stays
  out of home timelines permanently while remaining correct in the thread
  view. DISPLAY order is always safe (`Mastodon::Snowflake` derives the id
  from `created_at`). A same-account thread is the well-behaved case:
  `feed_manager.rb` exempts a self-reply from the "reply to somebody you do
  not follow" filter.
- **A chain STOPS at the first entry that does not go out**, consent
  included. Federating an answer to an entry that stayed home publishes that
  author's handle (`Mention` tag) and their post's URL (`inReplyTo`) to every
  receiving instance even though both 404 — a leak, not a gap — and it
  dangles besides. A beast batch has no chain, so one silent account removes
  only its own posts.
- **A cross-account thread also delivers each entry to the OTHER
  participants' remote followers.** That makes those instances HOLD the
  whole conversation; it does NOT put the entry in anyone's timeline —
  Mastodon fans out from the STATUS AUTHOR's own followers
  (`FanOutOnWriteService#deliver_to_all_followers!`). Do not read it as
  reach. Carried by the registry's local optional capability
  `deliverToExtraAudiences`.

## Cross-protocol merge

One Bluesky account held natively over atproto and again over ActivityPub
through Bridgy Fed collapses onto ONE Oxy identity — both connectors resolve
through the shared `resolveFederatedActorIdentity`
(`connectors/identity.ts`), so the merge cannot depend on which one happens
to ingest the actor first. It matches a stored row either by
`FederatedActor.networkAcct` (bridged rows, which carry their real identity
explicitly, since the arriving host does not imply it) or by
`username@domain` (native rows — how the atproto connector has always stored
a Bluesky account, without ever writing `networkAcct`); matching only one
shape misses the other's rows entirely (10,000+ native atproto rows the
first version of this missed). A same-domain collision — two actors on ONE
source domain deriving the identical identity — is refused and logged at
error rather than merged: it means the derivation rule itself is broken
(most likely returning a constant), not that the accounts are the same
person.

## Federation Blocklist & Domain Purge

- **Blocklist**: `connectors/activitypub/federationBlockPolicy.ts` is the
  single committed policy — enforcement (`isBlockedDomain`) and the public
  transparency page read the SAME array. `FEDERATION_BLOCKED_DOMAINS` (env,
  comma-separated) unions in an urgent block that cannot wait on a deploy,
  published as `source: 'operational'`. Mention's own ActivityPub domains
  and the Oxy identity apex are excluded from the published list —
  enforcement-only, not a moderation decision.
- **Purge has two halves, each its own ECS Fargate one-shot workflow**
  (in-VPC, `main`-only, reuses the live service's role/secrets/subnets).
  `run-blocked-domain-content-purge.yml` drives `purgeBlockedDomainContent`
  — Mention's OWN posts, actor rows, engagement, and media cache.
  `run-blocked-domain-purge.yml` drives oxy-api's
  `POST /federation/domain-purge` — the federated identities and mirrored
  media OXY holds. Deletion is gated TWICE on the platform half:
  `confirm_write` must be the exact phrase in the workflow input, AND
  oxy-api separately requires `FEDERATION_DOMAIN_PURGE_ENABLED=true` on ITS
  OWN deployment (409 otherwise). `dry_run` defaults to `true` on both.
- Media-purge failures log the rejection REASON, not just a count —
  `purgeBlockedDomainContent`'s `Promise.allSettled` delete pass logs each
  failure's reason, and the `!isMediaCacheEnabled()` branch says so
  explicitly, since it is the one cause an operator can actually change.

## HLS media proxy — why it must rewrite, not relay

A federated `.m3u8` playlist is never relayed verbatim — it is buffered
(8 MiB cap) and REWRITTEN so every URI it contains comes back through
`/media/proxy` (`utils/hlsManifest.ts`, RFC 8216 line-oriented rewrite;
nested variant playlists rewrite recursively because fetching one re-enters
the proxy). Pass-through is not an option: real playlists (Bluesky's) use
RELATIVE URIs, which a client resolves against `/media/proxy?url=…` and
never finds. Each emitted URI carries an HMAC (`utils/hlsSignature.ts`, key
derived from `OXY_SERVICE_API_SECRET`) — that signature is the ONLY thing
that lets `application/octet-stream` through the content-type gate, which is
how object-store segments (e.g. `video.cdn.bsky.app`) play without turning
the proxy into a general binary relay. Playlists are excluded from
`isAllowedMediaType`, so the S3 cache never stores one (a cached playlist
would be served back un-rewritten); `decideProxyServe` also refuses to serve
an HLS row from Oxy.

HLS playback is HALF backend, half frontend: Safari/iOS decode HLS, desktop
Chrome/Firefox do not, so on web the source goes to hls.js over MSE
(`packages/frontend/lib/hlsPlayback.web.ts`, matched by `utils/hlsSource.ts`
recognising the PROXIED spelling). It attaches to the same `<video>`
expo-video renders (`VideoView.nativeRef`), so play/pause/mute/timeUpdate
keep coming from expo-video and hls.js only supplies bytes; the source is
withheld from `useVideoPlayer` while hls.js is active. `hlsPlayback.native.ts`
is inert — ExoPlayer/AVPlayer decode HLS natively.
