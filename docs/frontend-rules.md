# Frontend rules

Conventions for the Expo/React Native app beyond the general Oxy/Bloom
frontend gotchas in `~/Oxy/AGENTS.md`. React Compiler and web
virtualization findings specifically: `docs/frontend-compiler-notes.md`.

## Two post-list caches

React Query (the saved screen) and the feed store (every `<Feed>` surface,
warm-starting a remount from `stores/feedScrollStore` instead of refetching
page 1) cannot see each other. `stores/engagementInvalidation.ts` is the
single authority; **do not invalidate from the hooks** — `usePostVote` and
`app/(app)/videos.tsx` write through the store directly, bypassing
`usePostSave`/`usePostLike`/`usePostBoost`. There is no query key for
likes/boosts lists, so `invalidateQueries` there is a no-op. Client-wide
`refetchOnMount` must stay at the library default.

## Rules

- **Import runtime values from `@mention/shared-types` public subpaths; reserve its root for types.** The CommonJS root also exports MTN protocol schemas, pulling a second, CommonJS Zod runtime beside the ESM runtime already used by the frontend. Use `/job`, `/lane`, `/realtime`, `/communityNotes`, `/post`, `/feed`, or `/mtn/config` as appropriate. Gate: `sharedTypesEntryIsolation.test.ts`; verify the production bundle after changing entry boundaries.
- **React Query keys and effect deps MUST include `isAuthenticated` / `user?.id`** — SSO restore takes 5–25 s, and keying on `oxyServices` or `[]` fetches once while anonymous and never recovers. Gate private endpoints on `useAuth().canUsePrivateApi`, not just `isAuthenticated` (`usePrivacyControls`'s infinite-401 pattern). Jest does not reproduce this; verify in a real foregrounded tab.
- **A virtualized web list must be opted out of the React Compiler EXPLICITLY** (`'use no memo'`) — a stable virtualizer instance's re-renders are internal to the hook, so the compiler freezes `getTotalSize()`/`getVirtualItems()` forever in prod builds only. Do not reason about which shape is safe: compile the file with the app's own `babel-plugin-react-compiler` and read the CompileError/CompileSuccess events. Verify on a PROD build. Detail and the measured `try`/`finally`-bails table: `docs/frontend-compiler-notes.md`.
- **`VirtualizedWebFeed`** (`Feed.web.tsx`) is the single scroll-owning path for top-level feed screens, warm-starting a remount from `stores/feedScrollStore.ts`; `EmbeddedWebFeed` is for genuinely nested sub-lists only. The `Math.max(totalSize, lastItemEnd)` spacer-size guard stays even though its original cause (a compiler freeze) is gone — cheap insurance. Bloom `AppShell` owns the reading panel, its gutter/masks, document scroll and mobile reveal. `PageHeader` owns route headers; the remaining `PanelStickyFooter` only anchors post-detail replies above shared bottom occupancy. Individual screens own semantic body spacing, never a second page frame.
- **ONE retry policy for feed reads, in `utils/feedRetry.ts`.** `services/feedService`
  passes `retry: false` to the SDK linked client and wraps each feed read in
  `withFeedRetry`: 3 requests per failed load, ~500ms/1s with jitter. Do not add
  a second layer — an app-level wrapper on top of the transport's own retry
  (four attempts, 1s/2s/4s) cost up to 16 requests per failed feed load, from
  every mounted feed at once, against a backend that was failing *because* it
  had been rate limited. Retryability is decided by the HTTP status the error
  carries (`classifyFeedFailure`), never by its message text, and an expected
  transient failure logs through `logFeedFailure` as a `warn`: `logger.error`
  writes `console.error`, which is a LogBox pop-up on native and red console
  noise on web for something the app already recovered from.
- **The client never translates a post on its own.** Hydration (`PostHydrationService`) already resolved `content.text` to the best rendition the server has for this reader — exact BCP-47 locale first, then a same-base fallback, including machine translations an earlier reader's explicit request cached — and the row renders it. `usePostLanguage` reaches `POST /posts/:id/translate` only from an explicit reader action (the Translate icon or the language picker); mounting, render-ahead, recycling and viewability make zero requests. There is no auto-translate preference; do not add one, or a visibility-driven replacement. Author variants the DTO already carries switch locally, and the reader override stays stamped with its `postId` so a recycled row never shows the previous post's translation. Gate: `hooks/__tests__/usePostLanguage.test.tsx`.
- **Two loggers, identical signatures, opposite meanings for argument two.** `@oxy.so/core/logger` (frontend) is `error(message, error?, context?)`; the backend pino wrapper merges a non-Error second argument as context. Gate: `bun run validate:logger`.
- **ONE Bloom shell** — `app/(app)/_layout.tsx` uses `AppShell` (`feed`, document on web, fixed on native). Native routes own their virtualized lists; never wrap their navigator in a `ScrollView`. Sidebar descriptors in `components/navigation/useMentionSidebar.tsx` bind routes and account actions to Bloom; no app-local drawer or sidebar item implementation. The real Bloom `BottomBar` and its `Fab` action keep the actual pager progress/long-press behavior; AppShell measures and publishes its edge occupancy. Fullscreen video/camera opt out of duplicate bar padding, and keyboard visibility removes the bar slot itself.
- **ONE Bloom root** — `app/_layout.tsx` mounts `<BloomProvider>` and nothing else mounts a Bloom state provider. `BloomThemeProvider` (via `persistKey`+`storage`) is the single theme authority; no local theme store, no app-local color-scope helpers, no local `SettingsItem` wrappers. Default color preset: `blue`.
- **Do NOT re-enable GET caching on any linked client** (`utils/api.ts`, the Syra client at `lib/syraApi.ts`). Syra live-rooms talk to Syra's own backend, never `api.mention.earth`.
- **Mention keeps its own CORS middleware on purpose** (`app.ts` + `utils/allowedOrigins.ts`) — do NOT switch it to `createOxyCors`, which cannot express the dev LAN pattern and would broaden production CORS to the whole `*.oxy.so` family.

## typedRoutes gate

`typedRoutes` is ON and INERT — the general finding (why, and the fix) lives
in `~/Oxy/docs/frontend-conventions.md`, not here. Mention's own gate is
`app/(app)/settings/__tests__/settingsRouteTargets.test.ts`: it walks the
real `app/` tree and asserts every route a settings screen navigates to
exists. Scoped to settings on purpose (all-static routes there) — widen it
before trusting it to catch a bad route anywhere else in the app.

- **Settings are one modal** — `MentionSettingsProvider` uses Bloom `SettingsModal` with real `SettingsGeneralPage` / `SettingsProfilePage`, `SettingsCard`, `SettingsRow` and controls. `/settings/*` files are deep-link bridges only; page content lives in `components/settings/pages`. Account operations keep SDK auth and mutation hooks.
