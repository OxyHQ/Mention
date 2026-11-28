# mention.org: Mention's primary domain

Owner decision, 2026-11-28: **mention.org becomes Mention's primary domain**, in place of
mention.earth. Afterwards mention.earth redirects to mention.org forever, and nothing may break.
This document is the inventory, the plan and the record of what was done. Every step is measured
and reversible, and its rollback is next to it.

Status:
- **Phase 0 (inventory):** done.
- **Phase 1 (dual-host):** live on 2026-11-28 through a temporary bridge, with the final routing in
  progress (below).
- **Phase 2 (canonical switch):** waits for the owner's approval of this plan.

## The decision in one paragraph

mention.org becomes the domain people see: the web app, share links, canonical URLs, search
results and new app links. mention.earth remains Mention's **federation identity**, permanently:
- ActivityPub actor IDs, object IDs, inboxes, key IDs and `@user@mention.earth` stay on
  mention.earth. They are served there and never redirected.
- `api.mention.earth`, `mcp.mention.earth` and `cloud.mention.earth` keep answering forever.
- Human page views on mention.earth get one 301 to the same path on mention.org.

A real fediverse domain move (`Move` for every account) is feasible but not worth it. See
[Federation](#federation-the-big-risk).

## Hosts

| Host | Today | Phase 1 | Phase 2 | For good |
| --- | --- | --- | --- | --- |
| `mention.earth` | Web, OG, sitemaps, ActivityPub, `.well-known` (backend on `oxy-edge`) | unchanged | Humans: 301 to `mention.org`, path kept. Federation, `.well-known`, assets and non-GET: served | federation identity |
| `mention.org` | did not resolve | same app as mention.earth, canonical still mention.earth | canonical | primary |
| `www.mention.org` | did not resolve | 301 to `mention.org` | same | same |
| `api.mention.earth` | API | unchanged | unchanged, never redirected | serves forever (old native builds, stored media URLs, Oxy webhooks, federation fetches) |
| `api.mention.org` | did not resolve | alias of the API (after oxy-infra#521) | new builds may use it | alias |
| `mcp.mention.earth` | remote MCP | unchanged | unchanged | stays the MCP resource: OAuth grants are bound to it (`MENTION_MCP_RESOURCE`) |
| `cloud.mention.earth` | media CDN (DigitalOcean Spaces) | unchanged | unchanged | stored URLs |
| `shell.mention.earth` | internal web-shell Worker, 403 without the key | unchanged | unchanged | internal |
| `auth.mention.earth` | proxied CNAME to `oxy-auth.pages.dev` | not mirrored | review separately | legacy |
| `www.mention.earth` | no record (502) | unchanged | optional: 301 to `mention.org` | |

## Phase 0: inventory

Measured on 2026-11-28 with `grep -rI "mention\.earth"` across `~/Oxy/` (origin/main of Mention,
oxy and oxy-infra, the default branch of every other repo; node_modules, lockfiles, generated
native projects and build output excluded). There were 511 files: 354 in Mention, oxy and
oxy-infra, 157 elsewhere, most of them tests, docs and fixtures. The live state was read from
Cloudflare's API and with `curl`.

### Web and backend (Mention)

- **One apex host.** `packages/backend/src/middleware/apexFrontendProxy.ts` derives a single
  `APEX_HOST` from `MENTION_WEB_ORIGIN`. A request for any other host is treated as an API request,
  so `Host: mention.org` got API 404s and no web app. Phase 1 adds `MENTION_WEB_ALIAS_ORIGINS`
  (Mention dual-host PR).
- **CORS** (`utils/allowedOrigins.ts`) allows only `FRONTEND_URL` in production. Every other origin
  gets `Access-Control-Allow-Origin: https://mention.earth`.
- **CSP** `connect-src` names `api.mention.earth` only (`app.ts`).
- **Canonical, OG, JSON-LD and sitemap `<loc>`** come from `config.web.origin`
  (`services/webshell/webShellRenderer.ts`, `seoSitemap.ts`). `robots.txt` names
  `Sitemap: https://mention.earth/sitemap.xml`. Switching the canonical is a configuration change
  plus the alias.
- **The client-side canonical.** `packages/frontend/components/SEO.tsx` builds `canonical`,
  `og:url` and `twitter:url` from `window.location.origin`. On mention.org that would rewrite the
  canonical to mention.org after hydration, and Googlebot renders JavaScript. Phase 1 pins it to
  `WEB_BASE_URL`.
- **Sign-in redirect.** `packages/frontend/config.ts`: `OXY_AUTH_REDIRECT_URI` is a build-time
  constant (`https://mention.earth`). On web it must follow the page's origin when that origin is
  a known Mention origin.
- **Single-host constants.** The frontend hard-codes `https://mention.earth` in
  `utils/postPermalink.ts`, `components/SEO.tsx`, `ChannelScreen.tsx`, `WhoToFollowTab.tsx`,
  `Profile/ConnectionsScreen.tsx`, `Profile/hooks/usePersonProfileView.tsx`, `lists/[id].tsx`,
  `live-rooms/[id].tsx` and `CommunityNotes/useCommunityNoteSheets.tsx`. Everything else reads
  `WEB_BASE_URL` (`EXPO_PUBLIC_WEB_BASE_URL`). These links still work after Phase 2 because the
  301 sends them to mention.org. Phase 2 moves them to `WEB_BASE_URL`.
- **The fediverse handle shown in settings** is `@user@${WEB_BASE_URL host}`
  (`components/settings/pages/fediverse/index.tsx`). It must read the federation domain before
  `WEB_BASE_URL` changes, or people would be shown `@user@mention.org`, which WebFinger refused
  until Phase 1.
- **Own-link recognition.** `utils/ownProfileLinks.ts` (frontend) and `OWN_DOMAINS`
  (`connectors/activitypub/ownDomain.ts`), `utils/clarityDocuments.ts` (backend) know one host.
  Both hosts must count as "ours", or a pasted mention.org link would be fetched as a remote
  instance.
- **Web shell origin.** `shell.mention.earth` (`packages/frontend/wrangler.toml`,
  `worker/index.js`) is reached only by the backend. Nothing changes.
- **Post-page edge purge** (#2103, open) purges `${config.web.origin}/p/<id>` in **one zone**
  (`config.edgePurge.zoneId` = mention.earth) with a token that can purge **mention.earth only**
  (runbook 73). Consequence: mention.org does not get the `/p/*` edge-cache rule in Phase 1. In
  Phase 2 the purge must cover the mention.org zone before that rule moves there.
- **Deployment manifest trap.** `packages/shared-types/src/deployment.ts:126-145` forces
  `FEDERATION_DOMAIN`, `ACTOR_DOMAIN`, `MENTION_WEB_ORIGIN` and `FRONTEND_URL` to share one host.
  Production does not set `MENTION_DEPLOYMENT_CONFIG`, but this must be decoupled before anyone
  does.
- **Workflows and smoke scripts** default to mention.earth (`deploy-frontends.yml`
  `EXPO_PUBLIC_API_URL`, `smoke-mention.sh`, `smoke-frontend.sh`). They stay valid, since
  mention.earth keeps serving. Phase 2 adds mention.org checks.

### Sibling apps that allow `https://mention.earth` as an origin

Measured: from `https://mention.org`, `api.syra.fm/api/rooms/live-users` was blocked by CORS. The
same single-origin allowlists are in:
- Syra `packages/backend/src/middleware/apiCors.ts`
- Homiio `packages/backend/middlewares/publicCaseCors.ts`
- Peable `packages/backend/src/config.ts` (Mention+ payments)
- Vibbr `packages/backend/src/config.ts` (`embedOrigins`)
- Gemies `packages/api/src/lib/cors-origins.ts`
- Clarity `packages/backend/src/lib/app-origins.ts`

Each gets `https://mention.org` added (one PR per repo, Phase 1). Move only calls
`api.mention.earth`, which is unchanged.

### Oxy auth

There are no passkeys, no FedCM, no cookies and no RP ID (oxy ADR 0030 D8, ADR 0029 D4), so a
second registrable domain breaks no session. Each origin keeps its own device credential, joined
through the browser bridge on first sign-in, so a person is not signed out of Oxy. What gates
mention.org is **data on Mention's application row** (`6a2f851751b784a86fd0e916`,
`packages/api/src/scripts/seedOxyApplicationsSpecs.ts`):
- **`redirectUris`.** It feeds credentialed CORS and Socket.IO CORS on `api.oxy.so`, the CSRF
  origin guard, `requireOfficialOrigin` on every sign-in route, the OAuth `redirect_uri` exact
  match, the browser bridge, the Commons QR `originVerified`, linked-account `returnTo` and app
  invitations. It also authorises the hosts of Mention's federation signing keys, so
  **`https://mention.earth` is never removed from it.**
- **`webOrigins`** (`application_web_origins`): the app assertion for `platform: web`.
- Add `https://mention.org` to both, then run the seed. The seed only ever adds.
- Code allowlists: `packages/core/src/utils/officialOrigins.ts` (`OFFICIAL_APEXES`, not a sign-in
  gate) and `packages/telemetry/src/collector.ts` (`OXY_API_SERVICES`, attribution only).
- **The first-party registry (`actsForPeople`)** is keyed on the application ID, not on a domain.
  Nothing to change.
- **OxyCallerPolicy (Android)** is keyed on package plus signing certificate. `org.mention.app` and
  `.dev` are already allowed, and `earth.mention.app` stays until the owner's phones move.
- **Sign-in still never reveals whether an account exists.** An unregistered origin is refused
  with one generic 403 before any account lookup, and email/password sign-in does the same work
  for known and unknown identifiers. Adding an origin changes none of this.
- **`webhookUrl`** (`api.mention.earth/webhooks/oxy/account-events`) stays. Changing it rotates
  the webhook secret.

### Cloudflare

| Item | mention.earth (`6c2a616f…`, Business) | mention.org (`ddc06f6e…`, Pro) |
| --- | --- | --- |
| DNS | apex, `api`, `mcp`: proxied CNAMEs to `oxy-edge`; `shell`: AAAA `100::` (Worker); `cloud` to DO Spaces; `auth` to `oxy-auth.pages.dev`; 3 ACM validation CNAMEs; SPF `-all`, DMARC `p=reject`, Google site verification | added: apex and `www` (bridge, see Phase 1), SPF `-all`, DMARC `p=reject` |
| SSL | strict, TLS ≥ 1.2, HTTP/3 | set to the same |
| HSTS | from the backend: `max-age=31536000; includeSubDomains` (zone HSTS off) | the same, from the backend. **No preload** until Phase 2 has settled |
| `oxy_api_hosts` config/firewall/cache | `api` + `mcp` | mirrored for `api.mention.org` |
| Managed WAF | `api.mention.earth`: exemptions (webhooks, `/ap/`, Oxy egress IPs), then Cloudflare Managed Ruleset | mirrored for `api.mention.org` |
| `/p/*` cache (runbook 72) | `mention_post_pages_edge_cache` | **not mirrored**: the purge (runbook 73) cannot reach this zone yet |
| `.wasm` / static assets cache (runbook 74) | `mention_static_assets_edge_cache` | mirrored |
| Tiered cache | Smart Tiered Cache on | turned on |
| Argo | on | not on Pro. A later owner decision |
| Bot management | managed `robots.txt`, AI training disallowed | set to the same |
| Workers routes | `shell.mention.earth` (custom domain) | `mention-org-bridge` on `mention.org/*` and `www.mention.org/*` (temporary) |
| Origin Rules Host override | — | **refused on Pro** (`not entitled to use the HostHeader override`). This is why the bridge is a Worker |
| Body limit | 200 MB (Business) | 100 MB (Pro). Uploads go presigned above 64 MiB, so no change |

### Federation (the big risk)

How it is built (measured in code):
- Every outward identifier comes from `FEDERATION_DOMAIN` and `ACTOR_DOMAIN` (both default to
  `mention.earth`, `config/index.ts:346-347, 855`) through `@oxy.so/federation`'s URL builders,
  computed per request:
  - actor `https://mention.earth/ap/users/<u>`;
  - inbox, outbox, followers, following and featured under it;
  - sharedInbox `/ap/inbox`;
  - Note `…/posts/<id>`;
  - activities `…/boosts|likes|follows/<id>`.
- Persisted: `actor_key_pairs.keyId` (`…#main-key`), `federated_follows.activityId` ("must survive
  byte for byte") and the `tag:mention.earth,2026:` X-bridge IDs.
- Every remote server has stored our actor, inbox, followers and key URIs, and the Note IDs.
- WebFinger accepted only `acct:<u>@mention.earth` (`isSameFederationHost`, exact host), answers
  `subject: acct:<u>@mention.earth` and links to the actor. host-meta and nodeinfo point at
  mention.earth.
- Inbound HTTP signatures are checked against the host the request arrived with
  (`X-Forwarded-Host`), never against a configured host. A redirected POST would break the
  signature and the delivery.
- AT Protocol: Mention is read-only there. There is no PDS, no `did:web:mention.earth` and no
  `*.mention.earth` handles, so nothing depends on the domain.
- `Move`: inbound only. Mention has no outbound `Move`/`movedTo` for local users.

How the ecosystem handles a domain change (research, sources below):
- **Mastodon says `LOCAL_DOMAIN` "cannot be safely changed later".** Remote servers treat changed
  actor IDs as new accounts. Redirects do not move followers.
- **A whole-server move means a `Move` per account.** Only followers move, and only on software
  that processes `Move` (Mastodon, GoToSocial, Pleroma/Akkoma, the Misskey family, Mitra; not
  Lemmy, PeerTube or Threads).
  - Lost: who our people follow, posts, likes, boosts, replies and every old object ID.
  - Limits: a 7-day lock per account and a 30-day cooldown on Mastodon.
- **FEP-a427** ("Server Domain Migration") is a draft with no implementations. No instance is
  documented as having moved domain successfully.
- **Mastodon follows a redirect on a first fetch, then insists on the object's own `id`.** It
  stores the object under its own ID and never renames an existing one.
- **The `LOCAL_DOMAIN`/`WEB_DOMAIN` split shows the safe shape.** The handle domain answers
  WebFinger, and the actor lives elsewhere. Mastodon confirms the handle by asking WebFinger on
  the actor's host. When an already-known actor ID verifies a new handle, it renames the account
  in place (`process_account_service.rb`, `rename_account!`), and follows and history stay.

**Recommendation (the owner's default, confirmed):**
1. **Actor and object IDs stay on `https://mention.earth/ap/...` permanently.** They are served
   there and never redirected. `FEDERATION_DOMAIN` and `ACTOR_DOMAIN` stay `mention.earth`, and the
   `ACTOR_DOMAIN` ≠ `FEDERATION_DOMAIN` split is not used.
2. **WebFinger answers on both hosts.** `acct:<u>@mention.org` resolves to the same actor, and the
   `subject` stays `acct:<u>@mention.earth` (Phase 1). Someone who types `@u@mention.org` in
   Mastodon finds the right account, and nothing changes for remote servers.
3. **The 301 on mention.earth exempts** `/.well-known/*`, `/ap/*`, `/nodeinfo/*`, every non-GET,
   and any request whose `Accept` names `application/activity+json` or `application/ld+json`
   (content negotiation on `/@u` and `/p/<id>`).
4. **The `@user@mention.earth` handle stays the displayed fediverse handle in Phase 2.**
   - Switching handles to `@user@mention.org` is a possible later Phase 3: change the WebFinger
     `subject` and add FEP-2c59 `webfinger` to the actor, keeping the IDs.
   - Mastodon would rename accounts in place. Some non-Mastodon software may keep showing
     `@mention.earth`, which is cosmetic.
   - The cost is low, but it is a separate owner decision, measured on a QA account first.
5. **The human `url`/`profile-page` fields** in actor and Note objects can point at mention.org in
   Phase 2. That needs a web-domain input in `@oxy.so/federation` (oxy), which builds them from
   the federation domain today. It is optional: until then they point at mention.earth, which
   301s.

**A real move is feasible, at this cost:**
- a `Move` for every account, in batches under the 7-day/30-day limits;
- our people's follows re-sent by hand;
- followers on Lemmy, PeerTube and Threads lost;
- every old post orphaned (Mastodon's same-host check on an object's author);
- mention.earth kept up for at least 90 days anyway.

It loses data for a cosmetic gain. **Not recommended.**

Sources:
- <https://docs.joinmastodon.org/admin/config/>
- <https://docs.joinmastodon.org/spec/webfinger/>
- <https://docs.joinmastodon.org/user/moving/>
- `mastodon/app/services/activitypub/process_account_service.rb` and `fetch_resource_service.rb`
- <https://fediverse.codeberg.page/fep/fep/a427/>
- <https://docs.gotosocial.org/en/latest/user_guide/migration/>
- <https://masto.host/can-i-change-the-domain-name-of-my-mastodon-server/>

### Email

- Mention sends no mail.
- mention.earth publishes `v=spf1 -all` and `DMARC p=reject; adkim=s; aspf=s` and has no MX. Oxy's
  mail is `@oxy.so` (`~/Oxy/docs/outbound-mail-relay.md`).
- No email links to mention.earth: the Oxy welcome email names Mention without a URL.
- mention.org was given the same null-mail records in Phase 1, so nobody can spoof it.
- Nothing else is needed. If Mention ever sends mail, that is its own project (SES identity, DKIM).

### Apps

- **Android**
  - `app.config.js` has an `autoVerify` intent filter for `https://mention.earth` only. The
    package moves to `org.mention.app` (#2061, open), and `earth.mention.app` stays in every Oxy
    allowlist and in `assetlinks.json` (`RETIRING_MENTION_APP_IDS`) until the owner's phones move.
  - Live `assetlinks.json` names only `earth.mention.app` with one fingerprint. The repository
    variable `ANDROID_APP_SIGNING_SHA256` (Play key) is not set.
- **iOS**
  - `associatedDomains: ['applinks:mention.earth']`.
  - **The AASA answers 404** because the repository variable `APPLE_TEAM_ID` is not set. Universal
    links do not work today on any host.
- **Both documents are served by the backend for any host.** Measured: `mention.org/.well-known/assetlinks.json`
  answers 200 with the same document.
- **Order:**
  1. mention.org serves both documents (Phase 1, done for assetlinks).
  2. A native build adds `mention.org` to the Android filter and `applinks:mention.org`, keeping
     `mention.earth` in both forever. A tapped mention.earth link then opens the app before any
     redirect.
  - On Android 11 and below, one unverifiable host fails the whole filter, so the build ships only
    after step 1 is verified.
- `+native-intent.tsx` routes by path only, so both hosts route the same.

### Third parties and registered URLs

| What | Registered URL today | Action |
| --- | --- | --- |
| Google Search Console | `mention.earth` (TXT `google-site-verification` in DNS) | Phase 1: verify `mention.org` as a Domain property. Phase 2: Change of Address |
| Bing Webmaster Tools | unknown | Phase 2: Site Move tool, if the property exists |
| Apple Developer | team ID not set in the repo | set `APPLE_TEAM_ID`; associated domains ship in the native build |
| Google Play / Firebase | `earth.mention.app`; `org.mention.app` waits on Firebase | the Firebase setup for `org.mention.app` (#2061); set `ANDROID_APP_SIGNING_SHA256` |
| Apple Pay / Peable wallet domain | `mention.earth` is Peable wallet domain `pmd_c94063dcd8e3606cb895864f` (`docs/mention-plus-payments.md`) | register `mention.org` as a second wallet domain before Phase 2. The backend serves `/.well-known/apple-developer-merchantid-domain-association` on every host |
| Oxy application row | `websiteUrl`, `webOrigins`, `redirectUris` = mention.earth | Phase 1: add mention.org (oxy PR). Phase 2: `websiteUrl` to mention.org |
| MCP (Claude, ChatGPT) | `https://mcp.mention.earth` | unchanged. Grants are bound to that resource |
| Clarity job site | `mention.earth`, verified on Mention's Oxy account | Phase 2: verify `mention.org` and add a site, if job listings move |
| Cloudflare Web Analytics | beacon via the zone | check that mention.org reports after Phase 2 |
| Fediverse directories | instance `mention.earth` | unchanged, since the federation identity stays |
| OAuth clients, Google/Apple sign-in | Oxy owns them (`auth.oxy.so`, `api.oxy.so`) | nothing in Mention |

## Phase 1: dual-host (done 2026-11-28, low risk)

mention.org serves the same app and API as mention.earth. The canonical stays mention.earth
everywhere. Verified on 2026-11-28 before the final routing:
- mention.org pages carry `<link rel="canonical" href="https://mention.earth/...">` and `og:url`
  on mention.earth;
- `robots.txt` names `Sitemap: https://mention.earth/sitemap.xml`;
- sitemaps stay on mention.earth.

### 1a. Cloudflare zone mention.org (applied with the API, logged)

All of these are additions to a zone that served nothing.
1. Settings: `ssl=strict`, `min_tls_version=1.2`, `http3=on`, `opportunistic_encryption=off`,
   `replace_insecure_js=on`, `brotli=off`, Smart Tiered Cache on, managed `robots.txt` and the AI
   training block, all as on mention.earth.
   - **Rollback:** the defaults were `ssl=full`, `min_tls 1.0`, `http3 off`,
     `opportunistic_encryption on`, `replace_insecure_js off`, `brotli on`, tiered off, robots
     unmanaged.
2. Null mail: TXT `mention.org` `v=spf1 -all`; TXT `_dmarc.mention.org`
   `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;`.
   - **Rollback:** delete the records.
3. Rulesets, created as new entrypoints (the zone had none):
   - `http_config_settings` `oxy_api_hosts`;
   - `http_request_firewall_custom` `oxy_api_hosts`;
   - `http_request_cache_settings` `oxy_api_hosts` (no cache) and
     `mention_static_assets_edge_cache` (`/assets/`, `/_expo/static/`);
   - `http_request_firewall_managed` exemptions and Cloudflare Managed Ruleset. All for
     `api.mention.org`, except the static-assets rule (`mention.org`).
   - **Rollback:** disable or delete the rule by its `ref` (`GET …/rulesets/phases/<phase>/entrypoint`
     first, never `PUT` an entrypoint that has rules).

### 1b. The temporary bridge (live at 16:50 UTC)

Cloudflare refused a Host-header Origin Rule on the Pro zone, and the ALB did not route mention.org
yet. So mention.org went live through:
- **Worker `mention-org-bridge`**, routes `mention.org/*` and `www.mention.org/*`, DNS AAAA `100::`
  proxied for both.
  - It proxies every request to `https://mention.earth` (same path, method, headers and body) and
    rewrites a `Location` on mention.earth to mention.org.
  - `www` and `http:` answer a 301 to `https://mention.org` with the path kept.
  - The backend sees `Host: mention.earth`, so every document is byte-identical, canonical
    included.
- **Transform rule `mention_org_cors_bridge`** (mention.earth zone, `http_response_headers_transform`).
  - On `api.mention.earth`, when `Origin` is `https://mention.org`, it sets
    `Access-Control-Allow-Origin: https://mention.org`. Other origins are unchanged (measured:
    mention.earth and an unknown origin still get `https://mention.earth`).
- **Rollback (instant):**
  - delete the Worker routes, or the two AAAA records;
  - disable the transform rule.
  - mention.earth is not affected by either.

Measured through the bridge:
- `/`, `/@nate` and a post page: 200, the app;
- the feed loads in Chromium: `api.mention.earth/feed/mtn` 200, `/trending` 200, media 302;
- `/.well-known/assetlinks.json` 200;
- WebFinger 200;
- `robots.txt` 200;
- `http://` and `www`: 301.

Before the Oxy registration, sign-in from mention.org was blocked by CORS on `api.oxy.so`.

### 1c. The final routing (replaces the bridge)

1. **oxy-infra#521** (merged): `aws_acm_certificate.mention_org` (mention.org + api.mention.org),
   applied with `-target`, validated by two DNS-only CNAMEs in the mention.org zone.
   - The flag `attach_mention_org_listener_certificate` adds the SNI certificate, the two hosts on
     mention's edge rule (priority 50) and `mention_org_metrics_block_edge` (priority 46).
   - **Rollback:** flag false, then apply the same three addresses.
2. **Mention dual-host PR**:
   - `MENTION_WEB_ALIAS_ORIGINS` (default `https://mention.org`): the apex alias;
   - CORS for mention.org;
   - CSP `connect-src` for `api.mention.org`;
   - WebFinger `acct:<u>@mention.org` answered with the mention.earth subject;
   - the web sign-in redirect follows the page's origin;
   - the client canonical pinned to `WEB_BASE_URL`.
   - **Rollback:** revert.
3. **oxy PR**: `https://mention.org` in Mention's `redirectUris` and `webOrigins`, then the seed.
   - **Rollback:** list it in `retiredRedirectUris`, or remove it in Console. Never touch
     mention.earth.
4. **Sibling CORS PRs** (Syra, Homiio, Peable, Vibbr, Gemies, Clarity). **Rollback:** revert.
5. **DNS swap**, once 1 to 3 are live:
   - `mention.org` and `api.mention.org` become proxied CNAMEs to
     `oxy-edge-1674731341.us-west-2.elb.amazonaws.com`;
   - the Worker keeps only `www.mention.org/*` (or a Single Redirect replaces it);
   - the CORS transform rule is deleted.
   - **Rollback:** restore the AAAA records and the Worker routes (a few seconds).

### 1d. Phase 1 verification, on both hosts (QA accounts only, deleted afterwards)

- [ ] sign-in (email code) on `mention.earth` and on `mention.org`, in a fresh browser;
- [ ] the bridge join on the second host;
- [ ] home feed, a post page, a profile and media (image, video, GIF);
- [ ] an upload (post with image);
- [ ] notifications and the socket;
- [ ] a push notification's link;
- [ ] Android: `adb shell pm verify-app-links --re-verify`, then `pm get-app-links` on a build
  carrying both hosts (Pixel 10 Pro through hangar, install only; the Pixel 8a is on hold);
- [ ] WebFinger for `acct:<qa>@mention.org` and `@mention.earth`;
- [ ] a follow from a Mastodon QA account to `@<qa>@mention.org`;
- [ ] `smoke-mention.sh` with `WEB_ORIGIN=https://mention.org`.

## Phase 2: the canonical switch (only after the owner approves this plan)

Order. Each step is measured before the next one.

1. **Prerequisites:**
   - Phase 1 verified;
   - Search Console has `mention.org` verified;
   - the purge covers mention.org: a new token with Cache Purge on **both** zones (created with
     the API, as runbook 73 did), written to SSM `/oxy/mention/CLOUDFLARE_PURGE_TOKEN`, and #2103
     purging both hosts' URLs in their own zones;
   - the Peable wallet domain registered.
2. **Backend configuration** (oxy-infra `module.mention` env, Mention deploy):
   - `MENTION_WEB_ORIGIN=https://mention.org`, `FRONTEND_URL=https://mention.org`;
   - `MENTION_WEB_ALIAS_ORIGINS=https://mention.earth`;
   - `FEDERATION_DOMAIN` and `ACTOR_DOMAIN` stay `mention.earth`, set explicitly.
   - Canonical, OG, JSON-LD, sitemap `<loc>` and the `robots.txt` `Sitemap:` move to mention.org.
   - **Rollback:** the previous values, then `deploy-backend-config.yml`.
3. **Frontend:**
   - `EXPO_PUBLIC_WEB_BASE_URL=https://mention.org` (deploy-frontends, eas.json), with the
     hard-coded links moved to `WEB_BASE_URL`;
   - the fediverse handle read from the federation domain;
   - own-link recognition for both hosts.
   - The API stays `api.mention.earth` until a native build has shipped `api.mention.org` (an
     optional later step).
4. **Cloudflare, mention.org zone:** the `/p/*` cache rule (runbook 72) moves here, after the purge
   is live.
5. **The 301 on mention.earth** (`http_request_dynamic_redirect`, zone mention.earth).
   - One rule, `ref = mention_earth_to_org`, status 301, preserve query string. The target is the
     expression `concat("https://mention.org", http.request.uri.path)`.
   - When:
     ```
     http.host eq "mention.earth"
     and http.request.method in {"GET" "HEAD"}
     and not starts_with(http.request.uri.path, "/.well-known/")
     and not starts_with(http.request.uri.path, "/ap/")
     and not starts_with(http.request.uri.path, "/nodeinfo")
     and not starts_with(http.request.uri.path, "/assets/")
     and not starts_with(http.request.uri.path, "/_expo/static/")
     and http.request.uri.path ne "/robots.txt"
     and not any(lower(http.request.headers["accept"][*]) contains "activity+json")
     and not any(lower(http.request.headers["accept"][*]) contains "ld+json")
     ```
   - It is a single hop at the edge, path kept, query kept.
   - Assets keep serving on mention.earth, so an open tab with an old `index.html` still boots.
   - `robots.txt` keeps serving, so crawlers can see the redirects.
   - **Rollback:** disable the rule (one call, instant). Nothing to purge, because the 301 is not
     cached by the origin.
6. **Search Console:** Change of Address from `mention.earth` to `mention.org`, the same day as
   step 5, once five sample URLs answer a 301 to their mention.org twins. Submit
   `https://mention.org/sitemap.xml` on the new property, and keep the old sitemap submitted for
   about a month so Google re-crawls the redirects.
7. **Native build:** `applinks:mention.org` and the Android host `mention.org`, keeping
   `mention.earth`.
8. **Keep forever:** the 301, mention.earth's DNS and TLS, the federation paths, the API, the MCP
   and the media hosts. Google asks for at least 180 days and recommends a year. Here it is
   permanent.

### Phase 2 SEO: improve, not just survive

Measured on mention.earth on 2026-11-28 (`curl`, Lighthouse 12.8.2 mobile lab, a sample post and a
profile):

| Area | Today | Phase 2 target |
| --- | --- | --- |
| 301s | none (no other host existed) | one edge hop, path and query kept, exemptions above. Measured as `curl -I` = one 301, then 200 |
| Canonical | server-rendered on `/p/<id>`, `/@u`, `/`, `/hashtag/<t>` (`data-mention-seo`). The client `SEO.tsx` rewrote it from `window.location` (fixed in Phase 1) | `https://mention.org/...` from config on server and client. Self-canonical, never through a redirect |
| hreflang | none | Mention serves one URL per page in the viewer's language, so there are no language variants to link. Emit `hreflang="x-default"` only once per-language URLs exist. Do not invent alternates (a wrong hreflang is worse than none) |
| Sitemaps | index plus 128 post shards (40,000 URLs each) and 64 profile shards. Profile shards list **federated** profiles (`/@x@mastodon.social`, about 4,200 of about 4,260 in shard 00) | index plus per-type shards on mention.org (posts, local profiles, channels, hashtags), submitted on the mention.org property. Federated profiles removed from sitemaps: they are copies of other servers' pages, and they spend crawl budget |
| Structured data | `SocialMediaPosting` with Person author and `InteractionCounter` on posts; `ProfilePage` + Person on profiles; `WebSite` + `Organization` on home; `CollectionPage` on hashtags. **No `SearchAction`** | the same with mention.org `@id`s; `WebSite.potentialAction` = `SearchAction` to `/search?q={search_term_string}`; `DiscussionForumPosting` for threads with replies; `Organization` with `sameAs`. Validate with the Rich Results Test |
| Server-rendered body | **none**: the body is `You need to enable JavaScript to run this app.` for every user agent, Googlebot included. Only `<head>` (title, meta, OG, JSON-LD) is server-rendered | prerender a readable body for public post and profile pages (the text, author, time and the first replies, as semantic HTML) in the same web-shell response, then hydrate. This is the largest SEO gain available |
| OG / Twitter | full OG and Twitter card on post, profile and home | unchanged, on mention.org |
| Core Web Vitals (lab, mobile, Slow 4G, 4x CPU) | post: perf 0.22, **LCP 16.5 s**, FCP 11.5 s, TBT 1,980 ms, **CLS 0.152**. Profile: perf 0.28, LCP 16.2 s, FCP 11.4 s, TBT 1,770 ms, CLS 0.03. Field data (CrUX) not read: the PageSpeed API quota was spent | LCP < 2.5 s and CLS < 0.1 on public pages, by the prerendered body (LCP is text, not the app bundle) and fixed media boxes. INP measured in the field (Search Console CWV report, CrUX) before and after |
| robots.txt | Cloudflare-managed AI block plus the backend's `Allow: /` and `Sitemap:` | the same on mention.org; disallow unbounded spaces: `/search`, `/*?*` on app routes, `/p/*/likes`, `/p/*/reposts`, `/p/*/quotes`, `/@*/followers`, `/@*/following`, the media proxy. Federated profiles (`/@*@*`) first become `noindex,follow` with a canonical to their origin, and are **not** disallowed until Google has recrawled them and seen the noindex (weeks): a disallow would hide the noindex |
| Crawl budget | 99.9 % of `/p/<id>` origin hits are distinct URLs requested once, mostly headless crawlers on hosting ASNs (runbook 74) | the disallows above; tracking parameters stripped at the edge (redirect `?utm_*`, `fbclid`, `gclid` to the clean URL); unknown IDs answer 404/410 with `no-store`; Cloudflare's verified-bot allowance kept for search engines |
| Change of Address | not applicable | the same day as the 301 (step 6). Expect rankings to settle in weeks. Keep both properties |

## Owner steps (en castellano claro)

Hazlos cuando puedas. Los que dicen "ya" se pueden hacer ahora mismo.
1. **Google Search Console (ya).** Añade la propiedad de dominio `mention.org`. Google te da un
   texto `google-site-verification=...`: pásamelo y lo pongo en Cloudflare, o añádelo tú en
   Cloudflare > mention.org > DNS como registro TXT en `mention.org`. Todavía no uses "Cambio de
   dirección": eso va en la fase 2, cuando las redirecciones estén activas.
2. **Apple (ya).** En GitHub > OxyHQ/Mention > Settings > Variables, crea `APPLE_TEAM_ID` con tu
   Team ID de 10 caracteres (Apple Developer > Membership). Sin esto los enlaces universales de iOS
   no funcionan en ningún dominio.
3. **Google Play (ya).** Crea la variable `ANDROID_APP_SIGNING_SHA256` con la huella SHA-256 de
   Play Console > Integridad de la app, y termina la configuración de Firebase para
   `org.mention.app`.
4. **Apple Pay / Peable (antes de la fase 2).** Registra `mention.org` como dominio de pago (wallet
   domain), igual que está registrado `mention.earth`.
5. **Aprobar la fase 2.** Cuando la fase 1 esté verificada, dime "adelante con la fase 2".
6. **Bing (opcional).** Si tienes Bing Webmaster Tools con `mention.earth`, usa "Site Move" el día
   de la fase 2.

## Record

| UTC (2026-11-28) | Change | Rollback |
| --- | --- | --- |
| 16:44 | mention.org settings parity, Smart Tiered Cache, null-mail TXT records | settings back to the defaults listed in 1a; delete the records |
| 16:44 | mention.org bot management (managed robots, AI training disallowed) | `PUT /zones/<id>/bot_management` with the previous values |
| 16:45 | mention.org rulesets (config, firewall custom, cache, firewall managed) | disable or delete by `ref` |
| 16:49 | mention.org and www.mention.org AAAA `100::` proxied; Worker `mention-org-bridge` (version `56acaa5a`) | delete the routes or the records |
| 16:51 | mention.earth `mention_org_cors_bridge` (response header transform, Origin = mention.org only) | disable the rule |
| 16:58 | oxy-infra#521 merged; certificate apply dispatched | flag false; destroy the certificate if unused |
| 16:59 | ACM validation CNAMEs (DNS-only) in mention.org; certificate ISSUED | delete the records |
| 17:11 | oxy-infra#522 apply: mention.org and api.mention.org added to mention's edge rule, `mention_org_metrics_block_edge` created; the SNI attachment **failed**: `TooManyCertificates` (25 per ALB, all used) | flag false and apply the three addresses |
| 17:13 | Service Quotas request `L-9365A611` (certificates per ALB) 25 → 50 | none needed (a higher quota changes nothing by itself) |
