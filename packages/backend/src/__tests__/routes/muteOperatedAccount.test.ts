import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * You cannot MUTE an account you operate.
 *
 * This route already refused `userId === mutedId`, so the interesting cases are
 * the ones that comparison could never see: a channel, organization, project or
 * bot the caller publishes as is never the caller's own id. The old rule survives
 * as one case of the new one, and there is a test below that would catch it being
 * lost.
 *
 * Same shape as the report guard's file, for the same reason: the assertions go
 * through the route with supertest, and the guard runs for real — only the Oxy
 * reads beneath it are stubbed. Each refusal is paired with a near-miss that must
 * still succeed, so a guard that refused everybody could not pass.
 */

const { resolveUserSummaries, listAccountMembers, muteSave, muteFindOne } = vi.hoisted(() => ({
  resolveUserSummaries: vi.fn(),
  listAccountMembers: vi.fn(),
  muteSave: vi.fn(),
  muteFindOne: vi.fn(),
}));

vi.mock('../../models/Mute', () => {
  class MockMute {
    constructor(public readonly doc: unknown) {}
    save = muteSave;
    static findOne = muteFindOne;
  }
  return { default: MockMute };
});

vi.mock('../../services/PostHydrationService', () => ({ resolveUserSummaries }));

vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: () => ({ listAccountMembers }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import muteRoutes from '../../routes/mute.routes';

const VIEWER = 'oxy-viewer';
const OPERATED_CHANNEL = 'oxy-channel-operated';
const OPERATED_BOT = 'oxy-bot-operated';
const UNOPERATED_ORG = 'oxy-org-billing-only';
const STRANGER = 'oxy-stranger';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'user', { value: { id: VIEWER }, writable: true });
    next();
  });
  app.use('/mute', muteRoutes);
  return app;
}

function mute(mutedId: string) {
  return request(buildApp()).post('/mute').send({ mutedId });
}

function accountsAre(kinds: Record<string, string>): void {
  resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const map = new Map();
    for (const id of ids) {
      if (kinds[id]) map.set(id, { user: { id, kind: kinds[id] } });
    }
    return map;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  muteFindOne.mockResolvedValue(null);
  muteSave.mockResolvedValue(undefined);

  accountsAre({
    [VIEWER]: 'personal',
    [STRANGER]: 'personal',
    [OPERATED_CHANNEL]: 'channel',
    [OPERATED_BOT]: 'bot',
    [UNOPERATED_ORG]: 'organization',
  });

  listAccountMembers.mockImplementation(async (accountId: string) => {
    if (accountId === OPERATED_CHANNEL) {
      return [{ memberUserId: VIEWER, status: 'active', permissions: [] }];
    }
    if (accountId === OPERATED_BOT) {
      return [{ memberUserId: VIEWER, status: 'active', permissions: ['account:act_as'] }];
    }
    if (accountId === UNOPERATED_ORG) {
      return [{ memberUserId: VIEWER, status: 'active', permissions: ['billing:read'] }];
    }
    return [];
  });
});

describe('POST /mute — an account you operate cannot be muted', () => {
  it('refuses muting a CHANNEL the caller operates', async () => {
    const response = await mute(OPERATED_CHANNEL);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('You cannot mute an account you operate');
    // Refused before the write, not cleaned up after it.
    expect(muteSave).not.toHaveBeenCalled();
  });

  it('refuses muting a BOT the caller may act as', async () => {
    const response = await mute(OPERATED_BOT);

    expect(response.status).toBe(400);
    expect(muteSave).not.toHaveBeenCalled();
  });

  it('still refuses muting YOURSELF', async () => {
    // The rule this replaced. It has to keep holding, and it has to keep holding
    // for free — the self case resolves before any Oxy read.
    const response = await mute(VIEWER);

    expect(response.status).toBe(400);
    expect(muteSave).not.toHaveBeenCalled();
    expect(listAccountMembers).not.toHaveBeenCalled();
    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });
});

describe('POST /mute — everybody else can still be muted (the vacuity floor)', () => {
  it('mutes an ordinary person', async () => {
    const response = await mute(STRANGER);

    expect(response.status).toBe(201);
    expect(muteSave).toHaveBeenCalledTimes(1);
    expect(listAccountMembers).not.toHaveBeenCalled();
  });

  it('mutes an organization the caller may not act as', async () => {
    const response = await mute(UNOPERATED_ORG);

    expect(response.status).toBe(201);
    expect(muteSave).toHaveBeenCalledTimes(1);
  });

  it('mutes a managed account when Oxy cannot say who its members are', async () => {
    // Unknown must not cost a reader the ability to quieten an account.
    listAccountMembers.mockRejectedValue(new Error('oxy unreachable'));

    const response = await mute(OPERATED_CHANNEL);

    expect(response.status).toBe(201);
    expect(muteSave).toHaveBeenCalledTimes(1);
  });
});
