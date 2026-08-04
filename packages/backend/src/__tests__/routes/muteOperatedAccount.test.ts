import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { like, or } from 'drizzle-orm';

/**
 * You cannot MUTE an account you operate.
 *
 * This route already refused `userId === mutedId`, so the interesting cases are
 * the ones that comparison could never see: a channel, organization, project or
 * bot the caller publishes as is never the caller's own id. The old rule survives
 * as one case of the new one, and there is a test below that would catch it being
 * lost.
 *
 * The assertions go through the route with supertest and the guard runs for real
 * — only the Oxy reads beneath it are stubbed. Each refusal is paired with a
 * near-miss that must still succeed, so a guard that refused everybody could not
 * pass.
 *
 * ## Why the mute itself is a real row
 *
 * This file arrived mocking `models/Mute` and asserting on a captured `save()`.
 * The route writes `mutes` in Postgres, so that mock intercepted nothing: the
 * real insert ran, the mocked model was never constructed, and `save` was never
 * called. The three refusal cases still passed — they refuse BEFORE the write —
 * while all three "everybody else can still be muted" cases 500'd. That is the
 * worst possible failure direction: the vacuity floor, the half whose whole job
 * is to prove the guard is not refusing everyone, is exactly the half that
 * broke.
 *
 * So the write is asserted against the TABLE. "Was a document built with these
 * fields" and "is that what the database now holds" are different questions, and
 * only the second one can see a guard that refuses too much.
 */

const { resolveUserSummaries, listAccountMembers } = vi.hoisted(() => ({
  resolveUserSummaries: vi.fn(),
  listAccountMembers: vi.fn(),
}));

vi.mock('../../services/PostHydrationService', () => ({ resolveUserSummaries }));

// Spread over the real module: `mute.routes` reaches only
// `createUserScopedOxyServices`, but the guard beneath it is free to grow a
// second helper, and an enumerated mock would hand that one back as `undefined`
// — a `TypeError` inside the route's own `try`, i.e. a 500 that reads like a
// broken rule rather than a missing stub.
vi.mock('../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/oxyHelpers')>()),
  createUserScopedOxyServices: () => ({ listAccountMembers }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { mutes } from '../../db/schema/engagement';
import { serviceScope } from '../helpers/serviceFixtures';
import muteRoutes from '../../routes/mute.routes';

// Namespaced ids: one database serves the whole parallel run, so a literal
// `'oxy-viewer'` would collide with any other file that picked the same name.
const scope = serviceScope('mute-operated-account');
const SCOPE_PREFIX = `oxy-${scope.name}-`;
const VIEWER = scope.user('viewer');
const OPERATED_CHANNEL = scope.user('channel-operated');
const OPERATED_BOT = scope.user('bot-operated');
const UNOPERATED_ORG = scope.user('org-billing-only');
const STRANGER = scope.user('stranger');

/** Every account this suite has muted, read back from the table. */
async function storedMutes(): Promise<Array<{ userId: string; mutedId: string }>> {
  return getDb()
    .select({ userId: mutes.userId, mutedId: mutes.mutedId })
    .from(mutes)
    .where(like(mutes.userId, `${SCOPE_PREFIX}%`));
}

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

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  // Both directions: a refusal case leaves nothing, but a case that muted an
  // operated account would leave a row this suite has to reach either way.
  await getDb()
    .delete(mutes)
    .where(or(like(mutes.userId, `${SCOPE_PREFIX}%`), like(mutes.mutedId, `${SCOPE_PREFIX}%`)));
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  vi.clearAllMocks();

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
    // Refused BEFORE the write, not cleaned up after it — so the assertion is
    // that the table never took a row, which is also what makes a guard that
    // 400s after inserting distinguishable from one that 400s instead.
    expect(await storedMutes()).toEqual([]);
  });

  it('refuses muting a BOT the caller may act as', async () => {
    const response = await mute(OPERATED_BOT);

    expect(response.status).toBe(400);
    expect(await storedMutes()).toEqual([]);
  });

  it('still refuses muting YOURSELF', async () => {
    // The rule this replaced. It has to keep holding, and it has to keep holding
    // for free — the self case resolves before any Oxy read.
    const response = await mute(VIEWER);

    expect(response.status).toBe(400);
    expect(await storedMutes()).toEqual([]);
    expect(listAccountMembers).not.toHaveBeenCalled();
    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });
});

describe('POST /mute — everybody else can still be muted (the vacuity floor)', () => {
  it('mutes an ordinary person', async () => {
    const response = await mute(STRANGER);

    expect(response.status).toBe(201);
    expect(await storedMutes()).toEqual([{ userId: VIEWER, mutedId: STRANGER }]);
    // A personal account never costs the membership read.
    expect(listAccountMembers).not.toHaveBeenCalled();
  });

  it('mutes an organization the caller may not act as', async () => {
    const response = await mute(UNOPERATED_ORG);

    expect(response.status).toBe(201);
    expect(await storedMutes()).toEqual([{ userId: VIEWER, mutedId: UNOPERATED_ORG }]);
  });

  it('mutes a managed account when Oxy cannot say who its members are', async () => {
    // Unknown must not cost a reader the ability to quieten an account.
    listAccountMembers.mockRejectedValue(new Error('oxy unreachable'));

    const response = await mute(OPERATED_CHANNEL);

    expect(response.status).toBe(201);
    expect(await storedMutes()).toEqual([{ userId: VIEWER, mutedId: OPERATED_CHANNEL }]);
  });
});
