/**
 * Hydrates persisted Mercaria refs into CURRENT Mercaria truth (#951).
 *
 * A Mention record persists only an SDK ref (`{ kind: 'product', id }` and
 * friends) — identity, never a title, price or availability. Rendering asks
 * Mercaria again, through `@mercaria.co/sdk`, every time:
 *
 *   persisted ref (unknown) → parseMercariaRef → client.*.resolveRef → state
 *
 * Every input yields exactly one discriminated state, and nothing here throws:
 *
 * | state         | when                                                        |
 * | ------------- | ----------------------------------------------------------- |
 * | `available`   | Mercaria served it; `url` is the SDK's canonical link        |
 * | `gone`        | `MercariaGoneError` — existed, no longer publicly available |
 * | `not_found`   | `MercariaNotFoundError` — Mercaria says it never existed    |
 * | `unavailable` | any other SDK failure; `retryable` is the SDK's own verdict |
 * | `invalid`     | the stored value is not a ref of the expected kind          |
 *
 * `not_found` and `gone` are only ever Mercaria's own answer: the SDK reports a
 * bare 404/410 from a proxy as a plain API error, which lands in `unavailable`.
 * Even so, a caller should HIDE an attachment on either rather than delete the
 * stored ref — a hidden ref costs nothing if the answer was wrong.
 *
 * FRESHNESS. There is no cache here, deliberately. Price and availability are
 * perishable and Mercaria decides the price a buyer pays at checkout, so a
 * hydrated product is a render-time fact, never something to persist. Any cache
 * added around these calls must be short-lived, keyed by `formatMercariaRef`,
 * and treated as a freshness hint only — never as current truth.
 *
 * DISTRIBUTION. Hydration is presentation. Nothing in ranking, feeds, search or
 * trending may read a hydration result: an attached product must reach exactly
 * the audience the same post would reach without it.
 */

import {
  formatMercariaRef,
  isMercariaError,
  MercariaGoneError,
  MercariaNotFoundError,
  MercariaValidationError,
  parseMercariaRef,
  type MercariaClient,
  type MercariaCollection,
  type MercariaCollectionRef,
  type MercariaProduct,
  type MercariaProductRef,
  type MercariaStore,
  type MercariaStoreRef,
} from '@mercaria.co/sdk';
import { config } from '../../config';
import { mapWithConcurrency } from '../../utils/concurrency';
import { logger } from '../../utils/logger';
import { getMercariaClient } from './mercariaClient';

/** A ref that did not hydrate. `invalid` carries no ref: there was none to parse. */
export type MercariaUnresolvedState<TRef> =
  | { state: 'gone'; ref: TRef }
  | { state: 'not_found'; ref: TRef }
  | { state: 'unavailable'; ref: TRef; retryable: boolean }
  | { state: 'invalid' };

export type MercariaProductHydration =
  | { state: 'available'; ref: MercariaProductRef; product: MercariaProduct; url: string }
  | MercariaUnresolvedState<MercariaProductRef>;

export type MercariaStoreHydration =
  | { state: 'available'; ref: MercariaStoreRef; store: MercariaStore; url: string }
  | MercariaUnresolvedState<MercariaStoreRef>;

export type MercariaCollectionHydration =
  | { state: 'available'; ref: MercariaCollectionRef; collection: MercariaCollection; url: string }
  | MercariaUnresolvedState<MercariaCollectionRef>;

type EntityKind = 'product' | 'store' | 'collection';

const INVALID = Object.freeze({ state: 'invalid' as const });

