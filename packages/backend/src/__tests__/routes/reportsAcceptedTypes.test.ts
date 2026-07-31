import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A reported type with no subject provider is STORED, not refused.
 *
 * Two separate questions, and the whole point of this file is that they have separate
 * answers:
 *
 * 1. **May a client report this?** The stored `ReportedType` enum decides, and it is
 *    the API contract every existing report surface was written against.
 * 2. **Does the report leave this application?** `subjects/registry.ts` decides, by
 *    having a provider or not having one.
 *
 * Collapsing them — gating the route on the registry — was tried and reverted. It made
 * `POST /reports` answer 400 for a live-room report the frontend has always sent
 * (`reportService.reportRoom`, reachable from the live-rooms overflow menu), and more
 * importantly it makes adopting CrowdSource a breaking change for every report surface
 * an application has not yet wired up. Incremental adoption, one subject type at a
 * time, is the property the other six Oxy apps need.
 *
 * A live room genuinely has no provider and would not gain one by trying harder:
 * Mention persists no Room document, so §5.6's "pin the exact version reported" has
 * nothing to pin short of capturing audio.
 */

const createReport = vi.fn();

vi.mock('../../services/moderation/ReportIntakeService', async () => {
  const actual = await vi.importActual<
    typeof import('../../services/moderation/ReportIntakeService.js')
  >('../../services/moderation/ReportIntakeService');
  return { ...actual, createReport: (...args: unknown[]) => createReport(...args) };
});

import reportsRoutes from '../../routes/reports.routes';
import { ReportedType } from '../../models/Report.model';
import { deliverableTypes } from '../../services/moderation/subjects/registry';

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

/** What intake returns for a type with no provider: a row, and no delivery event. */
function localOnlyIntake(reportedType: string): void {
  createReport.mockImplementation(async () => ({
    report: {
      _id: 'report_1',
      reportedType,
      reportedId: 'object_1',
      categories: ['harassment'],
      status: 'pending',
      localStatus: 'received',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  }));
}

describe('POST /reports — accepted types vs delivered types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a live-room report and stores it locally', async () => {
    localOnlyIntake('room');

    const response = await request(buildApp())
      .post('/reports')
      .send({
        reportedType: 'room',
        reportedId: 'room_123',
        categories: ['harassment'],
      });

    expect(response.status).toBe(201);
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({ reportedType: 'room', reportedId: 'room_123' }),
    );
    /**
     * `received`, on the receipt. This is the honest signal and it is the reason a 201
     * is not a lie: the reporter's record says the report was stored, and the state says
     * it was not sent for review. A `queued` here would claim a delivery that no outbox
     * row exists to perform.
     */
    expect(response.body.report.localStatus).toBe('received');
  });

  it('accepts a direct-message report, which nothing in the UI produces', async () => {
    localOnlyIntake('message');

    const response = await request(buildApp())
      .post('/reports')
      .send({
        reportedType: 'message',
        reportedId: 'msg_123',
        categories: ['harassment'],
      });

    expect(response.status).toBe(201);
    expect(response.body.report.localStatus).toBe('received');
  });

  it('still refuses a type this application has no concept of', async () => {
    const response = await request(buildApp())
      .post('/reports')
      .send({
        reportedType: 'spacecraft',
        reportedId: 'x_1',
        categories: ['harassment'],
      });

    expect(response.status).toBe(400);
    // The message names what IS acceptable, so a client learns the contract.
    expect(response.body.message).toContain('post');
    expect(response.body.message).toContain('room');
    // Nothing was stored. A refusal is not a report.
    expect(createReport).not.toHaveBeenCalled();
  });

  it('accepts every type the stored enum carries', async () => {
    for (const reportedType of Object.values(ReportedType)) {
      localOnlyIntake(reportedType);
      const response = await request(buildApp())
        .post('/reports')
        .send({ reportedType, reportedId: 'object_1', categories: ['harassment'] });

      expect(response.status).toBe(201);
    }
    expect(createReport).toHaveBeenCalledTimes(Object.values(ReportedType).length);
  });

  it('delivers exactly three of them, and no more', async () => {
    /**
     * A vacuity floor over the seam that actually matters. The difference between a
     * delivered type and a local-only one is invisible in a 201, so registering a
     * provider — or failing to — is a change no response body reveals. If a fourth
     * provider is registered this fails, and whoever added it has to say why that
     * object is Mention's to send for review.
     */
    expect(deliverableTypes().sort()).toEqual(['comment', 'post', 'user']);
    // And the accepted surface is strictly wider, which is the whole design.
    expect(Object.values(ReportedType).length).toBeGreaterThan(deliverableTypes().length);
  });
});
