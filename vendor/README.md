# Homiio SDK review artifacts

These two tarballs make the integration installable before Homiio's first SDK release.
They were built using `bun pm pack` from Homiio commit
`ee9c1aa201ed4ca8bd17cdf1f8394a0b05ddac78` (`codex/confirmed-sdk`):

- `homiio-contracts-0.1.0.tgz`: canonical Zod public-case contract and URL helpers.
- `homiio-sdk-0.1.0.tgz`: validated, cancellable public batch client.

The root contracts override resolves the SDK's `0.1.0` dependency to the same
review artifact. Both Docker manifest stages copy these files before installation.
No absolute filesystem paths, provider content, credentials, or runtime database
copies are needed.

Release order: merge and publish Homiio contracts, publish SDK, deploy Homiio's
public batch API with Mention's web origin permitted by CORS, then replace the
relative file dependencies and root override with the published package versions
and regenerate `bun.lock`. Do not consider the cards operational until that API
is deployed. An unavailable provider currently produces the unavailable card.

Artifact SHA-256:

```text
af24ab13dd786180484731030dcf219dcf669f4ed5830b2015d1ae66272a29ec  homiio-contracts-0.1.0.tgz
2cc359a18fc874b3264934f943dc979cd6aadf499e869315c92483d901abfd3e  homiio-sdk-0.1.0.tgz
```

## Syra public podcast reference cards

`syra.fm-contracts-0.1.0.tgz` and `syra.fm-sdk-0.17.0.tgz` were built with
`bun pm pack` from Syra commit `341d5663dd08760f8cccfd7a2e6596931fb7532c`
on `codex/confirmed-reference-cards`. The contracts package owns the strict
public batch request/response; the SDK validates complete ID accounting and
forwards cancellation without sending session credentials.

Release order: publish contracts, publish SDK, deploy Syra's public-cards API
(with Mention CORS), then replace these file pins with registry versions. Until
that deployment, cards show unavailable and the feed remains usable.

SHA-256:

```text
ea1a6cec84cec093109e270ba98aa57c40db948882637e9074117ad3ea3c8438  syra.fm-contracts-0.1.0.tgz
776a21054fe54e2c19520f891548462f0285fd65178ce93318cb5ef8b0add7d6  syra.fm-sdk-0.17.0.tgz
```

Mention now stores only `content.podcast.syraPodcastId`. Migration
`0069_podcast_reference_only` clears existing title/author/artwork/show URL
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
