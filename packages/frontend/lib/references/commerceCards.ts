import type {
  CommerceAttachmentHydration,
  CommerceReference,
} from '@mention/shared-types/commerce';
import { VisibleReferenceStore } from './VisibleReferenceStore';

type AvailableCommerce = Extract<CommerceAttachmentHydration, { state: 'available' }> & {
  id: string;
  formatPrice?: (locale: string) => string;
};

/** Visible cards only, deduplicated and bounded. Facts expire before refresh and never persist. */
export const commerceCards = new VisibleReferenceStore<AvailableCommerce>(
  async (ids, { signal }) => {
    // Keep the SDK's validators out of the initial feed bundle.
    const { parseMercariaRefString, formatMercariaRef, formatMoney } = await import(
      '@mercaria.co/sdk'
    );
    const { commerceService } = await import('@/services/commerceService');
    const valid: { id: string; ref: CommerceReference }[] = [];
    const unavailableIds: string[] = [];
    for (const id of ids) {
      const ref = parseMercariaRefString(id);
      if (ref?.kind === 'product' || ref?.kind === 'collection') valid.push({ id, ref });
      else unavailableIds.push(id);
    }
    const items: AvailableCommerce[] = [];
    // Bound API batches and concurrent provider work even on a very large viewport.
    for (let start = 0; start < valid.length; start += 24) {
      const batch = valid.slice(start, start + 24);
      const result = await commerceService.hydrate(
        batch.map((item) => item.ref),
        signal,
      );
      if (result.items.length !== batch.length) throw new Error('Incomplete commerce response');
      result.items.forEach((value, index) => {
        const id = batch[index].id;
        if (value.state === 'available' && formatMercariaRef(value.ref) === id)
          items.push({
            ...value,
            id,
            ...('product' in value
              ? { formatPrice: (locale: string) => formatMoney(value.product.price, locale) }
              : {}),
          });
        else unavailableIds.push(id);
      });
    }
    return { items, unavailableIds };
  },
  { refreshMs: 30_000, timeoutMs: 8_000 },
);

/** Event code and authenticated transport load only after an explicit handoff. */
export async function recordCommerceHandoff(postId: string): Promise<void> {
  const { commerceService } = await import('@/services/commerceService');
  await commerceService.recordMetric('posts', postId, 'handoff');
}
