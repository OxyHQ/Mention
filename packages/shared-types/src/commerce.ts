import type {
  MercariaCollection,
  MercariaCollectionRef,
  MercariaPage,
  MercariaProduct,
  MercariaProductRef,
  MercariaProductSummary,
  MercariaStore,
  MercariaStoreRef,
} from '@mercaria.co/sdk';

/** Mercaria owns these identities; Mention stores only their canonical references. */
export type CommerceReference = MercariaProductRef | MercariaCollectionRef;
export const MAX_COMMERCE_ATTACHMENTS = 4;

export type CommerceAttachmentHydration =
  | { state: 'available'; ref: MercariaProductRef; product: MercariaProduct; url: string }
  | { state: 'available'; ref: MercariaCollectionRef; collection: MercariaCollection; url: string }
  | { state: 'gone' | 'not_found' | 'invalid'; ref?: CommerceReference }
  | { state: 'unavailable'; ref: CommerceReference; retryable: boolean };

export interface CommerceStorefront {
  store: MercariaStore;
  products: MercariaPage<MercariaProductSummary>;
  collections: MercariaPage<MercariaCollection>;
}

export interface ConnectedStorefront {
  accountId: string;
  ref: MercariaStoreRef;
}

export type StorefrontState =
  | { state: 'available'; ref: MercariaStoreRef; store: MercariaStore; url: string }
  | { state: 'disconnected' | 'gone' | 'not_found' | 'invalid' }
  | { state: 'unavailable'; retryable: boolean };
