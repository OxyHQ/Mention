# Spec: Instagram-style profile links (`LinkSummary`)

**Date:** 2026-06-28
**Status:** approved design, pending implementation plan

## Context

A Mention profile should show its bio links the way Instagram does: a compact row
(a chain icon + the first link's URL truncated with an ellipsis + "and N other(s)")
that, when tapped, opens a **bottom sheet** listing every link (title + URL,
Linktree-style). Today Mention renders links as a plain inline list of URLs inside
`ProfileMeta` (above the stats); the user wants the new treatment **after the stats**
and the old inline display removed.

The profile **data already exists end-to-end** in Oxy: `@oxyhq/core`'s `User` has
`linksMetadata?: Array<{ url; title?; description?; image?; id? }>` (plus a legacy
`links?: string[]`), the contracts `UserProfileUpdate` supports it, the api persists +
serializes it, and `@oxyhq/services` already has the **edit** flow
(`EditProfileFieldScreen`) and a links **screen** (`UserLinksScreen`). So **no
model/contract/api change is needed** — this is a presentation feature.

## Goal

- A shared, pure normalizer in `@oxyhq/core` (`normalizeProfileLinks`) — the single place
  that turns Oxy profile link data into a clean `{ id, title?, url }[]`, reused by Mention
  and `@oxyhq/services`.
- A **Mention** component `LinkSummary` (collapsed summary row + bottom sheet), composed
  from **Bloom primitives** (`BottomSheet`/`Item`/`Icons`/`useTheme`). It is NOT a Bloom
  component — it's app UI built on the shared UI library.
- Mention renders `LinkSummary` after the profile stats and drops its inline links.
- `@oxyhq/services` swaps its own ad-hoc link extraction to the shared `normalizeProfileLinks`
  (its existing links UI/screen stays).

## Non-goals

- No editing in Mention — editing already exists in the Oxy services flow.
- No core/contracts/api data-model changes (`linksMetadata` already exists).
- No new Bloom component and no Bloom publish — Mention consumes Bloom 0.23.0 primitives.
- No per-link image/favicon rendering (use the chain icon). YAGNI.

## Architecture

### 1. `@oxyhq/core` — shared normalizer (data layer)
Add a pure helper (no UI, no new deps):
```ts
export interface ProfileLink { id: string; title?: string; url: string }
export function normalizeProfileLinks(
  linksMetadata?: Array<{ url: string; title?: string; description?: string; image?: string; id?: string }>,
  links?: string[],
): ProfileLink[]
```
Logic (mirrors `services` `ProfileScreen` lines ~117-133): prefer `linksMetadata`
(map to `{ id: id ?? String(index), title, url }`, drop entries without a `url`); else
map `links` strings to `{ id: String(index), url }`; return `[]` when neither present.
Pure + unit-testable. Exported from the core public surface. → bump + publish core.

### 2. Mention — `LinkSummary` component (app UI on Bloom primitives)
New component `packages/frontend/components/Profile/LinkSummary.tsx` (+ a `LinkSummarySheet`
content piece). Takes the normalized shape:
```ts
interface LinkSummaryProps {
  links: ProfileLink[];                       // from @oxyhq/core normalizeProfileLinks
  onPressLink?: (url: string) => void;        // default Linking.openURL
}
```
Behavior:
- `links.length === 0` → render `null`.
- **Collapsed row**: Bloom `Icons.ChainLink_Stroke2_Corner0_Rounded` + `prettify(links[0].url)`
  (strip `https?://(www\.)?`, strip trailing `/`) truncated to one line with ellipsis +,
  when `links.length > 1`, a non-truncating ` and ${n} other` / ` and ${n} others` suffix
  (Mention i18n via `t('profile.links.other' | 'others', { count })`). Whole row is a
  `Pressable`; styling matches Mention's existing link look (`text-primary text-[15px]`,
  muted icon).
- **Tap** (always, even for 1 link) → opens the bottom sheet through Mention's existing
  **`BottomSheetContext`** (`setBottomSheetContent(<LinkSummarySheet .../>)` + `openBottomSheet(true)`),
  the same host used by `ReportModal`/`AddToListSheet`.
