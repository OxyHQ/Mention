interface TextVariantLike {
  text?: unknown;
}

const HTTP_LINK_PATTERN = /https?:\/\//i;

/**
 * Derive the indexed link-presence flag at write time. Search reads this scalar
 * instead of scanning every localized body with an unanchored regex.
 */
export function postTextHasHttpLink(
  variants: readonly TextVariantLike[] | null | undefined,
): boolean {
  return (variants ?? []).some(
    (variant) =>
      typeof variant?.text === 'string' && HTTP_LINK_PATTERN.test(variant.text),
  );
}