/** Map a failed SDK read onto a state. Never throws. */
function unresolved<TRef>(kind: EntityKind, ref: TRef, error: unknown): MercariaUnresolvedState<TRef> {
  if (error instanceof MercariaGoneError) return { state: 'gone', ref };
  if (error instanceof MercariaNotFoundError) return { state: 'not_found', ref };
  // `status: null` means the SDK refused the ref BEFORE sending anything (an id
  // of `.` or `..` parses as a ref but cannot be a path segment). That is bad
  // stored data, not a Mercaria outage.
  if (error instanceof MercariaValidationError && error.status === null) {
    logger.warn('[MercariaHydration] Stored ref refused by the SDK', { kind });
    return INVALID;
  }
  if (isMercariaError(error)) {
    logger.warn('[MercariaHydration] Mercaria read failed', {
      kind,
      code: error.code,
      status: error.status,
      retryable: error.retryable,
    });
    return { state: 'unavailable', ref, retryable: error.retryable };
  }
  // Not an SDK error at all — a defect, not an outage. Still degrade (the post
  // must render), but loudly, and never by falling back to a direct fetch.
  logger.error('[MercariaHydration] Unexpected failure hydrating a Mercaria ref', error);
  return { state: 'unavailable', ref, retryable: false };
}

async function resolveProduct(client: MercariaClient, ref: MercariaProductRef): Promise<MercariaProductHydration> {
  try {
    const product = await client.products.resolveRef(ref);
    return { state: 'available', ref, product, url: client.links.product(product) };
  } catch (error) {
    return unresolved('product', ref, error);
  }
}

/**
 * Hydrate persisted product refs, index-aligned with the input.
 *
 * Each element is validated as UNKNOWN data (as it comes back from a database
 * or a JSON body); anything that is not exactly a product ref — a variant or
 * store ref included — is `invalid` and sends no request. Identical refs are
 * read once and share one result, and at most
 * `config.mercaria.hydrationConcurrency` reads are in flight at a time.
 */
export async function hydrateMercariaProductRefs(refs: readonly unknown[]): Promise<MercariaProductHydration[]> {
  const parsed = refs.map((value) => {
    const ref = parseMercariaRef(value);
    return ref?.kind === 'product' ? ref : null;
  });

  const unique = new Map<string, MercariaProductRef>();
  for (const ref of parsed) {
    if (ref === null) continue;
    const key = formatMercariaRef(ref);
    if (!unique.has(key)) unique.set(key, ref);
  }
  if (unique.size === 0) return parsed.map(() => INVALID);

  const client = getMercariaClient();
  const entries = [...unique.entries()];
  const settled = await mapWithConcurrency(entries, config.mercaria.hydrationConcurrency, ([, ref]) =>
    resolveProduct(client, ref),
  );

  const byKey = new Map<string, MercariaProductHydration>();
  entries.forEach(([key, ref], index) => {
    const outcome = settled[index];
    // `resolveProduct` converts every failure into a state, so a rejected slot
    // is unreachable today; it is mapped rather than trusted.
    byKey.set(key, outcome.status === 'fulfilled' ? outcome.value : unresolved('product', ref, outcome.reason));
  });

  return parsed.map((ref) => (ref === null ? INVALID : (byKey.get(formatMercariaRef(ref)) ?? INVALID)));
}

/** Hydrate one persisted store ref (e.g. an account's connected storefront). */
export async function resolveMercariaStore(value: unknown): Promise<MercariaStoreHydration> {
  const ref = parseMercariaRef(value);
  if (ref?.kind !== 'store') return INVALID;
  const client = getMercariaClient();
  try {
    const store = await client.stores.resolveRef(ref);
    return { state: 'available', ref, store, url: client.links.store(store) };
  } catch (error) {
    return unresolved('store', ref, error);
  }
}

/**
 * Hydrate one persisted collection ref.
 *
 * `url` is the collection DTO's own canonical `url`, which the SDK documents as
 * the same string `links.collection` builds. The link helper needs the store's
 * current handle, which a collection does not carry, so using it here would cost
 * a second read of the store for an identical string.
 */
export async function resolveMercariaCollection(value: unknown): Promise<MercariaCollectionHydration> {
  const ref = parseMercariaRef(value);
  if (ref?.kind !== 'collection') return INVALID;
  const client = getMercariaClient();
  try {
    const collection = await client.collections.resolveRef(ref);
    return { state: 'available', ref, collection, url: collection.url };
  } catch (error) {
    return unresolved('collection', ref, error);
  }
}
