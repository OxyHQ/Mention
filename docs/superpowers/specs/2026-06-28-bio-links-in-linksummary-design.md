# Spec: Include bio URLs in the profile LinkSummary

**Date:** 2026-06-28
**Status:** approved design, implementing

## Context

The profile `LinkSummary` (collapsed "first link … and N other" row + bottom sheet,
fed at `ProfileContent.tsx:211` via `normalizeProfileLinks(profile.linksMetadata,
profile.links)` from `@oxyhq/core`) shows only the user's explicit profile links. Users
also put URLs in their **bio/description** text. Those should appear in the same link
list, and reactively — adding/removing a URL in the bio adds/removes it from the list
(the bio comes from React Query profile data, so re-render is automatic).

Mention-only frontend change.

## Goal

Merge URLs extracted from `profile.bio` into the LinkSummary link set, deduped against
the explicit links, affecting BOTH the collapsed row and the sheet.

## Architecture (Mention frontend)

### `utils/extractUrls.ts` (new, shared)
Extract a reusable URL parser from `LinkifiedText.tsx` (which has the regex
`https?:\/\/[^\s]+|www\.[^\s]+` + `trimUrlTrailingPunct` for stripping trailing
punctuation). `export function extractUrls(text: string): string[]` — returns the
cleaned URLs (trailing punctuation removed, `www.` forms normalized to `https://www.` so
they're openable). Refactor `LinkifiedText.tsx` to consume this util too, so the regex
lives in ONE place (no divergence).

### `utils/mergeBioAndProfileLinks.ts` (new)
```ts
export function mergeBioAndProfileLinks(
  linksMetadata?: ProfileLinkMetadata[],   // from @oxyhq/core
  links?: string[],
  bioText?: string,
): ProfileLink[]
```
- Start from `normalizeProfileLinks(linksMetadata, links)` (explicit links, first, with metadata).
- `extractUrls(bioText)` → for each, if its normalized URL (scheme/`www.`/trailing-slash stripped, lowercased — reuse `prettifyUrl` semantics) is NOT already present among the explicit links, append a `{ id: 'bio-<i>', url }` (no title → LinkSummary shows the prettified URL).
- Dedup by normalized URL; **explicit links win** (keep their title/description/image). Bio-only URLs come after the explicit ones, in bio order.
- Returns `ProfileLink[]` (same type the LinkSummary already consumes).

### Wiring
`ProfileContent.tsx`: replace the `:211` call
`<LinkSummary links={normalizeProfileLinks(profileData.linksMetadata, profileData.links)} />`
with `<LinkSummary links={mergeBioAndProfileLinks(profileData.linksMetadata, profileData.links, profileData.bio)} />`.
No change to `LinkSummary` itself — bio links flow through the same prop, so they appear
in both the collapsed row ("first … and N other") and the sheet.

## Edge cases
- No bio / no URLs → identical to today (just the explicit links).
- URL in both bio and explicit links → shown once (explicit kept).
- Bio URL without scheme (`www.x.com`) → normalized to an openable `https://` form for `onPressLink`.
- Hashtags/mentions/cashtags in bio are NOT links → `extractUrls` only matches the URL alternative, not the `#`/`@`/`$` patterns.
- Trailing punctuation in bio URLs (e.g. "see x.com.") → trimmed via the shared `trimUrlTrailingPunct`.

## Verification
- Unit-test `mergeBioAndProfileLinks` (explicit-only, bio-only, overlap dedup, ordering, no-bio) and `extractUrls` (plain, www, trailing punct, multiple, none).
- Frontend tsc (3 livekit allow-listed) + `build:frontend`; real check — a profile with a URL in its bio shows it in the LinkSummary row + sheet; removing it from the bio removes it; `LinkifiedText` still renders bio links inline as before (refactor didn't change behavior).
- Push via test-build → git-ops.

## Out of scope
- No backend change (bio already in the profile DTO).
- No titles/metadata for bio links (URL only).
- Not touching the explicit-links edit flow (Oxy services).
