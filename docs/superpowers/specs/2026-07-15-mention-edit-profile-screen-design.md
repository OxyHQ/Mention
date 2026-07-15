# Spec: Mention-owned Edit Profile screen

**Date:** 2026-07-15
**Status:** approved design, pending implementation plan

## Context

Mention's "Editar perfil" button (on a user's own profile, `ProfileHeader.tsx`)
currently opens `ManageAccount` — the shared Oxy SDK account-management sheet used
by every Oxy app (name, bio, avatar, security). That's correct for Oxy-owned
identity fields, but Mention-specific profile customization has nowhere
dedicated to live and has drifted across three unrelated places instead:

- `app/(app)/settings/appearance.tsx` — theme mode, post-text-length prefs, **and**
  the profile banner image (`profileHeaderImage`) **and** a profile accent-color
  picker (`ColorSwatchPicker` + `useAppColorSave`).
- `app/(app)/settings/profile-customization.tsx` — profile "style" (default vs.
  minimalist + cover-photo-enabled) **and a second, duplicate** accent-color
  picker (same `ColorSwatchPicker`/`useAppColorSave` as above).
- `components/Profile/ProfileMedia.tsx` — pinned song/podcast, rendered inline on
  the live public profile; when nothing is pinned, the owner sees an inline
  "+ Add song or podcast" affordance that opens `MediaPickerSheet` directly from
  the public profile view.

All three already persist through the same store (`useAppearanceStore` /
`updateMySettings`) — this is a pure UI consolidation, not a data-model change.

The user wants a single, Mention-owned "Edit Profile" screen for everything that
is Mention-specific about a profile, clearly separated from `ManageAccount`
(Oxy account identity, shared ecosystem-wide — untouched by this spec).

## Goal

- One new screen, `app/(app)/edit-profile.tsx`, consolidating: banner, profile
  style (default/minimalist), profile accent color, and pinned song/podcast.
- "Editar perfil" on the public profile navigates to this screen instead of
  opening `ManageAccount`. `ManageAccount` is still reachable — as a row inside
  the new screen ("Cuenta Oxy" or similar) — for identity fields it owns.
- `profile-customization.tsx` is deleted (fully absorbed); its Settings menu row
  is removed.
- `appearance.tsx` is trimmed to only what is a personal display preference, not
  part of the public profile: theme mode, post-text-length behavior,
  read-more action, collapse-long-bio. Loses the banner section and the
  duplicate color picker.
- The public profile no longer shows an inline "+ Add song or podcast" prompt —
  pinned-media management moves entirely into Edit Profile. The public profile
  keeps showing the read-only song/podcast card whenever media *is* pinned
  (unchanged for both owner and visitors).

## Non-goals

- No changes to `ManageAccount`, to Oxy-owned identity fields (avatar, name,
  bio, username, security), or to any other Oxy app.
- No per-app avatar override (raised separately by the user; explicitly out of
  scope — conflicts with "Oxy owns identity" and needs its own decision, not
  bundled here).
- No backend/store/API changes — `useAppearanceStore` already persists all four
  sections; this is a frontend reorganization only.
- No sub-navigation / multi-screen wizard (see Approach B, rejected as
  over-engineered for four sections).
- No change to how `MediaPickerSheet` (the song/podcast search+picker UI) works
  internally.

## Architecture

### New screen: `app/(app)/edit-profile.tsx`

