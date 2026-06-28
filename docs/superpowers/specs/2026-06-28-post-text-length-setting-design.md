# Spec: Per-user post text length setting

**Date:** 2026-06-28
**Status:** approved design, implementing

## Context

Mention truncates a post's body text to **280 chars** in feeds with a "read more" link
to the post detail (`PostContentText.tsx:17` `previewChars = 280`; `shouldTruncate =
!isDetailPage && textContent.length > previewChars`; the component already accepts an
optional `previewChars` prop). Some users want more text inline. Add a **Mention-only
display preference** letting each user choose how much post text shows before truncating.

This is a Mention display preference — it lives in Mention's `UserSettings.appearance`,
NOT in Oxy core/account settings.

## Goal

A setting `postTextExpand` with four levels, applied to feed post text:
- `default` → 280 chars (current)
- `more` → 600
- `muchMore` → 1200
- `all` → no truncation in feed (no "read more")

## Architecture (Mention only)

### Backend (`packages/backend`)
- `models/UserSettings.ts`: add `postTextExpand?: 'default' | 'more' | 'muchMore' | 'all'` to the `AppearanceSettings` interface + schema (`enum`, `default: 'default'`), next to `themeMode`/`primaryColor`.
- `routes/profileSettings.ts` (`PUT /profile/settings`): in the `appearance` validation block, accept `postTextExpand` only when it's one of the 4 enum values (mirror the `themeMode` validation). `GET /profile/settings/me` already returns the whole `appearance` object — no change.

### Frontend (`packages/frontend`)
- **Store types**: extend the `AppearanceSettings` shape in `store/appearanceStore.ts` (and any settings type) with the optional `postTextExpand`.
- **Settings UI** `app/(app)/settings/appearance.tsx`: add a Bloom `SegmentedControl` (`type="radio"`) mirroring the existing theme-mode control — items Default / More / Much more / Show all. `onChange` → `updateMySettings({ appearance: { ...themeMode/primaryColor as today..., postTextExpand: value } })` (the existing `saveSettings` callback; keep current fields intact). i18n labels.
- **PostContentText** `components/Post/PostContentText.tsx`: read `useAppearanceStore((s) => s.mySettings?.appearance?.postTextExpand) ?? 'default'`, map to `previewChars` via a small const map `{ default:280, more:600, muchMore:1200, all: Infinity }`. When `all`, `shouldTruncate` is false (no "read more"). Keep `isDetailPage` always-full behavior. The existing `previewChars` prop still overrides if explicitly passed.
- i18n keys: `settings.appearance.postTextLength` + the 4 option labels.

## Data flow
`UserSettings.appearance.postTextExpand` → `GET /profile/settings/me` → `useAppearanceStore.mySettings` (loaded on init via the existing `useServerAppearanceSync`) → `PostContentText` reads it → `previewChars`. Updating in settings PUTs + updates the store → all post texts re-render with the new threshold.

## Edge cases
- Setting absent/old clients → `default` (280), current behavior.
- `all` → never truncates in feed; detail page already shows full (unchanged).
- Signed-out / no settings loaded → `default`.
- The map is the single source of the char thresholds (no magic numbers scattered).

## Verification
- Backend: tsc + the settings route accepts/persists the new enum, rejects invalid values; existing `appearance` updates (themeMode) still work.
- Frontend: tsc (3 livekit allow-listed) + `build:frontend`; real check — change the setting in Settings → Appearance, confirm feed posts truncate at the chosen length (and `all` shows full with no "read more").
- Push via test-build → git-ops (backend deploys to ECS, frontend to CF Pages).

## Out of scope
- Not an Oxy-account-wide setting (Mention-only).
- No per-post override UI; no line-based (numberOfLines) variant — char-count only, reusing the existing `previewChars` mechanism.
