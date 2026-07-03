# Live-room podcast streaming — design

**Date:** 2026-07-03
**Status:** Approved (design) — pending user review of this spec
**Scope:** Let a live-room host search a Syra podcast, pick an episode, and stream that episode's audio into the room, reusing the existing LiveKit URL-ingress stream path and the existing Syra podcast search already used on profiles.

## Goal

In the live-room host controls (Stream Setup), add a **Podcast** mode. The host searches Syra podcast shows, drills into a show's episodes, and taps an episode to start streaming its audio into the room. All listeners hear it via the existing LiveKit ingress; the existing stream "now playing" card renders the episode metadata.

## Why this shape (evidence)

A "stream" in this system is fundamentally **an audio URL fed to a LiveKit URL ingress** (`packages/backend/src/routes/rooms.routes.ts:1136` `POST /:id/stream` → `createRoomUrlIngress`). To play a podcast, we must supply an episode's audio URL as that `url`.

Verified against the live Syra API (`https://api.syra.fm`):

- `GET /api/podcasts/search?q=` → podcast **shows** (already proxied by Mention `GET /profile/media/search?type=podcast`, `packages/backend/src/routes/profileMedia.ts:79`).
- `GET /api/podcasts/:id` → show detail, **no inline episodes** (`episodeCount`, `feedUrl`, `persons` only).
- `GET /api/podcasts/:id/episodes` → **public**, `{ data: Episode[], total, page, limit }`. Each episode carries:
  - `enclosureUrl` — a direct audio file, e.g. `https://api.fastcast.ai/audio/<guid>.mp3`
  - `enclosureType` — `audio/mpeg`
  - `duration` (seconds), `pubDate`, `image`, `title`
  - `hls` — an array, **empty** for the sampled episodes → do NOT rely on it; use `enclosureUrl`.
- `GET /api/episodes/:id` → **public**, `{ data: { episode, persons } }` — a single episode by id with the same `enclosureUrl`. Enables **O(1)** resolution at stream-start (no page scan).

The `@syra.fm/sdk` (v0.3.0) **strips episodes** from `getPodcast` and has no episodes method (`node_modules/@syra.fm/sdk/src/client.ts:106` comment). The SDK source is ours: `~/Oxy/Syra/packages/sdk`. Per the fix-upstream rule, we extend the SDK rather than hand-roll raw Syra HTTP inside Mention.

The `enclosureUrl` (`http`/`https`) passes the existing `POST /:id/stream` URL validation and feeds the ingress unchanged.

## Decisions locked

1. **Granularity:** host picks a **specific episode** (search show → episode list → tap episode). A show has no single audio URL, so episode selection is required, not optional.
2. **UI placement:** a new **"Podcast" tab** inside `StreamConfigPanel` ("Stream Setup"), alongside the existing **Stream URL** / **External App** tabs. Host-only (the panel is already host-gated).
3. **URL resolution:** **backend resolves.** The client sends `{ syraPodcastId, episodeId }`; the Mention backend resolves the `enclosureUrl` + title/artwork from Syra and starts the ingress. Matches the existing "never trust the client for Syra data" pattern (`sanitizePodcast`/`resolvePodcastContent`, `utils/syraPodcast.ts`) and avoids trusting a client-supplied media URL.

## Architecture — layers & changes

### Layer 1 — Syra SDK (`~/Oxy/Syra/packages/sdk`) — fix upstream

Add episode support to the public-catalog SDK.

- **`schema.ts`** — new `episodeSummarySchema` + `EpisodeSummary` type. Fields the consumers need (tolerantly strips the rest, like the other schemas):
  `{ id, podcastId, title, description?, enclosureUrl, enclosureType?, duration?, image?, imageSizes?, imageSourceUrl?, pubDate? }`.
  `enclosureUrl` is required — rows without it are unplayable and dropped.