- **`LinkSummarySheet`**: a "Links" header + one Bloom `Item` per link (`leading` = chain
  icon, `title` = `item.title || prettify(item.url)`, `subtitle` = `prettify(item.url)`
  muted via `Item`'s built-in `textSecondary`), `onPress` → `onPressLink(url)` then close.
- `prettify` is a tiny local util (the existing regex already used in `ProfileMeta`),
  extract it to `utils/prettifyUrl.ts` so the row and sheet share it (no duplication).

### 3. Mention — wiring
- `hooks/useProfileData.ts`: surface `linksMetadata` on `ProfileData` (already spreads the
  `User`; add the explicit field next to `links`).
- `components/Profile/ProfileContent.tsx`: after `ProfileStats` (~line 198, before
  `ProfileCommunities`) render
  `<LinkSummary links={normalizeProfileLinks(profile.linksMetadata, profile.links)}
     onPressLink={(u) => Linking.openURL(u)} />`.
- `components/Profile/ProfileMeta.tsx`: **remove** the inline links block (lines ~52-70)
  and drop the now-unused `links` prop from `ProfileMetaProps` + its call site (clean cut,
  no dead prop). Keep location + join date.
- Add i18n keys (`profile.links.other`, `profile.links.others`, sheet header `profile.links.title`)
  to Mention's translation files.
- Bump `@oxyhq/core` in Mention (Bloom unchanged at 0.23.0).

### 4. `@oxyhq/services` — adopt the shared normalizer
- `ui/screens/ProfileScreen.tsx`: replace the inline link extraction (lines ~117-133) with
  `normalizeProfileLinks(profileRes.linksMetadata, profileRes.links)`. Its existing collapsed
  `SettingsListItem` + `navigate('UserLinks')` + `UserLinksScreen` **stay unchanged** (only
  the normalization is shared now).
- Bump `@oxyhq/core` in services; ensure the SDK profile screen still renders links.

## Data flow
`api linksMetadata` → profile DTO (`@oxyhq/core User`) → `normalizeProfileLinks` →
`ProfileLink[]` → Mention `<LinkSummary>` (collapsed row → bottom sheet). services uses the
same normalizer feeding its own existing UI.

## Edge cases
- 0 links → nothing rendered (no empty row, no sheet).
- 1 link → no "and N other" suffix; tapping still opens the 1-item sheet (Instagram parity).
- Link without title → sheet row title falls back to the prettified URL.
- Long URLs → collapsed row truncates the URL only; the "and N other" stays visible.
- Legacy `links` strings with no `linksMetadata` → normalized to `{id,url}` (no title).

## Publish / bump order (upstream-first)
1. `@oxyhq/core`: add `normalizeProfileLinks` + unit test → build/tsc/test → bump (minor) →
   publish → verify the tarball exports it.
2. Consumers: bump `@oxyhq/core` in Mention and OxyHQServices; wire both; run their gates.
   Do not consume an unpublished workspace build. (Bloom is NOT published — Mention uses the
   already-installed 0.23.0 primitives.)

## Verification
- **core**: `bun run build` + tsc + unit test for `normalizeProfileLinks` (metadata path,
  legacy-strings path, empty, missing-url filtering).
- **Mention**: frontend tsc (3 livekit allow-listed) + `bun run build:frontend`; **real
  device/web check**: profile shows the collapsed row after stats, tap opens the "Links"
  sheet, rows open URLs, `ProfileMeta` no longer shows links. Test a profile with 1 link,
  3 links, 0 links, and a link with/without a title. (Mention is already running locally on
  `:3000` backend / `:8090` web — use it.)
- **services**: tsc + build; the SDK profile screen still renders links via the shared
  normalizer.
- Push each repo via `test-build` → `git-ops`.

## Out of scope / follow-up
- Editing links inside Mention (use the existing Oxy services edit flow).
- Promoting `LinkSummary` itself into Bloom as a reusable component (kept app-local for now).
- Per-link images/favicons; link-health/validation.
