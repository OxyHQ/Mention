import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mention may only report objects Mention owns.
 *
 * The constraint is tenancy, not capability. `applicationId` is read off the service
 * credential, so a report Mention submits opens a case in MENTION's tenant — and a
 * case about a Syra live room would describe an object Mention cannot snapshot and
 * cannot enforce against, while Syra (which would have to enforce it) never receives
 * the decision. When Syra later reports the same room under its own credential,
 * §7.3's dedup key differs by `applicationId`, so one incident opens two cases with
 * two juries and two consequences — breaking "one decision per incident" at a layer
 * no care inside Mention can repair.
 *
 * So the endpoint refuses. `reportService.reportRoom` in the frontend is the bug, and
 * this test is what stops the enum being quietly widened to "fix" it.
 */

const createReport = vi.fn();

vi.mock('../../services/moderation/ReportIntakeService', async () => {
  const actual = await vi.importActual<
    typeof import('../../services/moderation/ReportIntakeService')
  >('../../services/moderation/ReportIntakeService');
  return { ...actual, createReport: (...args: unknown[]) => createReport(...args) };
});

import reportsRoutes from '../../routes/reports.routes';
import { reportableTypes } from '../../services/moderation/subjects/registry';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'user', { value: { id: 'oxy-user-reporter' }, writable: true });
    next();
  });
  app.use('/reports', reportsRoutes);
  return app;
}

describe('POST /reports — ownership boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a live room, which Syra owns', async () => {
    const response = await request(buildApp())
      .post('/reports')
      .send({
        reportedType: 'room',
        reportedId: 'room_123',
        categories: ['harassment'],
      });

    expect(response.status).toBe(400);
    // The message names what IS reportable, so a client learns the boundary.
    expect(response.body.message).toContain('post');
    expect(response.body.message).not.toContain('room');
    // Nothing was stored. A refusal is not a report.
    expect(createReport).not.toHaveBeenCalled();
  });

  it('refuses a direct message, which Allo owns', async () => {
    const response = await request(buildApp())
      .post('/reports')
      .send({
        reportedType: 'message',
        reportedId: 'msg_123',
        categories: ['harassment'],
      });

    expect(response.status).toBe(400);
    expect(createReport).not.toHaveBeenCalled();
  });

  it('accepts the three types Mention owns', async () => {
    createReport.mockImplementation(async () => ({
      report: {
        _id: 'report_1',
        reportedType: 'post',
        reportedId: 'post_1',
        categories: ['harassment'],
        status: 'pending',
        localStatus: 'queued',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      outboxEventId: 'moderation:report.submit:report_1',
    }));

    for (const reportedType of reportableTypes()) {
      const response = await request(buildApp())
        .post('/reports')
        .send({ reportedType, reportedId: 'object_1', categories: ['harassment'] });

      expect(response.status).toBe(201);
    }
    expect(createReport).toHaveBeenCalledTimes(reportableTypes().length);
  });

  it('reports exactly the three owned types and no more', async () => {
    /**
     * A vacuity floor. If a fourth type is registered, this fails and whoever added it
     * has to state the ownership argument for it rather than widening the surface by
     * accident.
     */
    expect(reportableTypes().sort()).toEqual(['comment', 'post', 'user']);
  });
});
