# Frontend rules

Conventions for the Expo/React Native app beyond the general Oxy/Bloom
frontend gotchas in `~/Oxy/AGENTS.md`. React Compiler and web
virtualization findings specifically: `docs/frontend-compiler-notes.md`.

## Modular panels and Deck

See [Deck workspace](./deck-workspace.md) for account-scoped persistence,
settings, offline/conflict behavior and backend rollout requirements.

The app shell declares its main and context panels through Bloom's
`AppShell.panelLayout`. Insights sets `expandedPanel: 'main'`, preserving the
same outer width; Bloom owns visibility, transitions, scrolling and bottom-bar
clearance. Do not add another app-specific sidebar breakpoint or width animation.

Deck uses the same API in `mode: 'deck'`. Its default composition has the current
application page as a fixed first column and three configurable columns. Saved
custom columns can change that count. The compact sidebar mode control preserves
the current route and mounted page; `/deck` activates that mode and resolves to Home.
Its horizontal scroll belongs to the document; each column owns its vertical
scroll. Bloom preserves the top and bottom gutters around bounded columns.
The web host keeps `html`, `body` and `#root` at `height: 100%` with visible
overflow: bounded panels inherit the usable height, excluding classic horizontal
scrollbars, while document pages can overflow naturally. Do not use `100vh` as
the host minimum height; it adds the scrollbar height back into Deck.
Bloom also owns the final inline gutter and the sticky sidebar overlap surface.
Its shared CSS responds to document scroll; Mention adds no scroll listener or
route-specific sidebar paint.
It is available only on web at Bloom's `lg` breakpoint and above; both the sidebar
mode control and direct route use `useDeckAvailable`. The first column keeps
Expo's application history. Each additional column has a Bloom memory history
for all internal routes, with back/forward and restored scroll positions.
`lib/navigation/router` binds app links, parameters and navigation hooks to
Bloom’s panel router when embedded on web, and to Expo otherwise. Native
imports use Expo directly. Screens and nested layouts come from the same app route tree; profiles keep their chrome mounted
when changing tabs. Use `useRouter()`, never the global `router` singleton in
reusable screens. Modified clicks retain canonical URLs for new tabs.
Virtualized lists use the Bloom scroll owner; only that owner restores a panel’s
history offset. Column reselect, scroll and profile colors are scoped too.
Each route declares its chrome through `Screen scroll="auto"`, `header` and
`bottomBar`. The same screen uses document scroll normally and the column owner
inside Deck. Header actions from the workspace compose into that header: one
Back button only when history exists and a panel-settings modal for configurable
columns, never a second toolbar. A screen rendered in a panel delegates Back to
Bloom; an unconditional `onBack` would incorrectly show it at the history root.
The modal persists feed, resizing, appearance and base recipe per panel;
controlled `panelLayout.widths` persists changes made with the resize handle.
Deck roots render the actual Explore, preset-feed viewer and Saved routes through
`PanelRouteSlot`; do not introduce alternate feed or authentication screens in Deck.
`panelLayout.trailingAction` supplies the end-of-document create-panel action;
adding a column issues a transient `revealPanel` request to bring it into view.
Bloom waits for the compositor's layout transitions before revealing the final
column box and cancels superseded requests. The app must not schedule a second
scroll or assume that a newly mounted panel has already reached its final width.
`activePanel` is passive selection; hydration never requests horizontal scrolling.
Panel definitions and preferences persist in `deckSettings`; reveal requests do
not. App code does not measure panel geometry.
Live feed refresh is opt-in per panel. `FeedUpdatePolicyProvider` reuses the
existing authenticated socket's invalidation events and the screen's authorized
HTTP refresh. Bursts coalesce; reading/hidden-document pauses retain a pending
refresh. Saved keeps its existing bookmark query synchronization. No panel creates
its own transport or renders a post body from a broadcast. Feed uses the
existing owner and keeps its ordinary virtualization and pagination.

Profiles declare `Screen.colorPreset`; Bloom scopes the surface, outer border,
header and scrollbar to that panel and restores its recipe on exit. Do not
reintroduce a global screen-color context or route-name checks. HeaderDock reads
Bloom's owner metrics on web; a listener attached to a previous route's DOM node
cannot drive the current header. Native lists supply their existing shared offset.

