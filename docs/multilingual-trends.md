# Deterministic multilingual trends

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

## Post membership and presentation

`trend_story_posts` materializes which posts belong to each stored story and its
deterministic relevance. A trend feed uses these rows when present and falls
back to term matching only for history that has not been backfilled.

Trend rows keep their corpus-derived name and may carry reviewed localized
labels. `GET /trending?lang=es&region=MX` selects a reviewed label and orders by
region and language without filtering the rest of the world away. No label is
machine-translated at request time.

## Backfill

After migrations, run:

```bash
bun run --cwd packages/backend backfill:multilingual-trends --dry-run
CONFIRM_ADMIN_MUTATION=backfillMultilingualTrends \
  bun run --cwd packages/backend backfill:multilingual-trends
```

The job is idempotent. It applies the current deterministic term extractor to
all posts, decorates retained trend rows, inserts missing memberships with
conflict protection, and publishes a fresh batch.
