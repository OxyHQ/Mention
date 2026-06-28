# Spec: "Followed by" mutual followers (social proof) on profile

**Date:** 2026-06-28
**Status:** approved design, implementing

## Context

On a Mention profile, show a Twitter/Instagram-style social-proof row — **"Followed by
Ana, Luis and N others"** with overlapping avatars — for the **mutual followers** (people
the viewer follows who also follow this profile, a.k.a. "followers you know"). It sits
**after the stats and before the `LinkSummary`** row. Tapping it opens the existing
**connections screen on a new "In common" tab**.

This is the mutuals/"followed by" pattern (NOT "people you may know" — that is discovery and
belongs elsewhere; the connections screen already has a `who-may-know` tab for that).

The mutual-overlap aggregation already EXISTS in Oxy API but only inside the recommendations
pipeline (`packages/api/src/routes/profiles.ts:~870`); it is not exposed per-profile. So this
needs a thin new endpoint that reuses that logic, surfaced through the SDK.

**Hard rule:** Mention talks to Oxy ONLY through `@oxyhq/core` (`oxyServices.*`) — NO direct
`api.oxy.so` fetches. The new data flows API → `@oxyhq/core` method → Mention.

## Non-goals

- No "people you may know" here (separate feature; already a tab).
- No client-side mutual computation (must be server-side, via the SDK).
- Own profile, signed-out, or zero-mutuals → render nothing.

## Architecture (upstream → down)

### 1. `@oxyhq/api` (Oxy API) — new endpoint
`GET /users/:userId/mutuals?limit=&offset=` (authed/optional-auth).
- **Viewer derived from the auth token server-side** (`getRequiredOxyUserId`/optional auth) — NOT a client-supplied `viewerId` (avoids IDOR/spoofing). No session → empty result.
- Reuse the mutual aggregation from `profiles.ts:~870` (intersection of *viewer's following* ∩ *:userId's followers*, `Follow` collection, `followType: USER`), bounded window.
- Returns `{ data: PublicUserProfile[], total }` paginated — each item with `id`, `username`, `name.displayName`, `avatar` (file id), `color` (the same `select` the followers endpoint uses). Ordered by relevance/mutualCount then recency.
- Edge: `:userId === viewer` or anon → `{ data: [], total: 0 }`.

### 2. `@oxyhq/core` (SDK) — new method
`getUserMutuals(targetUserId: string, pagination?: { limit?; offset? }): Promise<{ mutuals: User[]; total: number; hasMore: boolean }>` — a `user` mixin method mirroring `getUserFollowers` (same caching posture). Calls the endpoint through the SDK client (auth handled by the SDK). Bump + publish core.

### 3. Mention — consume
- **Hook** `useMutualFollowers(profileId)` (React Query): keyed on `profileId` + viewer identity (`user?.id`); gated on signed-in + `canUsePrivateApi` + `profileId !== user.id`. Fetches a small sample (`limit: 3`) + `total`. Disabled (returns empty) when gating fails.
- **Component** `components/Profile/FollowedByRow.tsx`:
  - `null` when not signed in, own profile, or `total === 0`.
  - Bloom `AvatarGroup` (`max={3}`, `size` ~20-22, `variant="thumb"`, items = `{id, uri: avatarFileId, displayName, username}`) + a `Text` "Followed by {name1}, {name2} and {N} others" (i18n with singular/plural; show up to 2 names then "and N others"; just names if ≤2). Whole row pressable.
  - Tap → navigate to the connections screen on the new `in-common` tab (route per how connections tabs are addressed — pathname-driven, see below).
  - Placement: `ProfileContent.tsx`, AFTER `ProfileStats`, BEFORE `LinkSummary`.
- **Connections screen** `app/(app)/[username]/connections.tsx`:
  - Extend `TabType` `'followers' | 'following' | 'who-may-know'` → add `'in-common'`.
  - Add it to `AnimatedTabBar` + the pathname↔tab mapping (`getActiveTab`) so it's a routable tab like the others.
  - `loadMutuals` via `oxyServices.getUserMutuals(profileData.id)`; full paginated list reusing the existing `ConnectionUser` row + `StableFollowButton`.
  - The `in-common` tab is viewer-relative: only meaningful when signed in and not own profile; show an empty state otherwise (mirror how `who-may-know` handles auth-empty).
- **i18n** keys: `profile.followedBy.*` (one/two/many with names + count) and the `in-common` tab label.

## Data flow
`Follow` graph → Oxy API `/users/:id/mutuals` (viewer from auth) → `@oxyhq/core getUserMutuals` → Mention `useMutualFollowers` → `FollowedByRow` (sample) AND connections `in-common` tab (full list). One SDK method feeds both.

## Edge cases
- Signed-out viewer → no row, `in-common` tab shows sign-in/empty state.
- Own profile → no row (no "you follow" relative to yourself); hide or empty the tab.
- 0 mutuals → no row; tab shows empty state.
- 1-2 mutuals → "Followed by Ana" / "Followed by Ana and Luis" (no "others"); ≥3 → "Followed by Ana, Luis and N others".
- Mutual without avatar → AvatarGroup neutral placeholder.

## Publish / deploy order (upstream-first)
1. **Oxy API**: add endpoint + test → land on OxyHQServices main → **deploy oxy-api to ECS** (the endpoint must be live on `api.oxy.so` before the SDK/Mention can call it, incl. local dev which points at prod Oxy).
2. **`@oxyhq/core`**: add `getUserMutuals` → build/tsc/test → bump (minor) → **publish via `bun publish`** (so workspace deps resolve) → verify tarball.
3. **Mention**: bump `@oxyhq/core` (caret) → reinstall → add hook + `FollowedByRow` + connections `in-common` tab + i18n → verify (tsc + build:frontend + frozen-lockfile) → push main.

## Verification
- **Oxy API**: unit/integration test of the aggregation (viewer with mutuals → list+total; anon → empty; own profile → empty); deploy + curl the live endpoint with a service/user token.
- **core**: build/tsc/test; clean external `bun add` + `import` of `getUserMutuals`.
- **Mention**: frontend tsc (3 livekit allow-listed) + `bun run build:frontend`; real browser/device — on another user's profile while signed in: the "Followed by" row appears after stats (when mutuals exist), tapping opens connections on the **In common** tab with the full list; own profile + signed-out show nothing.

## Out of scope / follow-up
- "People you may know" stays its own `who-may-know` tab (unchanged).
- "Connections in common" (you both follow the same people) — different intersection; not now.