Videos uses Bloom `ScreenPager` for viewport-sized pages and CSS scroll snapping.
The Screen owns available height and navigation clearance. Do not set document
snap styles or window-sized item heights in the app. Scrollbars belong to Bloom's
scroll owners, including the horizontal document scrollbar in Deck.

Feed and reel videos render the same `PlaybackVideoView` in Bloom's persistent
media node. Its stable internal ref owns HLS, so changing the presenter preserves
the element, decoder and buffer. Source replacement belongs to that view and is
serialized; presenters supply the desired source and never replace it themselves.
`VideoPlaybackContext` decides eligibility; `video-playback-control` combines those
answers once per shared player, retains the first-frame state, and gates loading.
A hidden feed cannot pause the player adopted by the reel. Neighbor preloading is
bounded by the reel window and stops when the screen or document is inactive,
except for the actual PiP owner. Media selection includes both post and media index.

The persistent video view holds its own registry lease, so cancelling a web handoff
releases the navigation bridge without freeing a mounted decoder. No-anchor and
no-flight paths do not retain a bridge. Explicit flight cancellation is limited to
web. Native Bloom owns a separate flying view and keeps the existing bridge
lifetime, including its singleton replacement behavior; its public API does not
expose completion of asynchronous unbinding. Native cancellation needs separate
framework ownership work and device validation.

## Loading screens

Render the screen header and scroll owner immediately. First reads use the matching
content skeleton (posts, profile, notifications, lists, forms, media or insights),
composed from Bloom primitives in `components/loading/ContentSkeleton.tsx` and the
existing domain skeletons. `Skeleton.Region` owns one accessible busy announcement
and one shared, reduced-motion-aware shimmer; do not add app animation timers.
Keep cached content on screen while refreshing and append skeleton rows only when
paging. Authentication gates still wait for a resolved, usable session before
revealing private content. Spinners belong to actions and media buffering, not
initial screen reads. The pre-theme font splash retains only the brand mark.

Deck's Metro route context uses `lazy` mode so the startup bundle does not import
every screen. Stable lazy route components share resolved modules across panels
and revisits; real chunk loads use the panel's Suspense skeleton. Failed imports
reach Bloom's PanelErrorBoundary, whose retry resets only failed module records.
Do not simulate asynchronous loading with `Promise.resolve` over eager imports. The slow-read
Deck regression holds a topic response, checks the skeleton and working Back
button, then checks that revisiting renders cached posts without another read.

Hydrated quotes render synchronously with their parent post. `PostItem` supplies a
stable nested renderer to the attachment row; do not reimport it through
`React.lazy` with an empty fallback. That boundary adds the quote's height after
the virtualizer has measured the parent and shifts the reading position. Keep the
depth limit and memo comparison. The cache retains two related-post hops, so a
boost of a quote keeps both the quote author's comment and its original. Changes
to embedded relations invalidate the row memo independently of the parent's edit
timestamp. A `quotedPostUnavailable` marker renders a generic translated message
without guessing the missing post's identity or access policy. Feed action glyphs
use fixed-size SVGs, so a late icon-font load cannot change the row height.

Feed social reasons come only from `FeedPostSlice.socialContext`, independently
of thread/boost grouping. Its target `postId` decides which row gets “Liked by” or “Reposted by”; a
prepended parent never inherits a reply's reason. Named actors and totals are the
server's eligible public evidence, not inferred from engagement counters. The
label opens that post's matching likes/reposts list and makes no per-row read.
A social repost reason does not duplicate an identical structural booster row. Native
unscoped feeds retain the evidence in viewer-scoped `feedUI`, replace it on refresh
and discard it on account changes; it never enters the global post cache. A named
actor blocked locally suppresses the stale label until the next authorized read.
Mute/unmute writes go through `muteService`, with the originating viewer passed
by the action. Successful writes notify the existing viewer-scoped ranking rule;
SDK preflight is aborted if the viewer changes. A reactive staleness snapshot
withdraws social reasons immediately while the replacement read is pending, and
a failed replacement cannot restore that old evidence.
Person follow controls use Mention's `components/FollowButton` adapter around the
public SDK control. Accepted single follows/unfollows and changed bulk results
invalidate only the originating viewer's feed evidence. Bulk callbacks with no
changed edges do not invalidate; consumer callbacks (including federation sync)
remain composed but cannot run for an outgoing viewer after an account switch.

