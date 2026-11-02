/**
 * The registration pass sends this deployment's `user_settings` accounts to Oxy in
 * bounded, idempotent batches and never throws (#1748).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { userSettings } from '../db/schema/userProfile';
import { setRuntimeOxyClient } from '../runtime/oxyClient';
import { registerLocalAccountsOnce } from '../services/applicationAccountRegistrationJob';

const ids = ['appacct-a', 'appacct-b', 'appacct-c'];

beforeAll(async () => {
  await connectPostgres();
  await getDb()
    .insert(userSettings)
    .values(ids.map((oxyUserId) => ({ oxyUserId })))
    .onConflictDoNothing();
});

afterAll(async () => {
  await getDb().delete(userSettings).where(inArray(userSettings.oxyUserId, ids));
  await closePostgres();
});

describe('registerLocalAccountsOnce', () => {
  it('registers every settings account, including one that never posted, in batches of at most 500', async () => {
    const sent: string[][] = [];
    setRuntimeOxyClient({
      registerApplicationAccounts: async (batch: string[]) => {
        sent.push(batch);
        return batch.length;
      },
    } as never);

    const result = await registerLocalAccountsOnce();

    expect(result.wrapped).toBe(true);
    for (const batch of sent) expect(batch.length).toBeLessThanOrEqual(500);
    const all = sent.flat();
    for (const id of ids) expect(all).toContain(id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('swallows an Oxy failure instead of throwing into the scheduler', async () => {
    setRuntimeOxyClient({
      registerApplicationAccounts: async () => {
        throw new Error('oxy unavailable');
      },
    } as never);
    await expect(registerLocalAccountsOnce()).resolves.toEqual({ registered: 0, wrapped: false });
  });
});
