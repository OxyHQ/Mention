# Spec: "Read more" tap behavior + profile bio collapse settings

**Date:** 2026-07-02
**Status:** approved design, implementing

## Context

Post text in feeds truncates per the existing `postTextExpand` preference
(`PostContentText.tsx`, see `2026-06-28-post-text-length-setting-design.md`) and shows
a "Read more" link. Today that link always navigates to the full post
(`router.push('/p/${postId}')`) — there's no way to read the rest without leaving the
feed.

Profile bios (`ProfileContent.tsx`) have no truncation at all today — always rendered
in full via `LinkifiedText`, however long.

Both are Mention-only, viewer-side display preferences — they live in Mention's
`UserSettings.appearance`, control how the *viewer* sees other people's content, and
follow the exact same settings plumbing as `postTextExpand`.

## Goal

1. **`postReadMoreAction`**: `'openPost' | 'expandInline'`, default `'openPost'`
   (current behavior, unchanged for existing users). When `'expandInline'`, tapping
   "Read more" expands the full text in place instead of navigating, and the link
   becomes "Show less" to re-collapse. The "Read more" label itself never changes —
   only what tapping it does.
2. **`collapseLongBio`**: `boolean`, default `true`. When true and a profile bio
   exceeds 200 chars, it truncates with a "Read more" / "Show less" toggle that
   expands/collapses in place (there is no "full bio page" to navigate to — bio only
   ever expands inline, regardless of `postReadMoreAction`). When false, bios always
   render in full, never truncated.

## Architecture

### Backend (`packages/backend`)

- `models/UserSettings.ts`: add `postReadMoreAction?: 'openPost' | 'expandInline'`
  (enum, default `'openPost'`) and `collapseLongBio?: boolean` (default `true`) to the
  `AppearanceSettings` interface + `AppearanceSchema`, next to `postTextExpand`.
- `routes/profileSettings.ts` (`PUT /profile/settings`): in the existing `appearance`
  validation block, accept `postReadMoreAction` only when one of the 2 enum values
  (mirror the `postTextExpand` validation), and `collapseLongBio` when `typeof ===
  'boolean'`. `GET /profile/settings/me` already returns the whole `appearance` object
  — no change needed there.

### Frontend (`packages/frontend`)

- **Store types** (`store/appearanceStore.ts`): extend `AppearanceSettings` with the
  two optional fields above, mirroring `PostTextExpand`'s type export pattern.
- **Settings UI** (`app/(app)/settings/appearance.tsx`): two new `SegmentedControl`
  (`type="radio"`) rows, same visual pattern as the existing "Post text length"
  control:
  - "On Read more tap" → Open post / Expand here (`postReadMoreAction`).
  - "Profile bios" → Collapse if long / Always show full (`collapseLongBio`).

  Both wire into the existing `saveSettings` callback the same way `postTextExpand`
  does today (extend its `updates` param + the `appearance: {...}` object it PUTs).
- **Shared logic** — new hook `hooks/useExpandableText.ts`:
  ```ts
  function useExpandableText(text: string, maxChars: number): {
    displayText: string;   // truncated + ellipsis, or full text
    isTruncated: boolean;  // whether text exceeds maxChars at all
    isExpanded: boolean;
    toggle: () => void;
  }
  ```
  Pure text-truncation + expand/collapse state, no UI. Both call sites below build
  their own "Read more"/"Show less" affordance around it — the hook does not render
  anything or know about navigation, so it stays reusable without forcing posts and
  bios to look identical.
- **`components/Post/PostContentText.tsx`**: read `postReadMoreAction` from the store
  (default `'openPost'`). Replace the current ad-hoc truncation with
  `useExpandableText(textContent, effectivePreviewChars)`. Build the suffix:
  - `'openPost'` (default): unchanged — `Text` with `onPress={() => router.push(...)}`,
    label "Read more". Exactly today's behavior; `isExpanded` from the hook is never
    used in this mode.
  - `'expandInline'`: `Text` with `onPress={toggle}`, label "Read more" when
    collapsed / "Show less" when expanded.
  - The `isDetailPage` always-full-text behavior is unchanged in both modes.
- **`components/Profile/ProfileContent.tsx`**: bio rendering (currently a bare
  `LinkifiedText`) becomes: if `collapseLongBio` is `false`, render exactly as today
  (full text, no truncation, no change to existing users' behavior beyond the
  toggle's own default). If `true` (default), use `useExpandableText(bio, 200)` and
  append a "Read more"/"Show less" `Text` suffix (same `onPress={toggle}` pattern as
  the post's `expandInline` mode) when `isTruncated`.
- i18n keys: `settings.appearance.readMoreAction` (+ 2 option labels),
  `settings.appearance.collapseBio` (+ 2 option labels), and a single shared
  `common.showLess` key reused by both the post and bio "Show less" affordance
  (the "Read more" label in both places already reuses each screen's existing key —
  no new "Read more" key needed).

## Data flow

`UserSettings.appearance.{postReadMoreAction,collapseLongBio}` → `GET
/profile/settings/me` → `useAppearanceStore.mySettings` (loaded via the existing
`useServerAppearanceSync`) → `PostContentText` / `ProfileContent` read them via
`useExpandableText`. Updating in Settings PUTs + updates the store → all feed post
text and profile bios re-render under the new behavior immediately (no remount
needed, same reactivity as `postTextExpand` today).

## Edge cases

- Setting absent / old clients → defaults (`'openPost'`, `true`) — identical to
  current behavior for posts (nothing changes for someone who never opens Settings),
  and bios newly gain a 200-char collapse where before they had none (an intentional,
  visible change — flagged here, not hidden).
- `collapseLongBio: true` with a bio ≤ 200 chars → `isTruncated` is false, no
  "Read more" shown, renders exactly like today.
- Switching `postReadMoreAction` while a post is already expanded (`expandInline` →
  `openPost`) — the per-post `isExpanded` state is local component state, so it simply
  resets on next mount; no persistence needed or expected.
- Signed-out / no settings loaded → defaults (`'openPost'`, `true`).
- Detail page (`/p/[id]`) posts are never truncated regardless of
  `postReadMoreAction` — unchanged from today.

## Verification

- Backend: tsc + the settings route accepts/persists the two new fields, rejects
  invalid values (non-enum string for `postReadMoreAction`, non-boolean for
  `collapseLongBio`); existing `appearance` updates (`postTextExpand`, `themeMode`)
  still work.
- Frontend: tsc (3 livekit allow-listed) + `build:frontend`; real check — toggle each
  setting in Settings → Appearance and confirm: (a) a long feed post's "Read more"
  either navigates or expands in place per the setting, with "Show less" working when
  expanded; (b) a long profile bio collapses/shows-full per the setting, with
  Read-more/Show-less toggling correctly.
- Push via test-build → git-ops (backend deploys to ECS, frontend to CF Pages).

## Out of scope

- No per-post or per-profile override UI — global viewer preference only, same scope
  as `postTextExpand`.
- No line-based (`numberOfLines`) truncation variant for either posts or bios —
  char-count only, consistent with the existing mechanism.
- Bio never navigates anywhere (no "full bio page" exists) — `postReadMoreAction`
  only governs post behavior, bios always expand inline.
