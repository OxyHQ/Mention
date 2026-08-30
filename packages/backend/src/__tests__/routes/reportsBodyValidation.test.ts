/**
 * What `POST /reports` accepts, in both directions.
 *
 * `reportedId` is the field this file exists for. The hand-rolled checks tested
 * it for TRUTHINESS and nothing else, so an object or an array reached
 * `viewerOperatesAccount` — an outbound Oxy call made with the caller's own
 * bearer — and then `createReport`, whose `requireIdentifier` threw a
 * `TypeError` that this route's catch turned into a **500**. A malformed id is a
 * 400, and finding that out should not cost an upstream round trip.
 *
 * `details` keeps its ASYMMETRIC rule, which is easy to lose in a rewrite: an
 * over-long STRING is refused, a non-string is IGNORED rather than refused.
 *
 * The report's own `{ message }` refusal envelope and the 401-before-400 order
 * are both preserved — `middleware/validate.ts`'s `validateBody` would change
 * both, which is why this route parses inside the handler.
 */

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createReport = vi.fn();
const listAccountMembers = vi.fn(async () => []);

vi.mock('../../services/moderation/ReportIntakeService', async () => {
  const actual = await vi.importActual<
    typeof import('../../services/moderation/ReportIntakeService')
  >('../../services/moderation/ReportIntakeService');
  return { ...actual, createReport: (...args: unknown[]) => createReport(...args) };
});

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: () => ({ listAccountMembers }),
}));

import reportsRoutes from '../../routes/reports.routes';

function buildApp(authenticated = true): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'user', {
      value: authenticated ? { id: 'oxy-user-reporter' } : undefined,
      writable: true,
    });
    next();
  });
  app.use('/reports', reportsRoutes);
  return app;
}

function storedReport(overrides: Record<string, unknown> = {}) {
  createReport.mockImplementation(async (input: { details?: string }) => ({
    report: {
      _id: 'report_1',
      reportedType: 'post',
      reportedId: 'object_1',
      categories: ['harassment'],
      ...(input.details === undefined ? {} : { details: input.details }),
      status: 'pending',
      localStatus: 'received',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    },
  }));
}

describe('POST /reports body validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAccountMembers.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('still accepts the body every report surface sends', async () => {
    storedReport();

    const response = await request(buildApp())
      .post('/reports')
      .send({
        reportedType: 'post',
        reportedId: 'post_123',
        categories: ['harassment', 'spam'],
        details: 'why',
      });

    expect(response.status).toBe(201);
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportedType: 'post',
        reportedId: 'post_123',
        categories: ['harassment', 'spam'],
        details: 'why',
      }),
    );
  });

  it('refuses a non-string `reportedId` with a 400, without reaching Oxy or intake', async () => {
    storedReport();

    const response = await request(buildApp())
      .post('/reports')
      .send({
        reportedType: 'user',
        // Truthy, so the old `!reportedId` guard let it through: the operator
        // check called Oxy with it, and intake then threw into a 500.
        reportedId: { $ne: null },
        categories: ['harassment'],
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('reportedId');
    expect(createReport).not.toHaveBeenCalled();
    expect(listAccountMembers).not.toHaveBeenCalled();
  });

  it('keeps 401 ahead of 400 for an unauthenticated caller with a malformed body', async () => {
    const response = await request(buildApp(false))
      .post('/reports')
      .send({ reportedId: { $ne: null } });

    expect(response.status).toBe(401);
  });

  it('still ignores a non-string `details` rather than refusing the report', async () => {
    storedReport();

    const response = await request(buildApp())
      .post('/reports')
      .send({
        reportedType: 'post',
        reportedId: 'post_123',
        categories: ['spam'],
        details: 12345,
      });

    expect(response.status).toBe(201);
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({ details: undefined }),
    );
  });

  it('still refuses an over-long `details` string', async () => {
    storedReport();

    const response = await request(buildApp())
      .post('/reports')
      .send({
        reportedType: 'post',
        reportedId: 'post_123',
        categories: ['spam'],
        details: 'x'.repeat(501),
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('details');
    expect(createReport).not.toHaveBeenCalled();
  });

  it('still refuses an unknown reportedType and an empty categories array', async () => {
    storedReport();

    const badType = await request(buildApp())
      .post('/reports')
      .send({ reportedType: 'planet', reportedId: 'x', categories: ['spam'] });
    expect(badType.status).toBe(400);
    expect(badType.body.message).toContain('Invalid reportedType');

    const noCategories = await request(buildApp())
      .post('/reports')
      .send({ reportedType: 'post', reportedId: 'x', categories: [] });
    expect(noCategories.status).toBe(400);
    expect(noCategories.body.message).toContain('categories must be a non-empty array');

    expect(createReport).not.toHaveBeenCalled();
  });
});
