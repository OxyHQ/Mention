# Published reference-card SDKs

The browser resolves Homiio case cards with `@oxy.so/homiio-sdk` 0.1.2
(`POST https://api.homiio.com/api/v1/cases/batch`) and Syra podcast cards with
`@syra.fm/sdk` 0.19.0 (`POST https://api.syra.fm/api/podcasts/public-cards`).
Both are anonymous, `no-store` batch reads whose CORS allows `https://mention.earth`
and `https://www.mention.earth`; any other Mention origin must be added on the
provider. Mention's web CSP lists both API origins in `connect-src`
(`MENTION_CSP_EXTENSIONS` in `packages/backend/src/app.ts`). Unavailable
providers produce unavailable cards without blocking feed reads.

Neither SDK is in the startup JavaScript, and neither brings Zod: zod's one way
into the app is `lib/notificationValidation`, and a second consumer would make
Metro hoist it into `__common`. `lib/references/homiioCases.ts` imports
`@oxy.so/homiio-sdk/client` (checks responses by hand) on first use, and the URL
and case-ID helpers in `@mention/shared-types/homiio` come from
`@oxy.so/homiio-contracts/links`. `@syra.fm/sdk` 0.19.0's client entry carries
no Zod. The events screen imports `@oxy.so/mention-contracts` for types only;
the API validates every command.

Mention stores only `content.podcast.syraPodcastId`. No provider call runs in
post/thread/reply creation, variant storage, repository reads, or hydration,
and every write stores NULL in the legacy `content_podcast_title` / `_author` /
`_artwork_url` / `_show_url` columns. Rows written before this change still hold
their copies, which nothing reads. Clearing them (and later dropping the
columns) is an irreversible data change kept out of this release: it needs the
owner's go-ahead as its own migration.

The visible-card store resolves current public facts through the SDK, batches
and deduplicates visible IDs (100 per request), times out after eight seconds,
and forgets content on failure, withdrawal, or loss of visibility. Every state
reserves the same height. Old feed cache objects contribute only an ID. Composer
drafts serialize and restore only IDs, including thread items; their previews
use the same resolver. Reading old local drafts strips snapshots in memory, and
the next save writes the reference-only representation. Search picker results
remain ephemeral. Pinned profile/music integration is outside this change.
