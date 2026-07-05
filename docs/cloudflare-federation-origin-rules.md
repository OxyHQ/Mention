# Cloudflare rules to serve federation + profile/post from the backend (no Worker)

Goal: remove the CF Pages `_worker.js` entirely. These native Cloudflare rules on the
**`mention.earth`** zone transparently route federation endpoints AND the profile/post
pages to the backend (`api.mention.earth`), so no Pages Functions are needed. All are
available on the **Free** plan.

## Why the two rules (the ALB detail)
The shared ALB routes to the Mention backend **by Host header** (`host_headers = ["api.mention.earth"]`,
`oxy-infra/terraform-uswest2/app-services-realtime.tf:10`). So CF must send `Host: api.mention.earth`
or the ALB won't route to the backend. But Mastodon signs its HTTP signatures over the **apex**
host (`mention.earth`), and the backend verifies against `X-Forwarded-Host` (falling back to `Host`)
— `packages/backend/src/connectors/activitypub/crypto.ts:266`. So we send `Host: api.mention.earth`
(for ALB routing) **and** `X-Forwarded-Host: mention.earth` (for signature verification). This is
exactly what the current worker does.

---

## Rule 1 — Origin Rule (Rules → Overrides / Origin Rules)
**When incoming requests match** (Custom filter expression):
```
(http.request.uri.path eq "/ap") or
(starts_with(http.request.uri.path, "/ap/")) or
(http.request.uri.path eq "/.well-known/webfinger") or
(http.request.uri.path eq "/.well-known/host-meta") or
(http.request.uri.path eq "/.well-known/host-meta.json") or
(http.request.uri.path eq "/.well-known/nodeinfo") or
(http.request.uri.path eq "/.well-known/atproto-did") or
(starts_with(http.request.uri.path, "/nodeinfo/")) or
(starts_with(http.request.uri.path, "/xrpc/")) or
(starts_with(http.request.uri.path, "/@")) or
(starts_with(http.request.uri.path, "/p/"))
```
**Then (settings):**
- **DNS record / Origin (Destination) override →** `api.mention.earth`
- **Host Header →** rewrite to `api.mention.earth`
- (Destination port 443 / preserve.)

This makes CF fetch these paths from the backend ALB instead of Pages, transparently (same URL, no redirect).

## Rule 2 — Transform Rule → Modify Request Header (Rules → Transform Rules → Modify Request Header)
**When incoming requests match:** *(same expression as Rule 1 — or at minimum the federation paths; applying it to all matched paths is harmless)*
**Then — Set static:**
- Header name: `X-Forwarded-Host`
- Value: `mention.earth`

So the backend reconstructs the signed `host` line as `mention.earth` even though the ALB saw `Host: api.mention.earth`.

---

## What the backend now serves for these paths
- `/ap/*`, webfinger, host-meta, nodeinfo, `/xrpc/*`, `/.well-known/atproto-did` → existing AP/bridge routes (unchanged; they already worked when the worker proxied them).
- `/@:username` (+ sub-tabs) → new web-shell handler: AP `Accept` → 302 to `/ap/users/:username`; browser/crawler → SPA `index.html` with profile OG injected.
- `/p/:id` → new web-shell handler: SPA shell with post OG injected.
- Everything else (home, feed, settings, all static assets) → still served by CF Pages (static). No backend, no Functions.

## Switch order (IMPORTANT — do not break federation)
1. Deploy the backend web-shell handler + the runtime PWA manifest (code — done separately).
2. Add Rule 1 + Rule 2 in the CF dashboard.
3. **Test** (below) — federation + OG now flow through the backend via the Origin Rule (which bypasses the Pages worker for those paths).
4. Only once green: delete `packages/frontend/public/_worker.js` + `_routes.json` and redeploy the frontend. Frontend is now pure static → can drop to the Free plan.

## Test plan (after Rule 1 + 2 are live)
```
# federation: webfinger + actor (proxied to backend, no redirect)
curl -s "https://mention.earth/.well-known/webfinger?resource=acct:nate@mention.earth" | head
curl -s -H 'Accept: application/activity+json' "https://mention.earth/ap/users/nate" | head -c 200
# profile OG (browser) + AP discovery (302)
curl -s "https://mention.earth/@nate" | grep -o 'og:title[^>]*'
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H 'Accept: application/activity+json' "https://mention.earth/@nate"
# post OG
curl -s "https://mention.earth/p/<id>" | grep -o 'og:title[^>]*'
# home still static (no backend, no OG)
curl -s "https://mention.earth/" | grep -c og:title   # -> 0
# Mastodon inbox POST signature verifies — confirm by following a Mention user from a Mastodon account.
```

## Caveat to watch when applying
CF Pages custom domains + an Origin Rule overriding to an **external** origin (the ALB) is a slightly
unusual combo. If Rule 1 doesn't take effect on the Pages-backed apex, the fallback is a Cloudflare
**Configuration/Page Rule "Resolve Override"** to `api.mention.earth` for the same paths (same idea).
Verify with the webfinger/actor curls above right after adding the rules.