Feed request deduplication includes viewer generation, page size and normalized
filters. Scroll identities use the same normalized filters with structured
serialization, so delimiters inside values and boolean/string values cannot
confuse separate feeds. A completed request removes only its own in-flight entry;
older requests cannot erase a newer read after a session change. Caller-owned
abort signals remain isolated rather than sharing cancellation.

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
`stores/feedQueryCache.ts`, mounted or not. A feed's first page can be started
before its `<Feed>` mounts — `prefetchFeed` (post replies from the route id, a
profile opened from a feed row) and, on web, the home feed's boot read
(`lib/bootFeedRead`), which the feed takes only when the viewer resolves as the
one it was read as (`services/feedPageRead`). Visited home tabs stay mounted
behind `<Activity>`. `stores/engagementInvalidation.ts`
is the single authority for engagement writes; **do not invalidate from the
callers** — the feed row's commands (`components/Feed/postInteractions.tsx`)
and `app/(app)/videos.tsx` both write through the store directly. Client-wide
`refetchOnMount` must stay at the library default.

Ranking preference saves notify `stores/feedRankingInvalidation` only after the
server accepts them. Mounted feeds replace page one; held query and SQLite
pages use the same viewer-scoped staleness rule. For You tuning targets For You.
Never invalidate the whole feed-query family to apply a preference. Following
order is persisted as `feedSettings.following.sort` (`chronological` by default,
or `relevance`) in the existing Feed Settings page. Algorithm presets preserve
that choice. Explicit Following `filters.sort` values participate in query and
transport deduplication; Following Direct never accepts that override.

Feed impressions report once per post/session on hide, blur/background, teardown,
or a deliberate 30-second client dwell cap. They do not report after five seconds:
the server records only one dwell sample per counted view, so an early sample
permanently truncates longer reads. Foreground visibility is shared across web,
native and reels; an actual Picture-in-Picture window remains visible. Refresh
re-registers visible rows even without a new viewport event. Profile telemetry
uses the fetched `author|id|tab` descriptor.

## Post text

`PostContentText` renders composer formatting through Bloom `InlineMarkdown`;
Bloom's React-free inline parser and truncation count visible text rather than
Markdown delimiters or link destinations. Parse the complete source before
clipping, so an ellipsis stays inside its formatting or mention and every link
keeps its complete target. `postInlineMarkdown` only adapts Mention identities:
hydrated display names stay literal and use the same `MentionTextLink` routing
as plain text. Do not introduce another Markdown parser or rewrite stored posts
for display.

## Rules

- **A feed row mounts no controllers.** Every command a row can issue — like, downvote, save, boost, share, the ⋯ menu, sources, insights, community notes — comes from the one app-lifetime controller, `usePostInteractions()` (`components/Feed/postInteractions.tsx`, services bound once by `PostInteractionsBinder` in `AppProviders`). Commands resolve the post from the store when PRESSED; the menu is built then, not per row. Adding a per-row hook for an action the reader might take is the regression #1103 removed; the row-cost harness (`bun run --cwd packages/frontend test:perf`) counts hook slots per row and gates them.
- **No whole-store subscriptions in row code.** A zustand hook called without a selector re-renders every mounted row on any write to that store. Gate: `validate:feed-hot-path`.
- **One scroll owner; an embedded Feed is bounded.** A `<Feed scrollEnabled={false}>` renders inside a parent scroller and is not virtualized — every row stays mounted — so it must pass `previewLimit` (rows capped, never pages) or carry a `bounded-feed:` comment saying why it is bounded. Screens let the Feed own the scroll and hand it their header (`listHeaderComponent`). Gate: `validate:feed-hot-path`.

