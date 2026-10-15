# Homiio case cards

Mention stores `content.homiioCase = { caseId }`, backed by
`posts.content_homiio_case_id` (migration `0072_ecosystem_references_and_events`). There is
no foreign key, address column, or provider content snapshot. The repository
projects untrusted references to the ID on both insert and replacement; hydration
returns the ID without calling Homiio. Existing case links can also become cards
at read time without a provider call or a data-copy migration.

Paste a canonical `https://homiio.com/evictions/<id>` link in the composer, or open
`/compose?homiioCaseId=<id>` from Homiio. Sharing prefills that removable link and
shows a preview; removing the link removes the attachment. Ordinary drafts and
scheduled posts preserve the link. Each post attaches its first canonical case
link. API callers can instead send `content.homiioCase`. Edits to body text
recompute the link-derived reference unless the request supplies an explicit
reference. Case participation stays in Homiio, reached through the card link.

Homiio URLs are excluded from Clarity previews on both the frontend and backend,
including direct link-preview requests. Previously cached generic link cards
cannot override the current SDK result. The Homiio card displays public title,
approximate area label, date, status, and a canonical link only.

`VisibleReferenceStore<T>` is reusable by other SDK integrations. The loader takes
`(ids, { signal })` and returns `{ items, unavailableIds }`, with one accounted-for
result per ID. `useVisibleReference(store, id, visible)` subscribes only while a
card is visible. `useReferenceVisibility(postId)` uses an IntersectionObserver on
web and the native feed's actual FlashList viewable keys, plus screen focus and
foreground state. The store combines subscriptions over 16 ms, deduplicates IDs,
and lives outside persistent feed/query/SQLite caches. Hiding the last matching
card forgets its data. Re-entry and 30-second visible refreshes validate current
facts, replacing them with loading first. An 8-second timeout wins even against a
provider that ignores abort. Failures, malformed batches, and withdrawn resources
become unavailable without old content. Responses from a removed/recycled
subscription cannot restore facts. All three card states reserve 200 px (or the
row's shared larger height), so provider latency cannot shift the feed.

The pending SDK release and artifact provenance are in `vendor/README.md`.
Verification covers reference sanitization, real PostgreSQL insert/edit/reload,
hydration and Clarity exclusion, viewport grouping/deduplication, hung requests,
late responses, withdrawal, native visibility gating, compose intent, and card
loading/error layout. Real browser scrolling and iOS/Android visual checks remain
release checks; Jest's measured-key tests do not prove device geometry.
