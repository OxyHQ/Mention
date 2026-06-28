# Native GIF Library (full import, local-first search)

## Goal

Stop depending on Klipy at read time. **Copy** GIFs natively into Mention — exactly
like federated content is imported, not a TTL cache. Every GIF we encounter is
downloaded into Mention's Oxy S3, indexed in our DB, and served from
`cloud.oxy.so`. Search hits our own index first, then tops up from Klipy in
parallel and imports whatever is new. Result: fast, on our own servers, minimal
external API calls (Klipy is free now but won't stay free).

Mirrors the existing `FederatedMediaCache` import pattern (`services/mediaCache/*`,
reserved S3 namespace, CDN-served).

## Model — `src/models/Gif.ts` (collection `gifs`)

```
{
  klipyId: string            // unique index — dedup key (source id)
  source: 'klipy'
  slug, title: string
  searchTerms: string[]      // normalized: query terms that surfaced it + title/slug/tags tokens
  width, height: number
  mp4FileId: string          // Oxy fileId of imported mp4 (the post source)
  previewFileId: string      // Oxy fileId of small mp4 preview (the picker grid)
  useCount: number           // times posted
  searchHitCount: number     // times surfaced in search
  lastUsedAt: Date
  createdAt: Date
}
```

- Unique index on `klipyId`. Index on `lastUsedAt`, `useCount`.
- `$text` index on `searchTerms` + `title`, declared with `default_language:'none'` /
  sentinel `language_override` to avoid the error-17262 free-form-language gotcha.

## S3 / ownership

- Reserved namespace `gif-library` on Oxy S3, **deduped by `klipyId`** → ONE object
  per GIF, shared across all users/posts (a GIF posted by N users = 1 object).
- Server-side upload via the SAME Oxy service-token upload path the federated media
  cache uses (`services/mediaCache/*` → reserved-namespace asset upload). Do NOT
  invent a new upload mechanism.
- Stores: `mp4` (post) + small `mp4` preview (grid). Served via `cloud.oxy.so/<id>`.
- No TTL eviction in MVP — we own these. (A conservative never-used cleanup can be
  added later if storage grows; out of scope here.)

## Search — `GET /gifs/search?q=` and `GET /gifs/trending`

1. **Local-first:** query the `Gif` `$text` index → our hits, ranked by relevance +
   `useCount` + recency. Zero external latency.
2. **External top-up (parallel):** call Klipy, merge AFTER local results, dedup by
   `klipyId`.
3. **Import (async, best-effort, fire-and-forget):** for surfaced Klipy items not yet
   in our library, download mp4 + small-mp4 preview → upload to `gif-library` → upsert
   `Gif`, appending the normalized query term to `searchTerms`. Single-flight per
   `klipyId`, bounded concurrency. The request NEVER blocks on import and NEVER fails
   because import failed.

Response (unchanged shape): `{ gifs, hasNext, page }` where
`GifItem = { id, klipyId, slug, title, mp4Url, previewUrl, width, height }`:
- `id` = our `Gif._id` when imported, else `''`.
- `mp4Url` / `previewUrl` = `cloud.oxy.so/<fileId>` when imported, else the Klipy
  mp4 / small-mp4 passthrough (so the first-ever search still renders).

## Select / post — `POST /gifs/use`

Body `{ klipyId }` (+ minimal item fields so a never-seen GIF can be imported
on demand). Backend `ensureImported(klipyId)` → imports synchronously if missing →
returns `{ gifId, fileId, mp4Url }`. The client attaches `{ id: fileId, type: 'gif' }`
to the post (the SHARED library fileId — no per-user re-upload) and `recordUse`
bumps `useCount`/`lastUsedAt`.

This replaces the current client-side `oxyServices.uploadRawFile` on GIF select.

## Picker grid

Render small **mp4** preview tiles (user preference) from `previewUrl` — looping
muted inline video, reusing the `VideoPlayer` `gif` mode. FlatList virtualization
keeps only ~9-12 players active. Fallback to the gif/webp thumb if `previewUrl` is
empty.

## Env / safety

- Kill-switch `GIF_LIBRARY_WRITE_ENABLED` (default **true** — the user wants it on;
  unlike the federated cache which defaults off). When false: pure Klipy passthrough,
  no imports.
- Import is best-effort; search/trending always return results even if S3 is down.

## Scope

Entirely Mention backend + frontend. No oxy-api change (reuses existing asset
upload). No infra change required to enable (default on).

## Out of scope (later)

- LRU/cleanup of never-used imports if storage grows.
- Animated-webp grid alternative (chose mp4 per user).
- Backfill of the handful of pre-existing `.gif`-stored test posts.
