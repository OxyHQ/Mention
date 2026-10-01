# Federation behaviors and edge cases

Deep detail behind the rules in `AGENTS.md` § Federation rules. Read
`docs/fediverse.mdx` first for the protocol surface and connector contract —
this file is the accumulated edge-case knowledge on top of it.

## Protocol support at a glance

What Mention speaks, compared with Mastodon 4.7. "Oxy" means the work belongs
to oxy-api or `@oxy.so/federation`, and Mention adapts once it ships.

| Feature | Status | Where |
|---|---|---|
| HTTP signatures, draft-cavage `rsa-sha256` | Supported | `@oxy.so/federation`, signing in oxy-api |
| HTTP signatures, RFC 9421 | Not yet (Oxy) | [OxyHQ/oxy#1502](https://github.com/OxyHQ/oxy/issues/1502) |
| FEP-521a keys (Ed25519 / ML-DSA-44) | Not yet (Oxy) | [OxyHQ/oxy#1502](https://github.com/OxyHQ/oxy/issues/1502) |
| FEP-8b32 Object Integrity Proofs | Not yet (Oxy) | [OxyHQ/oxy#1502](https://github.com/OxyHQ/oxy/issues/1502) |
| FEP-e232 quote `Link` tag, FEP-044f `quote` | Supported, in and out | `extractApQuoteUri`, `buildCreateNoteActivity` |
| FEP-8967 link previews, inbound | Card text kept as a fallback | `apLinkPreview.ts`, `post_link_previews` |
| FEP-8967 link previews, outbound | Not yet (Clarity) | [OxyHQ/Clarity#74](https://github.com/OxyHQ/Clarity/issues/74) |
| `Move` to a local account | Supported (Oxy applies it) | `move.service.ts` |
| `Move` between two remote servers | Recorded and shown; follows not moved (Oxy) | `recordRemoteMove`, [OxyHQ/oxy#1502](https://github.com/OxyHQ/oxy/issues/1502) |
| Remote handle changes | Supported | `freeStaleHandle` in `actor.service.ts` |
| Private signing keys at rest | None stored in Mention (custody in oxy-api) | migration 0059 |

## A handle that changed hands

`federated_actors.acct` and `(domain, username)` are unique. A remote account
can rename (a new `preferredUsername` on the same URI). Its old handle can then
be taken by another account, or a deleted account's handle can be reused. Either
way, the cache still has the OLD holder under that handle, and the new owner's
upsert collides.

On that collision, `upsertActorFreeingStaleHandle` (`actor.service.ts`)
re-fetches the stale holder and retries the upsert once:

- **It renamed**: the refresh moves it onto its new handle.
- **It is gone** (410, tombstoned): `releaseGoneActorHandle` moves its handle to
  `<name>~gone-<id>@<domain>`, a spelling no WebFinger handle can have. The row
  and everything keyed on its URI stay.
- **It still claims the handle, or is only unreachable** (404, timeout): the
  write is refused as before. Taking a handle a live actor holds would let one
  server hijack another's identity, which is what the constraints exist to stop.

## A remote account that moved to another server

A `Move` whose target is another server cannot be applied by Oxy today. Oxy only
moves accounts onto local ones. Before forwarding the Move to Oxy,
`recordRemoteMove` (`move.service.ts`) makes the same bilateral check Mastodon
makes. The engine has already verified that the old actor signed the Move, and
the target, fetched fresh, must list the old actor in `alsoKnownAs`. If both
hold, it writes `federated_actors.moved_to`. The profile-design DTO carries it
as `remote.movedTo { handle, actorUri }`, and the profile shows "This account
has moved to @handle" (`ProfileMovedNotice`). The actor resolver cannot see
`movedTo`, so a profile refresh leaves the recorded move in place. Local follows
are not moved; that is OxyHQ/oxy#1502.

## A federated post's own link card (FEP-8967)

A server implementing FEP-8967 attaches each previewed link as `{ type: 'Link',
href, preview: { name, summary, image, … } }`. `extractApLinkPreviews` keeps only
the card's text, from https links, as plain text, capped and deduplicated. All
three ingest paths store it in `post_link_previews` with
`storeRemoteLinkPreviews`, best-effort:

- the inbox `Create`;
- the inbox `Update`, which replaces the cards;
- the outbox backfill, for inserted rows only.

Hydration (`buildClarityDocumentMap`) shows a stored card only for a link
Clarity has NO document for, whether pending or given up on, and only on the
post that carried it. Two rules keep it safe:

- **No image.** A remote image URL would send every reader's request to a host
  the author chose.
- **Keyed by post, not URL.** Otherwise one server could rewrite the card of a
  link on everyone else's posts.

Seeding Clarity from these cards, and emitting `preview` on our own Notes, needs
Clarity: OxyHQ/Clarity#74.

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

## Oxy owns bridge identity and public biography normalization

Mention resolves each source through Oxy's verified identity endpoint. It does
not identify mirror accounts from biography prose, match handles across
networks, or maintain its own source-profile derivation list. The public name,
biography, network handle and active aliases all come from Oxy.

Mention's `repostTransportPolicy.ts` is limited to the content rule above: known
transports can flatten reposts into misleading `RT:` bodies. It does not carry
identity or profile-normalization rules. Domain blocking remains Mention's
separate delivery/content policy in `federationBlockPolicy.ts`.

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

Mastodon negative-caches failed resolutions for minutes to hours. After
fixing a resolution bug, cache-bust by searching the full profile URL — a
different cache key than the plain `acct:` handle.

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

Oxy decides it. One Bluesky account held natively over atproto and again over
ActivityPub through Bridgy Fed resolves to ONE Oxy identity because every
connector asks Oxy's `/federation/identities/resolve` with the source actor
URI (`connectors/oxyIdentity.ts`) and takes the user and `canonicalAcct` it
returns. Mention keeps no merge, alias or equivalence logic of its own, so
discovery order cannot change the answer (OxyHQ/oxy#1253).

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

## An erased account still has Deletes to deliver

When Oxy reports an account deleted, the erasure (`docs/account-erasure.md`)
queues a `Delete(Tombstone)` per public post and a `Delete` of the actor, then
removes the account's rows. The deliveries outlive the account by up to about 63
hours of retries, and two things they need would be gone by then:

- **The handle.** Actor, Note and key ids are minted from it and Oxy no longer
  resolves the user. The delivery worker (`resolveSenderUsername` in
  `queue/workers.ts`) and the fallback-queue retry both fall back to
  `account_erasures.username`, which the reconciliation job clears 14 days after
  the erasure completed.
- **The signing key.** Oxy signs on Mention's behalf from `federation_key_pairs`,
  keyed by key id rather than by user row, and does not delete it with the
  account. A future key purge in Oxy has to wait out the relying parties'
  delivery window, or these Deletes fail to sign.

A re-run of an erasure must not cancel the Deletes an earlier attempt queued, so
the drain step spares queued rows whose activity type is `Delete`, and the actor
Delete carries a deterministic id so a re-send dedupes per inbox.

## HLS media proxy — why it must rewrite, not relay

A federated `.m3u8` playlist is never relayed verbatim — it is buffered
(8 MiB cap) and REWRITTEN so every URI it contains comes back through
`/media/proxy` (`utils/hlsManifest.ts`, RFC 8216 line-oriented rewrite;
nested variant playlists rewrite recursively because fetching one re-enters
the proxy). Pass-through is not an option: real playlists (Bluesky's) use
RELATIVE URIs, which a client resolves against `/media/proxy?url=…` and
never finds. Each emitted URI carries an HMAC (`utils/hlsSignature.ts`, key
derived from `MENTION_PRIVATE_KEY`) — that signature is the ONLY thing
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

**Never gate HLS support on `canPlayType`** — Chromium answers `"maybe"` for
`application/vnd.apple.mpegurl` and then fails to actually play it; probe
`MediaSource.isTypeSupported` instead. `import('hls.js')` must stay a
SINGLE call site — a second dynamic import promotes the demuxer into the
eager `__common.js` chunk (see `~/Oxy/AGENTS.md` § Metro web chunking).

The SSRF guard for every media route above (`/media/proxy`, `/media/poster`,
`/media/gif`) is upstream — `assertSafePublicUrl`/`isBlockedIp` from
`@oxy.so/core/server` — never a local copy in `utils/mediaResolver.ts`.
`GET /media/poster` needs a `video/*` upstream content type; pointing it at
an HLS playlist URL 415s. The S3 activity cache is gated on
`FEDERATION_MEDIA_CACHE_WRITE_ENABLED`, which is ON by default; setting it to
`false` leaves the proxy working, it just never writes to S3.

**A bad or missing federation service credential fails signed fetch
silently (0 posts imported)**, and the outbox-sync cooldown makes that
empty first sync permanent until `lastOutboxSyncAt` is cleared. Invisible
at `LOG_LEVEL=info` — service-token failures log at `error`/`warn` only.
