# Frontend rules

Conventions for the Expo/React Native app beyond the general Oxy/Bloom
frontend gotchas in `~/Oxy/AGENTS.md`. React Compiler and web
virtualization findings specifically: `docs/frontend-compiler-notes.md`.

## Two post-list caches

The saved screen is an ordinary React Query list. Every `<Feed>` surface is a
feed cache: one infinite query per feed (`hooks/useFeedQuery`, key
`viewerQueryKeys.feed`) on web and for every scoped feed on native, SQLite for
native unscoped feeds. A feed warm-starts a remount from the pages it holds
and requests nothing: its `staleTime` is `Infinity`, and staleness is decided
by RULE — `stores/feedStaleness.ts` asks the engagement, lane, safety and byline
authorities whether a write postdates the held read, and only then is page 1
read again (never every loaded page). **Never invalidate the `feeds` family**:
that refetches every loaded page of every open feed. The viewer's own new post,
reply and deletion are written into the feed queries by
`stores/feedQueryCache.ts`, mounted or not. `stores/engagementInvalidation.ts`
is the single authority for engagement writes; **do not invalidate from the
callers** — the feed row's commands (`components/Feed/postInteractions.tsx`)
and `app/(app)/videos.tsx` both write through the store directly. Client-wide
`refetchOnMount` must stay at the library default.

## Rules

- **A feed row mounts no controllers.** Every command a row can issue — like, downvote, save, boost, share, the ⋯ menu, sources, insights, community notes — comes from the one app-lifetime controller, `usePostInteractions()` (`components/Feed/postInteractions.tsx`, services bound once by `PostInteractionsBinder` in `AppProviders`). Commands resolve the post from the store when PRESSED; the menu is built then, not per row. Adding a per-row hook for an action the reader might take is the regression #1103 removed; the row-cost harness (`bun run --cwd packages/frontend test:perf`) counts hook slots per row and gates them.
- **No whole-store subscriptions in row code.** A zustand hook called without a selector re-renders every mounted row on any write to that store. Gate: `validate:feed-hot-path`.
- **One scroll owner; an embedded Feed is bounded.** A `<Feed scrollEnabled={false}>` renders inside a parent scroller and is not virtualized — every row stays mounted — so it must pass `previewLimit` (rows capped, never pages) or carry a `bounded-feed:` comment saying why it is bounded. Screens let the Feed own the scroll and hand it their header (`listHeaderComponent`). Gate: `validate:feed-hot-path`.

