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

- **React Query keys and effect deps MUST include `isAuthenticated` / `user?.id`** — SSO restore takes 5–25 s, and keying on `oxyServices` or `[]` fetches once while anonymous and never recovers. Gate private endpoints on `useAuth().canUsePrivateApi`, not just `isAuthenticated` (`usePrivacyControls`'s infinite-401 pattern). Jest does not reproduce this; verify in a real foregrounded tab.
- **A virtualized web list must be opted out of the React Compiler EXPLICITLY** (`'use no memo'`) — a stable virtualizer instance's re-renders are internal to the hook, so the compiler freezes `getTotalSize()`/`getVirtualItems()` forever in prod builds only. Do not reason about which shape is safe: compile the file with the app's own `babel-plugin-react-compiler` and read the CompileError/CompileSuccess events. Verify on a PROD build. Detail and the measured `try`/`finally`-bails table: `docs/frontend-compiler-notes.md`.
- **`VirtualizedWebFeed`** (`Feed.web.tsx`) is the single scroll-owning path for top-level feed screens, warm-starting a remount from `stores/feedScrollStore.ts`; `EmbeddedWebFeed` is for genuinely nested sub-lists only. The `Math.max(totalSize, lastItemEnd)` spacer-size guard stays even though its original cause (a compiler freeze) is gone — cheap insurance. Panel insets come from `components/shell/PanelChrome.tsx`, never per-page padding.
- **Two loggers, identical signatures, opposite meanings for argument two.** `@oxyhq/core/logger` (frontend) is `error(message, error?, context?)`; the backend pino wrapper merges a non-Error second argument as context. Gate: `bun run validate:logger`.
- **ONE Bloom root** — `app/_layout.tsx` mounts `<BloomProvider>` and nothing else mounts a Bloom state provider. `BloomThemeProvider` (via `persistKey`+`storage`) is the single theme authority; no local theme store, no app-local color-scope helpers, no local `SettingsItem` wrappers. Default color preset: `blue`.
- **Do NOT re-enable GET caching on any linked client** (`utils/api.ts`, the Syra client at `lib/syraApi.ts`). Syra live-rooms talk to Syra's own backend, never `api.mention.earth`.
- **Mention keeps its own CORS middleware on purpose** (`app.ts` + `utils/allowedOrigins.ts`) — do NOT switch it to `createOxyCors`, which cannot express the dev LAN pattern and would broaden production CORS to the whole `*.oxy.so` family.

