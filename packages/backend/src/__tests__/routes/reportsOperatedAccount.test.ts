import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * You cannot REPORT an account you operate, and the proof has to be the route
 * refusing — not the menu declining to draw a button.
 *
 * Every assertion here goes through `POST /reports` with supertest, because the
 * property under test is "this is not possible", and a client that never opened
 * Mention can send this request. A UI test can only ever show that one client
 * does not offer it.
 *
 * The guard itself runs FOR REAL. What is stubbed is strictly below it: the
 * identity read that says what kind each account is, and the account-graph read
 * that says who its members are — the two things a unit test has no Oxy to ask.
 * `viewerOperatesAccount` and `assertCanPublishAsAccount` both execute.
 *
 * ## Every case here is paired, so "refuses operators" cannot pass as "refuses
 * ## everyone"
 *
 * A file where the reporter always operates the target proves nothing: a guard
 * that refused unconditionally would be just as green. So each refusal has a
 * near-miss beside it that must still be ACCEPTED — a stranger, and an
 * organization member who is a member but may not act as it.
 */

// `vi.hoisted`, because `vi.mock` is lifted above every `const` in the file and a
// plain declaration is still in its temporal dead zone when the factory runs.
const { createReport, resolveUserSummaries, listAccountMembers } = vi.hoisted(() => ({
  createReport: vi.fn(),
  resolveUserSummaries: vi.fn(),
  listAccountMembers: vi.fn(),
}));

vi.mock('../../services/moderation/ReportIntakeService', async () => {
  const actual = await vi.importActual<
    typeof import('../../services/moderation/ReportIntakeService')
  >('../../services/moderation/ReportIntakeService');
  return { ...actual, createReport: (...args: unknown[]) => createReport(...args) };
});

vi.mock('../../services/PostHydrationService', () => ({ resolveUserSummaries }));

vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: () => ({ listAccountMembers }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import reportsRoutes from '../../routes/reports.routes';

const REPORTER = 'oxy-reporter';
/** A channel the reporter is an active member of. Membership is the whole right. */
const OPERATED_CHANNEL = 'oxy-channel-operated';
/** An organization the reporter may act as. */
const OPERATED_ORG = 'oxy-org-operated';
/** An organization the reporter belongs to but may NOT act as (e.g. billing). */
const UNOPERATED_ORG = 'oxy-org-billing-only';
/** A channel somebody else runs. */
const STRANGER_CHANNEL = 'oxy-channel-stranger';
/** An ordinary person. The overwhelming majority of reports. */
const STRANGER = 'oxy-stranger';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'user', { value: { id: REPORTER }, writable: true });
    next();
  });
  app.use('/reports', reportsRoutes);
  return app;
}

function reportUser(reportedId: string) {
  return request(buildApp())
    .post('/reports')
    .send({ reportedType: 'user', reportedId, categories: ['harassment'] });
}

/** Teaches the identity read what kind each account is. */
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
  createReport.mockResolvedValue({
    report: {
      _id: 'report_1',
      reportedType: 'user',
      reportedId: 'whoever',
      categories: ['harassment'],
      status: 'pending',
      localStatus: 'queued',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    outboxEventId: 'event_1',
  });

  accountsAre({
    [REPORTER]: 'personal',
    [STRANGER]: 'personal',
    [OPERATED_CHANNEL]: 'channel',
    [STRANGER_CHANNEL]: 'channel',
    [OPERATED_ORG]: 'organization',
    [UNOPERATED_ORG]: 'organization',
  });

  listAccountMembers.mockImplementation(async (accountId: string) => {
    if (accountId === OPERATED_CHANNEL) {
      return [{ memberUserId: REPORTER, status: 'active', permissions: [] }];
    }
    if (accountId === OPERATED_ORG) {
      return [{ memberUserId: REPORTER, status: 'active', permissions: ['account:act_as'] }];
    }
    if (accountId === UNOPERATED_ORG) {
      // A real member — `members:read` succeeded — who deliberately may not speak
      // as the account. Membership alone must not read as operating it.
      return [{ memberUserId: REPORTER, status: 'active', permissions: ['billing:read'] }];
    }
    return [{ memberUserId: 'somebody-else', status: 'active', permissions: ['account:act_as'] }];
  });
});

