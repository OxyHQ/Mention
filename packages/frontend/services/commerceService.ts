import type {
  CommerceAttachmentHydration,
  CommerceReference,
  ConnectedStorefront,
  StorefrontState,
} from '@mention/shared-types/commerce';
import type {
  MercariaPage,
  MercariaProductSummary,
  MercariaCollection,
  MercariaProductListOptions,
} from '@mercaria.co/sdk';

export type StoreProductOptions = Pick<
  MercariaProductListOptions,
  'query' | 'cursor' | 'sort' | 'inStock' | 'limit'
>;
import { authenticatedClient, publicClient } from '@/utils/api';

export const commerceService = {
  async recordMetric(kind: 'stores' | 'posts', id: string, event: 'open' | 'handoff') {
    await authenticatedClient.post(`/commerce/metrics/${kind}/${encodeURIComponent(id)}`, {
      event,
    });
  },
  async metrics(kind: 'stores' | 'posts', id: string) {
    return (
      await authenticatedClient.get<{
        periodDays: number;
        minimumOpens: number;
        suppressed: boolean;
        opens: number | null;
        handoffs: number | null;
      }>(`/commerce/metrics/${kind}/${encodeURIComponent(id)}`)
    ).data;
  },
  async hydrate(refs: readonly CommerceReference[], signal?: AbortSignal) {
    return (
      await publicClient.post<{ items: CommerceAttachmentHydration[] }>(
        '/commerce/hydrate',
        { refs },
        { signal },
      )
    ).data;
  },
  async storefront(accountId: string): Promise<StorefrontState> {
    return (
      await authenticatedClient.get<StorefrontState>(
        `/commerce/accounts/${encodeURIComponent(accountId)}`,
      )
    ).data;
  },
  async connect(accountId: string, handle: string): Promise<ConnectedStorefront> {
    return (
      await authenticatedClient.put<ConnectedStorefront>(
        `/commerce/accounts/${encodeURIComponent(accountId)}`,
        { handle },
      )
    ).data;
  },
  async disconnect(accountId: string) {
    await authenticatedClient.delete(`/commerce/accounts/${encodeURIComponent(accountId)}`);
  },
  async products(
    params: { query?: string; cursor?: string } = {},
  ): Promise<MercariaPage<MercariaProductSummary>> {
    return (
      await publicClient.get<MercariaPage<MercariaProductSummary>>('/commerce/products', { params })
    ).data;
  },
  async storeProducts(
    accountId: string,
    params: StoreProductOptions = {},
    signal?: AbortSignal,
  ): Promise<MercariaPage<MercariaProductSummary>> {
    return (
      await authenticatedClient.get<MercariaPage<MercariaProductSummary>>(
        `/commerce/accounts/${encodeURIComponent(accountId)}/products`,
        { params, signal },
      )
    ).data;
  },
  async featuredCollections(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<MercariaPage<MercariaCollection>> {
    return (
      await authenticatedClient.get<MercariaPage<MercariaCollection>>(
        `/commerce/accounts/${encodeURIComponent(accountId)}/featured-collections`,
        { params: { limit: 20 }, signal },
      )
    ).data;
  },
  async featuredCollectionProducts(
    accountId: string,
    collectionId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<MercariaPage<MercariaProductSummary>> {
    return (
      await authenticatedClient.get<MercariaPage<MercariaProductSummary>>(
        `/commerce/accounts/${encodeURIComponent(accountId)}/featured-collections/${encodeURIComponent(collectionId)}/products`,
        { params: { cursor, limit: 6 }, signal },
      )
    ).data;
  },
  async storeCollections(
    accountId: string,
    cursor?: string,
  ): Promise<MercariaPage<MercariaCollection>> {
    return (
      await authenticatedClient.get<MercariaPage<MercariaCollection>>(
        `/commerce/accounts/${encodeURIComponent(accountId)}/collections`,
        { params: { cursor } },
      )
    ).data;
  },
};
