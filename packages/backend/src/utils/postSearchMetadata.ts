interface TextVariantLike {
  text?: unknown;
}

const HTTP_LINK_PATTERN = /https?:\/\//i;

/**
 * Derive the indexed link-presence flag at write time. Search reads this scalar
 * instead of scanning every localized body with an unanchored regex
 * (`filter:links`, `routes/search.ts`).
 *
 * Called from the repository and nowhere else — `toPostInsert` on create and
 * `replacePostContent` on edit — so `posts.has_links` cannot disagree with the
 * bodies written in the same statement. It used to be a caller's job, which is
 * how every write path but the ActivityPub outbox backfill came to store `false`
 * for a post full of URLs.
 *
 * Reads the RENDITIONS only, which is what the column has always meant: an
 * article body or a `content.sources` entry does not make `filter:links` match.
 */
export function postTextHasHttpLink(
  variants: readonly TextVariantLike[] | null | undefined,
): boolean {
  return (variants ?? []).some(
    (variant) =>
      typeof variant?.text === 'string' && HTTP_LINK_PATTERN.test(variant.text),
  );
}