Top-level route (no id — always the signed-in user's own profile). Same
auth-gate pattern as `profile-customization.tsx` today (`OxyAuthPrompt` when
`!isAuthenticated`). Same `Header` shell (back button, saving indicator) as the
two screens it replaces. One `ScrollView`, sections in this order, each
separated by `SettingsListDivider`:

1. **Banner** — extracted from `appearance.tsx`'s existing
   `openHeaderPicker`/`removeHeaderImage`/`headerImageId` logic (the
   `FileManagement` bottom-sheet flow). New local component `BannerSection`.
2. **Profile style** — extracted verbatim from `profile-customization.tsx`
   (`StyleOption` cards, `handleStyleSelect`, the default/minimalist preview
   cards). New local component `ProfileStyleSection`.
3. **Profile color** — reuses `ColorSwatchPicker` + `useAppColorSave` as-is
   (already screen-agnostic); only ONE instance now exists in the app.
4. **Pinned song/podcast** — a new lightweight "edit row" (current pinned media
   preview + change/remove, or an "Add" affordance when empty) that opens the
   existing `MediaPickerSheet`. This replaces `ProfileMedia`'s owner-add-prompt
   branch, which is removed.
5. **Footer row** — "Cuenta Oxy" (or equivalent), opens `ManageAccount` via
   `showBottomSheet?.('ManageAccount')` — the exact call `ProfileHeader` makes
   today, just relocated.

### Changed: `components/Profile/ProfileHeader.tsx`

Both "Editar perfil" button instances (`ProfileHeaderDefault` and the second
header variant) change from `onPress={() => showBottomSheet?.('ManageAccount')}`
to `onPress={() => router.push('/edit-profile')}`.

### Changed: `components/Profile/ProfileMedia.tsx`

The `!media && isOwnProfile` branch (currently rendering the inline "+ Add song
or podcast" row) is removed — it now falls through to `return null`, matching
the existing non-owner/no-media behavior. The `media` present branches
(`ProfileSong` / `PodcastCard`) are unchanged — still shown to owner and
visitors alike.

### Changed: `app/(app)/settings/appearance.tsx`

Remove: `headerImageId` state, `openHeaderPicker`/`removeHeaderImage`, the
banner section JSX, the `ColorSwatchPicker`/`useAppColorSave` color section.
Keep: theme mode, post-text-length, read-more action, collapse-long-bio. The
`saveSettings` payload drops `profileHeaderImage`/`primaryColor` fields it no
longer owns. Settings menu row (`settings/index.tsx:220-224`) label/description
updated to drop the "colors" mention (currently "Theme, colors, display").

### Deleted: `app/(app)/settings/profile-customization.tsx`

Fully absorbed into the new screen. Its Settings menu row
(`settings/index.tsx:251-258`) is removed.

## Data flow

Unchanged. All four sections read from `useAppearanceStore`'s `mySettings` and
write via `updateMySettings` — exactly as `appearance.tsx`,
`profile-customization.tsx`, and `MediaPickerSheet` already do today. No new
store keys, no new API calls; this spec only moves existing, working
read/write wiring into one screen.

## Error handling

Unchanged per section — each section keeps its existing error handling
verbatim: `profile-customization.tsx`'s optimistic-update-with-rollback
pattern for style selection, `appearance.tsx`'s existing banner
upload/removal error paths, `MediaPickerSheet`'s existing toast-based errors.
Nothing about the save mechanics changes, only where the UI triggering them
lives.

## Testing

- New: a component test for `EditProfileScreen` covering the auth gate and
  that all four sections + the `ManageAccount` footer row render.
- Update: `ProfileHeader` test(s) — "Editar perfil" now asserts navigation to
  `/edit-profile` instead of opening the `ManageAccount` sheet.
- Update: `ProfileMedia` test(s) — the owner/no-media case now asserts `null`
  instead of the add-prompt row.
- Remove: any test file scoped specifically to `profile-customization.tsx`
  (superseded, not duplicated, by the new screen's tests).
- Unaffected: `useAppearanceStore`, `MediaPickerSheet`, `ColorSwatchPicker`,
  `useAppColorSave` tests — same components/store, no behavior change.

## Approaches considered

- **A — single consolidated route (chosen).** One screen, four sections, reuses
  existing sub-components/logic verbatim. Matches the exact pattern of the two
  screens it replaces (both are already full-screen routes, not sheets).
  Lowest implementation risk.
- **B — landing screen + per-section sub-routes.** Rejected: over-engineered for
  four sections: adds navigation plumbing with no present need (YAGNI).
- **C — bottom sheet (like `ManageAccount`).** Rejected: none of the three
  screens being consolidated use a sheet today; cramming banner upload + style
  cards + color swatches + song search into a sheet is more rework than A, not
  less.
