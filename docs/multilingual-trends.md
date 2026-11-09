# Deterministic multilingual trends

Only posts whose author's profile is public count toward trends, stories and
the excerpts the labeller and the trend summary read
(`openAudienceAuthorSql`, `db/userProfile/profileAudience.ts`). A private or
followers-only profile's posts are for its followers, and a trend is shown to
everyone.

Mention detects stories without generative AI, embeddings, translation calls or
provider inference. Author-written terms and hashtags propose a trend; corpus
statistics decide whether it is unusual; a reviewed alias registry joins known
spellings across languages; and co-occurrence joins event-specific terms.

## Identities

- A **term** is normalized text an author wrote and remains retrieval evidence.
- A **concept** is a reviewed, language-independent identity. Unknown terms stay
  unresolved rather than being guessed.
- A **story** is one batch's coherent group of terms. It is temporal.
- A **topic** is the stable Oxy registry category. Mention never creates one
  from arbitrary extracted prose.

Language and region are independent. A Spanish post does not imply Spain, and a
US author does not imply that a post is about the United States. Material
support classifies a story as `global`, `multilingual`, `regional`, `language`,
or `community`.

## Relationship admission

A literal pair needs the minimum shared-post count and both directional support
ratios. Clusters additionally require a directly supported anchor for every
member. This prevents `A ↔ B ↔ C` from merging when A and C share no evidence.
Reviewed aliases of one concept may link across languages without literal
co-occurrence, but both spellings must independently clear the normal volume and
author floors in the same window.

The graph exposes each edge's normalized strength and reason (`cooccurrence` or
`canonical-alias`) so every merge is auditable.

## Topic relatedness (proposed)

[Oxy ADR 0060](https://github.com/OxyHQ/oxy/blob/main/docs/adr/0060-universal-topic-catalog.md)
proposes one Oxy topic catalog and a derived table of related topics that every
product feeds with co-occurrence observations. Its scoring core lives here,
pure and storage-free: `services/topics/relatedness.ts`. A direction A → B is a
Beta posterior `(co + α) / (volume(A) + α + β)` (default α = 0.5, β = 49.5), a
pair is scored by its weaker direction, a pair needs at least 3 shared items,
each topic keeps its top 20, and one item contributes at most 8 topics (28
pairs). Nothing reads it yet; trends keep the admission rules above until the
ADR's rollout reaches them.

## Post membership and presentation

`trend_story_posts` materializes which posts belong to each stored story and its
deterministic relevance. It also records an evidence envelope: whether the
author term or hashtag matched, whether cached link title/description or the
quoted/replied-to post corroborated it, the link origins, mention count, and the
separate repost/quote/reply amplification counts. A trend feed uses these rows
when present and falls back to term matching only for history that has not been
backfilled.

Context is deliberately asymmetric. Only author-written text or a hashtag may
admit a post into a story. Link metadata, a quote target, or a reply parent can
raise confidence in that existing match, but cannot turn an unrelated post into
a political post. Reposts never count as independent authors; they are retained
as amplification evidence. Link HTML is never fetched by Mention: the bounded
Oxy preview cache remains the SSRF-safe resolver and a cache miss simply adds no
link evidence on that pass.

Trend rows keep their corpus-derived name and may carry reviewed localized
labels. `GET /trending?lang=es,en&region=MX` filters membership to trends whose
measured language overlaps the reader's set, then uses region as an ordering
preference. It may return fewer than the requested limit; unrelated foreign
terms are never padding. The only cross-language exception is a registry-resolved
concept with corpus evidence for `scope=global` (multiple languages and regions).
Rows with no measured language do not match a declared reader. No label is
machine-translated at request time.

Trend language comes from each post's canonical
`postClassification.languages`, not directly from an ActivityPub declaration.
Consequently, a baseline-classifier version bump and language backfill also
repair trend attribution; the next trend calculation consumes the corrected
post rows.

### One name, one row

A row's label is derived from the posts behind its term, so two terms can end
up presenting the same name (`chinese` and `jensen huang` both reading "Jensen
Huang" when most of their posts say the full name). A reader cannot tell such
rows apart, so the batch treats them as one story: rows whose presented names
match (case, diacritics and punctuation ignored) merge under the highest-volume
term, and that merged row is re-measured through the same counting pass. Volume
and authors are distinct counts over the union, never a sum. If the re-measure
fails or no longer clears the floors, the representative keeps its own numbers
and the duplicates are still dropped. Pure grouping lives in
`services/trending/trendIdentity.ts`; the merge in `trendItems.ts`.

## Topic screen

`GET /trending/topic?term=` answers what `/t/:topic` states about one trend,
from the latest batch: its label, when it was last updated, its volume, authors,
momentum and scope, its recent curve, the people posting about it most in the
window (public, open-audience, not sensitive), and the trends that co-occur with
it in the stored graph. Nothing is generated. A term that is not in the current
batch answers with the term alone, and authors are resolved only for a live
trend, so the endpoint cannot be used to list who posts about an arbitrary string.

## Backfill

After migrations, run:

```bash
bun run --cwd packages/backend backfill:multilingual-trends --dry-run
CONFIRM_ADMIN_MUTATION=backfillMultilingualTrends \
  bun run --cwd packages/backend backfill:multilingual-trends
```

The job is idempotent. It applies the current deterministic term extractor to
all posts, decorates retained trend rows, upserts memberships and their current
context evidence, and publishes a fresh batch.

When the baseline language policy changes, run the separate post-language
backfill first so the multilingual trend job reads corrected inputs:

```bash
bun packages/backend/dist/src/scripts/backfillPostLanguages.js --dry-run
CONFIRM_ADMIN_MUTATION=backfillPostLanguages \
  bun packages/backend/dist/src/scripts/backfillPostLanguages.js
```
