# Published reference-card SDKs

Mention consumes registry packages `@oxy.so/homiio-contracts` and
`@oxy.so/homiio-sdk` 0.1.0, and `@syra.fm/contracts` 0.1.0 with
`@syra.fm/sdk` 0.17.0. Source commits and independently verified tarball
integrities are recorded in `reference-card-sdk-publications.json`.

Deploy the Homiio and Syra public batch APIs with Mention CORS before
considering cards operational. Unavailable providers produce unavailable cards
without blocking feed reads.

Mention now stores only `content.podcast.syraPodcastId`. Migration
`0073_podcast_reference_only` clears existing title/author/artwork/show URL
columns and installs a trigger that clears copies from old instances during
rollout. Nullable compatibility columns remain so the previous image's SQL
continues to work; its old podcast cards disappear until the new client loads.
No destructive post-deploy column drop is required. No provider call runs in
post/thread/reply creation, variant storage, repository reads, or hydration.

The visible-card store resolves current public facts through the SDK, batches
and deduplicates visible IDs (100 per request), times out after eight seconds,
and forgets content on failure, withdrawal, or loss of visibility. Every state
reserves the same height. Old feed cache objects contribute only an ID. Composer
drafts serialize and restore only IDs, including thread items; their previews
use the same resolver. Reading old local drafts strips snapshots in memory, and
the next save writes the reference-only representation. Search picker results
remain ephemeral. Pinned profile/music integration is outside this change.

Verification includes actual PostgreSQL upgrade/old-writer behavior, strict SDK
response accounting, Syra HTTP CORS OPTIONS/POST from Mention, malformed bodies
and rate-limit errors, withdrawal and outage UI, draft restoration, TypeScript
checks including the changed backend tests, backend builds, and Expo web export.
Device scrolling and deployed cross-origin smoke checks remain release checks.
