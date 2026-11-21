import { lookupManyOf } from '../helpers/oxyLookup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostUser } from '@mention/shared-types';
import { SYSTEM_NOTIFICATION_ACTOR_ID } from '@mention/shared-types/notification';

/**
 * Every response that embeds a user carries Oxy's `updatedAt` beside the
 * identity it describes, whichever serializer builds the embed. Placeholders
 * (an unresolved account, the system actor) carry none, so they never outrank a
 * real copy on the client.
 */

const UPDATED_AT = '2026-11-20T18:30:00.000Z';

const { getUsersByIds, getUserById } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ users: { get: (...args: unknown[]) => getUserById(...args) } }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    users: {
      getMany: (...args: unknown[]) => getUsersByIds(...args),
      lookupMany: lookupManyOf((ids: string[]) => getUsersByIds(ids)),
    },
  }),
}));

vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map()),
  mset: vi.fn(async () => undefined),
  invalidate: vi.fn(async () => undefined),
}));

import {
  resetOxyUserFailureMemory,
  resolveUserSummaries,
} from '../../services/PostHydrationService';
import { avatarIdentitySummary } from '../../utils/avatarIdentitySummary';
import { resolveKnownUsers } from '../../utils/knownUsers';
import { resolveLaneOwners } from '../../services/search/overviewLanes';
import { toMcpUserSummary } from '../../mcp/utils/mcpUserSummary';

function oxyUser(id: string) {
  return {
    id,
    username: `user-${id}`,
    name: { displayName: `User ${id}` },
    avatar: `avatar-${id}`,
    updatedAt: UPDATED_AT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOxyUserFailureMemory();
  getUsersByIds.mockImplementation(async (ids: string[]) => ids.map(oxyUser));
});

describe('embedded user updatedAt', () => {
  it('passes Oxy updatedAt through the bulk read into the author summary', async () => {
    const summaries = await resolveUserSummaries(['author']);
    expect(summaries.get('author')?.user).toMatchObject({ id: 'author', updatedAt: UPDATED_AT });
  });

  it('passes it through the per-id fallback read too', async () => {
    getUsersByIds.mockRejectedValue(new Error('chunk timed out'));
    getUserById.mockImplementation(async (id: string) => oxyUser(id));

    const summaries = await resolveUserSummaries(['fallback']);
    expect(getUserById).toHaveBeenCalledWith('fallback');
    expect(summaries.get('fallback')?.user.updatedAt).toBe(UPDATED_AT);
  });

  it('leaves the unresolved placeholder without one', async () => {
    getUsersByIds.mockResolvedValue([]);
    const summaries = await resolveUserSummaries(['gone']);
    expect(summaries.get('gone')?.user.username).toBe('');
    expect(summaries.get('gone')?.user).not.toHaveProperty('updatedAt');
  });

  it('keeps it on notification actors and the synthetic system actor has none', async () => {
    const actors = await resolveKnownUsers(['actor', SYSTEM_NOTIFICATION_ACTOR_ID]);
    expect(actors.get('actor')?.updatedAt).toBe(UPDATED_AT);
    expect(actors.get(SYSTEM_NOTIFICATION_ACTOR_ID)).not.toHaveProperty('updatedAt');
  });

  it('keeps it on facepile identities', () => {
    const user: PostUser = {
      id: 'member',
      username: 'member',
      name: { displayName: 'Member' },
      updatedAt: UPDATED_AT,
    };
    expect(avatarIdentitySummary(user).updatedAt).toBe(UPDATED_AT);
  });

  it('keeps it on search lane owners', async () => {
    const owners = await resolveLaneOwners([[{ ownerOxyUserId: 'owner' }]]);
    expect(owners.get('owner')).toMatchObject({ id: 'owner', updatedAt: UPDATED_AT });
  });

  it('keeps it on the MCP identity, and omits it when Oxy did not answer', () => {
    expect(toMcpUserSummary('mcp-user', oxyUser('mcp-user') as never).updatedAt).toBe(UPDATED_AT);
    expect(toMcpUserSummary('mcp-user').updatedAt).toBeUndefined();
  });
});
