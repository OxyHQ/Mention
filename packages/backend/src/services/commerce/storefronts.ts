import { eq } from 'drizzle-orm';
import {
  formatMercariaRef,
  parseMercariaRefString,
  type MercariaStore,
  type MercariaStoreRef,
} from '@mercaria.co/sdk';
import { getDb } from '../../db/postgres';
import { accountStorefronts } from '../../db/schema/commerce';
import { getMercariaClient } from './mercariaClient';
import { resolveMercariaStore } from './mercariaHydration';

export class StorefrontOwnershipError extends Error {}

export async function connectStorefront(
  accountId: string,
  store: MercariaStore,
): Promise<MercariaStoreRef> {
  // Mercaria's current public ownership is authoritative, never a supplied owner id.
  if (store.oxyAccountId !== accountId)
    throw new StorefrontOwnershipError('This storefront belongs to another account');
  await getDb()
    .insert(accountStorefronts)
    .values({ oxyAccountId: accountId, mercariaRef: formatMercariaRef(store.ref) })
    .onConflictDoUpdate({
      target: accountStorefronts.oxyAccountId,
      set: { mercariaRef: formatMercariaRef(store.ref), updatedAt: new Date() },
    });
  return store.ref;
}

export async function disconnectStorefront(accountId: string): Promise<void> {
  await getDb().delete(accountStorefronts).where(eq(accountStorefronts.oxyAccountId, accountId));
}

export async function readStorefront(accountId: string) {
  const [row] = await getDb()
    .select()
    .from(accountStorefronts)
    .where(eq(accountStorefronts.oxyAccountId, accountId))
    .limit(1);
  if (!row) return { state: 'disconnected' as const };
  const result = await resolveMercariaStore(parseMercariaRefString(row.mercariaRef));
  // Ownership transfers and suspended/deleted stores stop representing the former owner.
  if (result.state === 'available' && result.store.oxyAccountId !== accountId)
    return { state: 'gone' as const };
  return result;
}

export async function lookupStorefront(handle: string): Promise<MercariaStore> {
  return getMercariaClient().stores.lookup({ handle });
}