- **Import runtime values from `@mention/shared-types` public subpaths; reserve its root for types.** The CommonJS root also exports MTN protocol schemas, pulling a second, CommonJS Zod runtime beside the ESM runtime already used by the frontend. Use `/job`, `/lane`, `/realtime`, `/communityNotes`, `/post`, `/feed`, or `/mtn/config` as appropriate. Gate: `sharedTypesEntryIsolation.test.ts`; verify the production bundle after changing entry boundaries.
- **React Query keys and effect deps MUST include `isAuthenticated` / `user?.id`** — SSO restore takes 5–25 s, and keying on `oxyServices` or `[]` fetches once while anonymous and never recovers. Gate private endpoints on `useAuth().canUsePrivateApi`, not just `isAuthenticated` (`usePrivacyControls`'s infinite-401 pattern). Jest does not reproduce this; verify in a real foregrounded tab.
- **A virtualized web list must be opted out of the React Compiler EXPLICITLY** (`'use no memo'`) — a stable virtualizer instance's re-renders are internal to the hook, so the compiler freezes `getTotalSize()`/`getVirtualItems()` forever in prod builds only. Do not reason about which shape is safe: compile the file with the app's own `babel-plugin-react-compiler` and read the CompileError/CompileSuccess events. Verify on a PROD build. Detail and the measured `try`/`finally`-bails table: `docs/frontend-compiler-notes.md`.
- **One feed core, two scrollers.** `Feed.native.tsx` (FlashList) and `Feed.web.tsx` (window virtualizer) differ only in how they virtualize. Data, rows, pagination, retry/refresh, the pinned-post hold, empty/footer states, the header, impression telemetry, the error boundary and memoization live once in `components/Feed/useFeedCore.tsx`. A behaviour change goes there, never into one platform file; `feedCore.test.tsx` fails if a platform file reads feed state, auth or builds rows itself.
- **`VirtualizedWebFeed`** (`Feed.web.tsx`) is the single scroll-owning path for top-level feed screens, warm-starting a remount from the feed query's cached pages (`hooks/useFeedQuery`); `EmbeddedWebFeed` is for genuinely nested sub-lists only. The `Math.max(totalSize, lastItemEnd)` spacer-size guard stays even though its original cause (a compiler freeze) is gone — cheap insurance. Bloom `AppShell` owns the reading panel, its gutter/masks, document scroll and mobile reveal. `PageHeader` owns route headers; the remaining `PanelStickyFooter` only anchors post-detail replies above shared bottom occupancy. Individual screens own semantic body spacing, never a second page frame.
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
- **A published post is not a draft, and its composer is not somewhere you can land again.** The `/write` tab composer stays mounted for the life of the app, so whatever it holds after a publish is what the next compose opens on. `handlePost` stops autosave before the request (`beginPublish`), deletes the draft through `useDraftManager.publishSucceeded` (which settles an in-flight autosave and reads the draft id as of now, not the render's), empties the composer, and leaves through `useComposeExit().leaveAfterPublish`: a pushed `/compose` pops (or is *replaced* by Home when nothing is beneath it), and the tab leaves via `leaveTab`, which drops `write` from the tabs' back history. A failed publish keeps the content and saves it (`publishFailed`). The ✕ (`dismiss`) is the opposite on purpose: an unsent draft stays reachable. Gates: `hooks/__tests__/useDraftManagerPublish.test.tsx`, `components/Compose/__tests__/useComposeExit.test.tsx`, `components/Compose/__tests__/composePublishWiring.test.ts`, `components/navigation/__tests__/tabHistory.test.ts`.
- **One editing session keeps one draft, and it keeps everything.** Every draft write goes through `useDraftManager`: the debounced `autoSave`, the prompt's **Save draft** (`saveNow`) and **Discard** (`discard`). Writes are chained, so a later write always updates the draft an earlier one created rather than starting a second copy, and `useDrafts.saveDraft` reads the stored list, never a stale one in state. A draft stores every attachment a box can hold — event and room included, and each thread box's sources, article, event, room, podcast and order — and restores only what still reads as valid. Discard cancels the debounce, lets a write in flight land, then deletes it; nothing autosaves after. What counts as content is decided once, in `utils/composeContent.ts` (`hasPublishableContent` for the Post button and publish, `hasDraftContent` for autosave and the close prompt); a new attachment is added there. Gates: `hooks/__tests__/useDraftManagerSession.test.tsx`, `utils/__tests__/composeContent.test.ts` (OxyHQ/Mention#1124).
- **Two loggers, identical signatures, opposite meanings for argument two.** `@oxy.so/core/logger` (frontend) is `error(message, error?, context?)`; the backend pino wrapper merges a non-Error second argument as context. Gate: `bun run validate:logger`.
- **ONE Bloom shell** — `app/(app)/_layout.tsx` uses `AppShell` (`feed`, document on web, fixed on native). Native routes own their virtualized lists; never wrap their navigator in a `ScrollView`. Sidebar descriptors in `components/navigation/useMentionSidebar.tsx` bind routes and account actions to Bloom; no app-local drawer or sidebar item implementation. The real Bloom `BottomBar` and its `Fab` action keep the actual pager progress/long-press behavior; AppShell measures and publishes its edge occupancy. Fullscreen video/camera opt out of duplicate bar padding, and keyboard visibility removes the bar slot itself. Route-local actions use `PageAction` around a static Bloom `Fab`: the layout follows the shell’s measured bottom occupancy, sticky within the web reading column and absolute on native. Placement never belongs to the button.
- **Pressing the place you are on reselects it: first to the top, then a reload.** The active bottom-bar tab, the sidebar row for the current page, either logo and the active inner tab all call `useReselect()` (`context/ScreenReselectContext.tsx`), never `router.navigate` to the same route. Navigation controls go through `useNavigateOrReselect(href)`. A screen declares only how it reloads, with `useScreenReselect({ refresh })` (or `useReselectReloadKey()` for a `<Feed>`). Where the top is belongs to the scroll owner: the document on web, the registered list on native. A screen with its own scroller (the reel) supplies `scrollToTop` and `isAtTop`. Native scrollers register through `useFocusedScrollable` (or `FocusedScrollView`) so they own the slot only while focused: the pager keeps every tab mounted, and a list registered on mount answers for the wrong tab. `LayoutScrollContext` parks each scroller's offset when it loses the slot and restores it when it returns.
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

## Deep-link boot navigation

The [Expo Router 57.0.23 patch](../patches/expo-router@57.0.23.patch) preserves
a pending child navigator's initial state in the vendor's `useOnGetState` hook
until its state listener has registered. Without it, a delayed child can temporarily publish the root
route and rewrite a direct profile URL to `/` before restoring the profile.
The distinction is whether the listener key has ever registered: an own key
whose value is now `undefined` represents an unregistered child and must still
clear its state. Do not replace this with an unconditional stale-state fallback.

The paired `findMatchingState` guard treats states with `stale !== false` as
partial states. They must never be compared as hydrated navigation states:
preserved pending children do not yet have the complete fields that matching
requires. Both guards are needed; preserving pending state alone can replace
the URL flash with a runtime error.

When upgrading Expo Router or changing this patch, run the production-browser
regression in `packages/e2e/tests/deep-link-boot.spec.ts`, including its captured
history writes. Require no transient home URL, no browser `pageerror`, and correct
back/forward traversal. An eventual correct URL or a screenshot alone cannot
detect the intermediate `/` rewrite. Keep the existing native stack header patch intact.
