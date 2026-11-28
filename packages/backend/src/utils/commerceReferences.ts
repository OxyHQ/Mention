import { formatMercariaRef, parseMercariaRef, parseMercariaRefString } from '@mercaria.co/sdk';
import { MAX_COMMERCE_ATTACHMENTS, type CommerceReference } from '@mention/shared-types/commerce';
import type { PostAttachmentDescriptor } from '@mention/shared-types/post';

/** Validate identity only; publication never depends on a commerce provider being online. */
export function parseCommerceReferences(value: unknown): {
  refs?: CommerceReference[];
  error?: string;
} {
  if (value === undefined) return {};
  if (value === null) return { refs: [] };
  if (!Array.isArray(value) || value.length > MAX_COMMERCE_ATTACHMENTS) {
    return {
      error: `commerce must contain at most ${MAX_COMMERCE_ATTACHMENTS} Mercaria references`,
    };
  }
  const refs: CommerceReference[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const ref = parseMercariaRef(item);
    if (ref?.kind !== 'product' && ref?.kind !== 'collection') {
      return { error: 'commerce must contain canonical Mercaria product or collection references' };
    }
    const key = formatMercariaRef(ref);
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  }
  return { refs };
}

export function commerceReferencesFromAttachments(
  attachments: readonly PostAttachmentDescriptor[],
): CommerceReference[] {
  const refs: CommerceReference[] = [];
  for (const attachment of attachments) {
    if (attachment.type !== 'commerce' || !attachment.id) continue;
    const ref = parseMercariaRefString(attachment.id);
    if (ref?.kind === 'product' || ref?.kind === 'collection') refs.push(ref);
  }
  return refs;
}
