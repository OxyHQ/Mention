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

### What CrowdSource has to provide

- Create a note for a post (text ≤ 500 chars, optional source URL); a note
  cannot be edited after submission, only deleted by its writer.
- Rate a note: `helpful` | `not_helpful` with at least one reason from
  `COMMUNITY_NOTE_HELPFUL_REASONS` / `COMMUNITY_NOTE_NOT_HELPFUL_REASONS`;
  final, one per rater.
- The shown/needs-ratings decision. The copy promises "shown when people who
  usually rate differently both find it helpful", i.e. a bridging score, not a
  vote count — CrowdSource must not ship a simple majority under that copy.
- The per-viewer lists for the hub (queue to rate, rated, written).
- A batch lookup Mention's `PostHydrationService` can call to attach
  `communityNote` to posts, cheaply enough for feed pages.
- Notify the writer when their note starts being shown.

### Open questions

- Eligibility: who may write and rate (account age, Oxy Trust, prior ratings).
- Federated posts: notes on remote posts are local to Mention/CrowdSource and
  never federate.
- Localisation of note text (CrowdSource resolves `text` per reader).

The frontend in `components/CommunityNotes/` is UI-complete against mock data;
nothing sends to CrowdSource until those endpoints exist.
