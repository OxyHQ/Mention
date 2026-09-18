# Community notes and content warnings

Two things that both sit near a post's content and are easy to conflate. They
are deliberately separate features.

| | Content warning | Community note |
| --- | --- | --- |
| Written by | The post's author (or the federated `summary`) | Other readers |
| When | At publish time | After, and only once rated helpful |
| What it does | **Gates** the post: body and every block below stay hidden until the reader chooses to see them | **Adds context** under the post; hides nothing |
| Owner | Mention (`metadata.spoilerText`) | **CrowdSource** |

## Content warning (Mention)

`metadata.spoilerText` renders as `components/Post/ContentWarning.tsx`. Closed,
it replaces the body, location, sources and the attachments row (including a
quoted post) with one block and a Show button; open, it collapses to a single
line that can close it again. Opening it counts as consent, so the per-item
sensitive-media blur does not ask a second time. The state is per mounted row.

## Community notes (CrowdSource)

**Every part of the backend lives in CrowdSource**, the same way moderation
does (see `moderation-crowdsource.md`): notes, ratings, the scoring that decides
whether a note is shown, contributor eligibility, and the anonymity of writers
and raters. Mention stores none of it.

Mention's side:

- **Read:** `HydratedPostSummary.communityNote` (`CommunityNoteSummary`,
  `packages/shared-types/src/communityNotes.ts`) is the note CrowdSource shows
  under that post. It carries no writer or rater identity, ever. The frontend
  renders it only when `status === 'shown'`, below the attachments and above
  the actions, and never inside a quoted post or behind a closed content
  warning.
- **Write:** "Add community note" (post menu) and Helpful / Not helpful are
  forwarded to CrowdSource; the sheets only collect what the reader chose
  (`useCommunityNoteSheets` takes the `submitNote` / `rateNote` handlers).
- **Hub:** `/community-notes` — Rate notes / Your ratings / Your notes, all
  lists served by CrowdSource.

### How the two sides are wired

CrowdSource serves `/v1/community-notes/*` and Mention reaches it through
`@oxy.so/crowdsource`, with the SAME service key and client the moderation
integration uses (`services/moderation/crowdSourceClient.ts`). Nothing is
mounted and nothing is asked when `CROWDSOURCE_ENABLED` is false.

| Mention | CrowdSource |
| --- | --- |
| `POST /api/community-notes` | `POST /v1/community-notes` |
| `POST /api/community-notes/:id/withdraw` | `POST /v1/community-notes/{id}/withdraw` |
| `POST /api/community-notes/:id/ratings` | `POST /v1/community-notes/{id}/ratings` |
| `POST /api/community-notes/to-rate` | `POST /v1/community-notes/assignments` |
| `GET /api/community-notes/mine` | `GET /v1/community-notes/principals/{id}/notes` |
| `GET /api/community-notes/ratings` | `GET /v1/community-notes/principals/{id}/ratings` |
| `PostHydrationService` (batch) | `GET /v1/community-notes/shown?subjects=` |
| `POST /webhooks/crowdsource` | `community_note.status_changed` |

Four decisions are worth knowing before changing any of it:

- **The session names the principal.** A note's writer and a note's rater are
  the viewer's Oxy user id, taken from the session and never from the body —
  the same identity a report already carries (`reportedBy.oxyUserId`).
  CrowdSource stores it to enforce the exclusions the design needs (a writer
  never rates their own note, a post's author never rates a note about their
  post, a writer has a daily cap) and never returns, logs or audits it.
- **Reads fail open, writes fail loud.** A feed page whose lookup timed out is
  a page without notes. A note the writer typed and sent reports what happened,
  because a "submitted" sheet for a note that went nowhere is a lie.
- **The lookup is cached per post, including the absence of a note.** Redis,
  five minutes, dropped by the `community_note.status_changed` webhook. Without
  the negative entry every feed page would ask CrowdSource about every post on
  it; with it, a page of posts that have no notes costs one batched Redis read.
  The paths that hydrate a post the same request just wrote pass
  `includeCommunityNotes: false` — a post that did not exist a moment ago
  cannot carry a note.
- **Drawing the queue issues assignments.** `POST /to-rate` is a POST for that
  reason, and its idempotency key is the rater plus the hour, so reopening the
  hub re-reads the same queue instead of consuming a fresh batch.

### Operational requirements

Notes ride on the SAME credential, client and webhook endpoint as moderation,
so they need the whole integration switched on — which production has never
had. The sequence is in
[`moderation-crowdsource.md`](./moderation-crowdsource.md#switching-it-on-production-has-never-had-it-on).
What notes add to it is two lines: the credential needs
`crowdsource:community-notes:write` and `crowdsource:community-notes:read`, and
the webhook subscription needs `community_note.status_changed` — without that
event a note that starts being shown waits out the five-minute cache before
readers see it.

### Open questions

- Eligibility: who may write and rate (account age, Oxy Trust, prior ratings).
  CrowdSource enforces a per-writer daily cap today and nothing else.
- Federated posts: notes on remote posts are local to Mention/CrowdSource and
  never federate.
- Notifying a writer when their note starts being shown. The webhook carries
  the event; Mention drops its cache and writes no notification yet.