- **Import runtime values from `@mention/shared-types` public subpaths; reserve its root for types.** The CommonJS root also exports MTN protocol schemas, pulling a second, CommonJS Zod runtime beside the ESM runtime already used by the frontend. Use `/job`, `/lane`, `/realtime`, `/communityNotes`, `/post`, `/feed`, or `/mtn/config` as appropriate. Gate: `sharedTypesEntryIsolation.test.ts`; verify the production bundle after changing entry boundaries.
- **React Query keys and effect deps MUST include `isAuthenticated` / `user?.id`** — SSO restore takes 5–25 s, and keying on `oxyServices` or `[]` fetches once while anonymous and never recovers. Gate private endpoints on `useAuth().canUsePrivateApi`, not just `isAuthenticated` (`usePrivacyControls`'s infinite-401 pattern). Jest does not reproduce this; verify in a real foregrounded tab.
- **A virtualized web list must be opted out of the React Compiler EXPLICITLY** (`'use no memo'`) — a stable virtualizer instance's re-renders are internal to the hook, so the compiler freezes `getTotalSize()`/`getVirtualItems()` forever in prod builds only. Do not reason about which shape is safe: compile the file with the app's own `babel-plugin-react-compiler` and read the CompileError/CompileSuccess events. Verify on a PROD build. Detail and the measured `try`/`finally`-bails table: `docs/frontend-compiler-notes.md`.
- **One feed core, two scrollers.** `Feed.native.tsx` (FlashList) and `Feed.web.tsx` (window virtualizer) differ only in how they virtualize. Data, rows, pagination, retry/refresh, the pinned-post hold, empty/footer states, the header, impression telemetry, the error boundary and memoization live once in `components/Feed/useFeedCore.tsx`. A behaviour change goes there, never into one platform file; `feedCore.test.tsx` fails if a platform file reads feed state, auth or builds rows itself.
- **`VirtualizedWebFeed`** (`Feed.web.tsx`) is the single scroll-owning path for top-level feed screens, warm-starting a remount from the feed query's cached pages (`hooks/useFeedQuery`); `EmbeddedWebFeed` is for genuinely nested sub-lists only. The `Math.max(totalSize, lastItemEnd)` spacer-size guard stays even though its original cause (a compiler freeze) is gone — cheap insurance. Bloom `AppShell` owns the reading panel, its gutter/masks, document scroll and mobile reveal. `Screen.header` owns route headers; `Screen.bottomBar` contains post-detail replies using Bloom `PageFooter`. Individual screens own semantic body spacing, never a second page frame.
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
- **The client never translates a post on its own.** Hydration (`PostHydrationService`) already resolved `content.text` to the best rendition the server has for this reader — walking an explicit `?lang`, then the reader's Oxy account languages (primary first), then `Accept-Language`, so a device locale never outranks what a signed-in reader declared. It serves the author's own rendition in the first of those languages it has, and a machine translation an earlier reader's explicit request cached only for the reader's primary language (`resolveViewerTag`); within a language, exact BCP-47 locale first, then a same-base fallback. The row renders what it served. `usePostLanguage` reaches `POST /posts/:id/translate` only from an explicit reader action (the Translate icon or the language picker); mounting, render-ahead, recycling and viewability make zero requests. There is no auto-translate preference; do not add one, or a visibility-driven replacement. The Translate icon targets the reader's PRIMARY language (the first account language), reusing a rendition the post already has only when it is in that language — never one in a secondary language they also read (`resolveTranslateTarget`). Author variants the DTO already carries switch locally, and the reader override stays stamped with its `postId` so a recycled row never shows the previous post's translation. Gate: `hooks/__tests__/usePostLanguage.test.tsx`. When the reader's languages change (their Oxy account's — the SDK re-reads the owner profile on focus, so a reorder made on another device arrives too), the posts already held are asked for again rather than re-resolved from the shipped variants: `stores/readerLanguageInvalidation` (fed by `AccountSwitchReset`) invalidates every post-bearing query family and reloads the feeds through `stores/feedStaleness` and `hooks/useReloadOnFeedRuleChange`, so the server stays the one implementation of the rule.
- **A published post is not a draft, and its composer is not somewhere you can land again.** The `/write` tab composer stays mounted for the life of the app, so whatever it holds after a publish is what the next compose opens on. `handlePost` stops autosave before the request (`beginPublish`), deletes the draft through `useDraftManager.publishSucceeded` (which settles an in-flight autosave and reads the draft id as of now, not the render's), empties the composer, and leaves through `useComposeExit().leaveAfterPublish`: a pushed `/compose` pops (or is *replaced* by Home when nothing is beneath it), and the tab leaves via `leaveTab`, which drops `write` from the tabs' back history. A failed publish keeps the content and saves it (`publishFailed`). The ✕ (`dismiss`) is the opposite on purpose: an unsent draft stays reachable. Gates: `hooks/__tests__/useDraftManagerPublish.test.tsx`, `components/Compose/__tests__/useComposeExit.test.tsx`, `components/Compose/__tests__/composePublishWiring.test.ts` (Bloom's `TabPager` tests own `leaveTab`).
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
