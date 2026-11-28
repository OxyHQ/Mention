import type { PostContentVariant } from '@mention/shared-types';

/**
 * Apply freshly re-mapped body text onto a post's STORED content variants.
 *
 * Shared by the one-shot federated repair sweeps (`reingestBlueskyPosts`,
 * `repairFederatedMentions`). Both re-derive a post's body from its source Note
 * and have to write the corrected text back WITHOUT disturbing the stored
 * language tags, `source`, or `createdAt` — a repair fixes the body, it does not
 * re-decide what language the body is in.
 *
 * Returns the new variant array when a body actually changed, or `undefined`
 * when nothing changed (or when there is nothing safe to repair) — so the caller
 * writes nothing and a re-run stays idempotent.
 *
 * Non-destructive by construction:
 *  - a post that has no stored body variant is left alone — that is the
 *    empty-post reingest script's job, not a body repair's;
 *  - a fresh mapping that produced NO body never blanks a content-bearing post;
 *  - only the text is swapped in, so the classifier-detected / author-declared
 *    tag a stored variant carries is preserved (never reset by the re-map).
 *
 * Variants are aligned by index — the federated ingest writes them in a
 * deterministic order (primary first). A structural mismatch (variant count
 * differs, only reachable for a rare multilingual note) repairs the PRIMARY body
 * text alone and leaves every other stored variant intact.
 */
export function repairVariantText(
  freshTexts: readonly string[],
  stored: readonly PostContentVariant[] | undefined | null,
): PostContentVariant[] | undefined {
  if (!stored || stored.length === 0) return undefined;
  if (freshTexts.length === 0) return undefined;

  if (freshTexts.length !== stored.length) {
    const freshPrimary = freshTexts[0];
    if (!freshPrimary || freshPrimary === stored[0].text) return undefined;
    return [{ ...stored[0], text: freshPrimary }, ...stored.slice(1)];
  }

  let changed = false;
  const next = stored.map((variant, i) => {
    const freshText = freshTexts[i];
    if (typeof freshText === 'string' && freshText.length > 0 && freshText !== variant.text) {
      changed = true;
      return { ...variant, text: freshText };
    }
    return variant;
  });
  return changed ? next : undefined;
}
