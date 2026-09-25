import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';

/**
 * The operator script's safety rails (OxyHQ/Mention#1169): it refuses an account
 * Oxy still resolves as active or cannot answer for, previews without writing,
 * and a live run goes through the same ledger + erasure as an Oxy event.
 */

const getUserById = vi.hoisted(() => vi.fn());
vi.mock('../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/oxyHelpers')>()),
  getServiceOxyClient: () => ({ getUserById }),
}));
vi.mock('../connectors/activitypub/delivery.service', () => ({
  deliveryService: { deliverToFollowers: vi.fn(async () => undefined) },
}));

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { accountErasures } from '../db/schema/accountErasures';
import { posts } from '../db/schema/posts';
import { clearServiceScope, seedPost, serviceScope } from './helpers/serviceFixtures';
import { readOxyAccountState, runOperatorErasure } from '../scripts/eraseOxyAccount';

const scope = serviceScope('erase-oxy-account-script');
const ACCOUNT = scope.user('gone');

function notFound(): Error {
  return Object.assign(new Error('Not found'), { status: 404 });
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await getDb().delete(accountErasures).where(like(accountErasures.oxyUserId, `oxy-${scope.name}-%`));
  await clearServiceScope(scope);
});

afterAll(async () => {
  await getDb().delete(accountErasures).where(like(accountErasures.oxyUserId, `oxy-${scope.name}-%`));
  await clearServiceScope(scope);
  await closePostgres();
});

describe('readOxyAccountState', () => {
  it('reads a 404 as deleted, an archived row as archived, anything else as active or unknown', async () => {
    getUserById.mockRejectedValueOnce(notFound());
    expect(await readOxyAccountState(ACCOUNT)).toBe('deleted');
    getUserById.mockResolvedValueOnce({ id: ACCOUNT, accountStatus: 'archived' });
    expect(await readOxyAccountState(ACCOUNT)).toBe('archived');
    getUserById.mockResolvedValueOnce({ id: ACCOUNT, username: 'alive' });
    expect(await readOxyAccountState(ACCOUNT)).toBe('active');
    getUserById.mockRejectedValueOnce(Object.assign(new Error('bad gateway'), { status: 502 }));
    expect(await readOxyAccountState(ACCOUNT)).toBe('unknown');
    getUserById.mockResolvedValueOnce(null);
    expect(await readOxyAccountState(ACCOUNT)).toBe('deleted');
  });
});

describe('runOperatorErasure', () => {
  it('refuses an account Oxy still resolves, and one Oxy cannot answer for', async () => {
    const post = await seedPost(scope, { oxyUserId: ACCOUNT });
    getUserById.mockResolvedValueOnce({ id: ACCOUNT, username: 'alive' });
    await expect(runOperatorErasure({ oxyUserId: ACCOUNT, username: null, dryRun: false })).rejects.toThrow(/active/);
    getUserById.mockRejectedValueOnce(new Error('timeout'));
    await expect(runOperatorErasure({ oxyUserId: ACCOUNT, username: null, dryRun: false })).rejects.toThrow(/unknown/);

    const [row] = await getDb().select({ id: posts.id }).from(posts).where(eq(posts.id, post.id));
    expect(row).toBeDefined();
  });

  it('previews without writing, then erases through the ledger on a live run', async () => {
    const post = await seedPost(scope, { oxyUserId: ACCOUNT });
    getUserById.mockRejectedValue(notFound());

    const preview = await runOperatorErasure({ oxyUserId: ACCOUNT, username: 'gone', dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, oxyState: 'deleted', federated: true });
    expect((preview.preview as Record<string, number>)['posts.oxyUserId']).toBe(1);
    expect(await getDb().select({ id: accountErasures.id }).from(accountErasures).where(eq(accountErasures.oxyUserId, ACCOUNT))).toHaveLength(0);

    const live = await runOperatorErasure({ oxyUserId: ACCOUNT, username: 'gone', dryRun: false });
    expect(live).toMatchObject({ dryRun: false, eventId: `operator:${ACCOUNT}`, outcome: 'completed' });
    const [gone] = await getDb().select({ id: posts.id }).from(posts).where(eq(posts.id, post.id));
    expect(gone).toBeUndefined();
    const [ledger] = await getDb()
      .select({ source: accountErasures.source, status: accountErasures.status })
      .from(accountErasures)
      .where(eq(accountErasures.eventId, `operator:${ACCOUNT}`));
    expect(ledger).toEqual({ source: 'operator', status: 'completed' });

    // A re-run resumes the same row and does nothing more.
    const again = await runOperatorErasure({ oxyUserId: ACCOUNT, username: 'gone', dryRun: false });
    expect(again).toMatchObject({ outcome: 'already-completed' });
  });
});