- **`client.ts`** — two new interface methods + impls:
  - `getPodcastEpisodes(podcastId, options?: { limit?; offset? }): Promise<SearchPage<EpisodeSummary>>` → the real endpoint is **page-based** (`GET /api/podcasts/:id/episodes?page=&limit=`, response `{ data: Episode[], total, page, limit }`). The SDK keeps its `SearchPage` **offset-based** for uniformity with `searchPodcasts`: it converts `page = floor(offset/limit) + 1`, validates rows with `safeParse` (invalid/enclosure-less skipped), and returns `{ items, hasMore: page * limit < total, offset, limit }`. Callers (picker + Mention layer) stay offset-based; the page translation is hidden here. Powers the picker's episode list.
  - `getEpisode(episodeId): Promise<EpisodeSummary>` → `GET /api/episodes/:id`, parse `json?.data?.episode` (mirrors `getPodcast`'s `json?.data?.podcast`). Powers O(1) stream-start resolution.
  - Add an `episodeImageUrl(ep, size?)` helper mirroring `podcastArtworkUrl` (resolve `image`/`imageSizes`/`imageSourceUrl` → absolute URL).
- **`index.ts`** — export `EpisodeSummary` (+ schema if others are exported).
- **`client.test.ts`** — add `getPodcastEpisodes` + `getEpisode` tests mirroring existing tests (mock fetch, assert URL, validation, hasMore / `data.episode` unwrap).
- **Publish:** bump SDK version, commit + push Syra, `bun publish` (via the `publish` skill: pack + inspect + verify propagation with a clean external install + import). Then bump `@syra.fm/sdk` in Mention backend `package.json` + `bun install` (lockfile in the same commit).

### Layer 2 — Mention backend

**`packages/backend/src/utils/syraPodcast.ts`** — add server-side resolvers (denormalize from Syra, never trust client):

- `listPodcastEpisodes(podcastId, { offset }) → { items: EpisodeListItem[]; hasMore; offset }` via SDK `getPodcastEpisodes`, for the picker. `EpisodeListItem = { episodeId, title, durationSec?, publishedAt?, artworkUrl? }` — **no audio URL leaked to the picker** (it's not needed there and stays server-owned).
- `resolvePodcastEpisode(episodeId, expectedPodcastId?) → { audioUrl, title, artworkUrl?, durationSec? } | null` via SDK `getEpisode` (**O(1)**, no page scan). When `expectedPodcastId` is passed, cross-check `episode.podcastId` and return `null` on mismatch. `audioUrl = enclosureUrl`.

**`packages/backend/src/routes/profileMedia.ts`** — add (router already `requireAuth`, mounted at `/api/profile/media`, `server.ts:806`):

- `GET /podcasts/:id/episodes?offset=` → `sendPaginated(res, items, { hasMore, offset, limit })` using `listPodcastEpisodes`. Same auth/proxy rationale as the existing `/search` (avoids browser CORS, keeps Syra base URL server-owned).

**`packages/backend/src/routes/rooms.routes.ts`** — extract + add:

- **Refactor:** pull the ingress-start body of `POST /:id/stream` (`:1174`–`:1207`: `ensureLiveKitRoomForRoom` → `createIngressReplacingExisting`/`createRoomUrlIngress` → `cleanupPreviousIngressAfterReplacement` → persist fields → `emitStreamStarted` → response) into a shared internal `startUrlIngress(room, id, { url, title, image, description }, res, userId)`. `POST /:id/stream` calls it after its existing url/manager/live validation. No behavior change to the existing route.
- **New route** `POST /:id/stream/podcast`, body `{ syraPodcastId, episodeId }`:
  1. auth → `sendForbiddenUnlessRoomManager` → `room.status === LIVE` (identical gates to `POST /:id/stream`).
  2. `resolvePodcastEpisode(episodeId, syraPodcastId)`; `404`/`400` if unresolvable or podcast-id mismatch.
  3. call `startUrlIngress(room, id, { url: audioUrl, title, image: artworkUrl, description: undefined }, res, userId)`.
  Response shape identical to `POST /:id/stream` (`{ message, ingressId, url }`).

Note: `streamImage` for URL streams is a `cloud.oxy.so` URL; here it's the Syra absolute artwork URL. The stream card renders `room.streamImage` as a remote image — an external Syra URL renders directly. Confirm the card path during implementation; if it must be a proxied/cdn URL, resolve accordingly (no new per-app helper).

### Layer 3 — agora-shared (`packages/agora-shared/src`)

**`services/spacesService.ts`** — add methods on the `createAgoraService` client (same `httpClient`/base as `/rooms`; `/profile/media` is reachable on the same Mention API base):

- `searchPodcasts(query, offset?) → { items: PodcastResult[]; hasMore; offset }` via `GET /profile/media/search?type=podcast&q=&offset=`. `PodcastResult = { syraPodcastId, title, author?, artworkUrl? }`.
- `getPodcastEpisodes(syraPodcastId, offset?) → { items: EpisodeListItem[]; hasMore; offset }` via `GET /profile/media/podcasts/:id/episodes?offset=`.
- `startPodcastStream(roomId, { syraPodcastId, episodeId }) → { ingressId; url } | null` via `POST /rooms/:id/stream/podcast`, parsed with the existing `ZStartStreamResponse` (reuse; response shape is identical).

**New component `components/PodcastStreamPicker.tsx`** — self-contained (uses `useAgoraConfig()` for `httpClient`/`agoraService`, `useTheme`, `toast`, `AvatarComponent`; NO `@/utils/api` import so it works in both apps). Two-level view driven by local state:

- **Show search:** debounced (350ms) query input → `agoraService.searchPodcasts` → list of show rows (artwork + title + author). Infinite scroll via `offset`/`hasMore`.
- **Episode list:** tapping a show → `agoraService.getPodcastEpisodes` → episode rows (title + duration + date). Back affordance to the show list. Infinite scroll.
- **Select:** tapping an episode calls `props.onSelectEpisode(syraPodcastId, episodeId)`. The picker owns no stream/room logic.

**`components/StreamConfigPanel.tsx`** — integrate the tab:

- `type StreamMode = 'url' | 'rtmp' | 'podcast'`. Add a third **Podcast** tab (mic/podcast icon) to `modeSelector`.
- When `mode === 'podcast'`: render `<PodcastStreamPicker onSelectEpisode={handleStartPodcast} />` in place of the URL/RTMP body, and **hide** the manual "Stream Info (optional)" section and the footer Start button (metadata is resolved server-side; the episode tap is the action).
- `handleStartPodcast(syraPodcastId, episodeId)`: `if (!(await ensureRoomLive())) return;` → `agoraService.startPodcastStream(roomId, { syraPodcastId, episodeId })` → on success `toast.success('Stream started')`, `onStreamStarted()`, `onClose()`; on failure `toast.error(...)`. Mirrors `handleStartUrlStream`.

## Data flow

1. Host taps **Stream** (bottom bar, host-only) → `StreamConfigPanel` → **Podcast** tab.
2. Query → `agoraService.searchPodcasts` → `GET /profile/media/search?type=podcast` → Syra `searchPodcasts`.
3. Tap show → `agoraService.getPodcastEpisodes` → `GET /profile/media/podcasts/:id/episodes` → SDK `getPodcastEpisodes` → Syra `/api/podcasts/:id/episodes`.
4. Tap episode → `ensureRoomLive()` → `agoraService.startPodcastStream` → `POST /rooms/:id/stream/podcast`.
5. Backend `resolvePodcastEpisode` → `enclosureUrl` + metadata → `startUrlIngress` (LiveKit URL ingress) → persist `activeStreamUrl/streamTitle/streamImage` → `emitStreamStarted`.
6. `activeStream` socket event (`useRoomConnection.ts:86`) → the existing stream card (`LiveRoomSheet.tsx`) renders the episode as "now playing". Stop uses the existing `DELETE /:id/stream`.

## Error handling

- Search/episode fetch fail-soft → empty list + toast (mirrors existing agoraService `console.warn` + empty returns).
- `startPodcastStream`: `403` non-manager, `400` room-not-live, `404`/`400` episode unresolvable, LiveKit errors via existing `sendLiveKitIngressError`. Client shows `toast.error` on any non-success.
- SDK `getPodcastEpisodes`: invalid rows dropped, not thrown.

## Testing

- **SDK:** `client.test.ts` — `getPodcastEpisodes` (URL, schema validation, enclosure-less rows dropped, `hasMore` from `total`) + `getEpisode` (`data.episode` unwrap, validation).
- **Backend:** unit-test `resolvePodcastEpisode`/`listPodcastEpisodes` (mock `syraClient`); route test for `POST /:id/stream/podcast` (manager gate, live gate, resolution → ingress call) and `GET /podcasts/:id/episodes`. Run from `packages/backend` (`cd packages/backend && bun run test`) — note Mention CI does not run vitest, so run the suite locally before merge.
- **Manual (required):** agora web, real foregrounded tab — search a podcast, pick an episode, confirm audio ingests into the room and the stream card shows the episode. Jest does not exercise LiveKit/render.

## Sequencing (per publish + fix-upstream rules)

1. Syra SDK: extend → build + test → commit/push Syra → `bun publish` (publish skill) → verify propagation.
2. Mention backend: bump `@syra.fm/sdk` + `bun install` (lockfile same commit) → add resolvers, `/podcasts/:id/episodes`, `startUrlIngress` refactor, `POST /:id/stream/podcast`.
3. agora-shared: service methods, `PodcastStreamPicker`, `StreamConfigPanel` tab.
4. `test-build` → push (batch backend + frontend; single push).

## Out of scope (YAGNI)

- No podcast subscribe/follow, no "play show" concept, no episode queue/playlist, no seek/scrubbing (ingress plays the file through).
- No new audio player — reuses LiveKit ingress + the existing stream card.
- No HLS handling (empty in samples); revisit only if a show provides `hls`.
- Bluesky/atproto untouched.
