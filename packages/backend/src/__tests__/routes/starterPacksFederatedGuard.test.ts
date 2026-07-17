import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A federated-source starter pack (mirrored from atproto) is read-only through
 * Mention's write API: every mutation route rejects it with 403 BEFORE the
 * ownership check, so a local user can never edit or delete an upstream-owned pack
 * (its membership is re-synced in place and a local edit would be overwritten).
 * Following its members (`POST /:id/use`) stays allowed. The model + the collaborator
 * services are mocked so the router runs in isolation.
 */

const { findById } = vi.hoisted(() => ({ findById: vi.fn() }));

vi.mock('../../models/StarterPack', () => ({
  default: { findById },
}));

// Heavy collaborators the router imports — stubbed so importing it never drags in
// the Oxy service chain / a server circular import.
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn().mockResolvedValue(new Map()),
  isFallbackUserSummary: vi.fn().mockReturnValue(false),
}));
vi.mock('../../services/userSummaryCache', () => ({ invalidate: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/EndorsementSignalService', () => ({
  endorsementSignalService: {
    syncScope: vi.fn().mockResolvedValue(undefined),
    syncScopeMembershipChange: vi.fn().mockResolvedValue(undefined),
    syncScopeRemoval: vi.fn().mockResolvedValue(undefined),
  },
}));

import starterPacksRoutes from '../../routes/starterPacks';

const READONLY_MESSAGE = 'This starter pack is mirrored from an external network and is read-only';

let authUserId: string | undefined = 'viewer-1';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { user?: { id: string } }).user = authUserId ? { id: authUserId } : undefined;
  next();
});
app.use('/starter-packs', starterPacksRoutes);

function federatedPack(): Record<string, unknown> {
  return {
    _id: 'pack-fed',
    ownerOxyUserId: 'oxy-federated-owner',
    name: 'Bluesky pack',
    memberOxyUserIds: ['a', 'b'],
    source: { network: 'atproto', uri: 'at://did:plc:x/app.bsky.graph.starterpack/p1', syncedAt: new Date() },
    save: vi.fn(),
    deleteOne: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authUserId = 'viewer-1';
});

describe('federated starter pack is read-only', () => {
  it.each([
    ['put', '/starter-packs/pack-fed', { name: 'hacked' }],
    ['post', '/starter-packs/pack-fed/members', { userIds: ['c'] }],
    ['delete', '/starter-packs/pack-fed/members', { userIds: ['a'] }],
    ['delete', '/starter-packs/pack-fed', {}],
  ] as const)('rejects %s %s with 403 read-only', async (method, path, body) => {
    const pack = federatedPack();
    findById.mockResolvedValue(pack);

    const res = await request(app)[method](path).send(body);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(READONLY_MESSAGE);
    // The mutation never happened.
    expect(pack.save).not.toHaveBeenCalled();
    expect(pack.deleteOne).not.toHaveBeenCalled();
  });

  it('rejects the federated pack before the ownership check (even for a non-owner)', async () => {
    authUserId = 'someone-else';
    findById.mockResolvedValue(federatedPack());

    const res = await request(app).put('/starter-packs/pack-fed').send({ name: 'x' });

    // Read-only wins over "Not allowed" — the pack is never editable by anyone.
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(READONLY_MESSAGE);
  });
});

describe('native starter pack is unaffected by the federated guard', () => {
  it('still applies the normal ownership check (403 Not allowed, not the read-only message)', async () => {
    findById.mockResolvedValue({
      _id: 'pack-native',
      ownerOxyUserId: 'some-other-owner', // not the viewer
      name: 'Native pack',
      memberOxyUserIds: [],
      // no `source` → not federated
      save: vi.fn(),
    });

    const res = await request(app).put('/starter-packs/pack-native').send({ name: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not allowed');
  });
});