describe('POST /reports — an account you operate cannot be reported', () => {
  it('refuses a report against a CHANNEL the reporter operates', async () => {
    const response = await reportUser(OPERATED_CHANNEL);

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('You cannot report an account you operate');
    // Refused BEFORE intake: no row, no CrowdSource delivery event, no jury.
    expect(createReport).not.toHaveBeenCalled();
  });

  it('refuses a report against an ORGANIZATION the reporter may act as', async () => {
    // The reason this is not a channel special case: the same wrongness applies
    // to every managed kind, and an organization renders on the PERSON screen.
    const response = await reportUser(OPERATED_ORG);

    expect(response.status).toBe(400);
    expect(createReport).not.toHaveBeenCalled();
  });

  it('refuses a report the reporter files against THEMSELVES', async () => {
    // Not a separate rule — "is it me" is one case of "do I operate it", and it
    // resolves before anything is looked up. Worth pinning because this route had
    // no self-check of any kind: reporting yourself used to open a real case.
    const response = await reportUser(REPORTER);

    expect(response.status).toBe(400);
    expect(createReport).not.toHaveBeenCalled();
    expect(listAccountMembers).not.toHaveBeenCalled();
    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });
});

describe('POST /reports — everybody else can still report (the vacuity floor)', () => {
  it('accepts a report against an ordinary person', async () => {
    const response = await reportUser(STRANGER);

    expect(response.status).toBe(201);
    expect(createReport).toHaveBeenCalledTimes(1);
    // The cost claim: a personal target is settled off the cached identity read,
    // without touching the account graph.
    expect(listAccountMembers).not.toHaveBeenCalled();
  });

  it('accepts a report against a channel somebody ELSE operates', async () => {
    const response = await reportUser(STRANGER_CHANNEL);

    expect(response.status).toBe(201);
    expect(createReport).toHaveBeenCalledTimes(1);
  });

  it('accepts a report against an organization the reporter may not act as', async () => {
    // The distinction the two-family rule exists for. A `billing` member is a
    // member; they do not speak as the account, so reporting it is a real report
    // by somebody who is not its voice.
    const response = await reportUser(UNOPERATED_ORG);

    expect(response.status).toBe(201);
    expect(createReport).toHaveBeenCalledTimes(1);
  });
});

describe('POST /reports — an unknown answer must not cost anybody a report', () => {
  it('accepts the report when Oxy cannot say who the members are', async () => {
    // The direction that matters. Refusing here would mean that for the duration
    // of an Oxy outage nobody can report a managed account at all — removing the
    // tool at the moment somebody reaches for it. Wrongly allowing costs an
    // operator a pointless report against their own channel.
    listAccountMembers.mockRejectedValue(new Error('oxy unreachable'));

    const response = await reportUser(OPERATED_CHANNEL);

    expect(response.status).toBe(201);
    expect(createReport).toHaveBeenCalledTimes(1);
  });

  it('accepts the report when the target account resolves to no kind at all', async () => {
    accountsAre({});

    const response = await reportUser(OPERATED_CHANNEL);

    expect(response.status).toBe(201);
    expect(createReport).toHaveBeenCalledTimes(1);
  });
});

describe('POST /reports — the guard is scoped to accounts', () => {
  it('does not ask the account graph about a POST report', async () => {
    // `reportedId` is a post id here; asking whether the reporter "operates" it
    // would resolve a kind for an id that names no account.
    const response = await request(buildApp())
      .post('/reports')
      .send({ reportedType: 'post', reportedId: OPERATED_CHANNEL, categories: ['spam'] });

    expect(response.status).toBe(201);
    expect(resolveUserSummaries).not.toHaveBeenCalled();
    expect(listAccountMembers).not.toHaveBeenCalled();
  });
});
