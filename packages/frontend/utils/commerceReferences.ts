import { formatMercariaRef, parseMercariaRef } from '@mercaria.co/sdk';
import { MAX_COMMERCE_ATTACHMENTS, type CommerceReference } from '@mention/shared-types/commerce';

export { formatMercariaRef as commerceReferenceKey };
/** Old drafts can contain unknown fields; retain valid identities only, never provider facts. */
export function readCommerceReferences(value: unknown): CommerceReference[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, CommerceReference>();
  for (const item of value) {
    const ref = parseMercariaRef(item);
    if (ref?.kind === 'product' || ref?.kind === 'collection')
      unique.set(formatMercariaRef(ref), ref);
    if (unique.size === MAX_COMMERCE_ATTACHMENTS) break;
  }
  return [...unique.values()];
}
