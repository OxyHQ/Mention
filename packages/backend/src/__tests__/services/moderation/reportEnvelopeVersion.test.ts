/**
 * A report keeps the envelope it was first sent with.
 *
 * CrowdSource fingerprints the whole envelope and answers a retry that differs
 * from an earlier attempt with a permanent 409 (§10.5). Media evidence changed
 * the envelope (attachments, `evidenceAttachmentsSupported`, the media-only
 * subject's `evidenceAttached`), so a report first attempted BEFORE it must be
 * retried with the old shape, and a new report gets the new one — decided per
 * report from durable state (`resolveReportEnvelopeVersion`) and stored, never
 * from deploy time.
 *
 * Driven through the real delivery worker against real rows; CrowdSource and
 * Oxy are mocked. Every row is one this file made.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  importAppFile: vi.fn(),
}));

vi.mock('../../../services/moderation/crowdSourceClient', () => ({
  getCrowdSourceClient: vi.fn(() => ({ reports: { create: h.create } })),
  resetCrowdSourceClient: vi.fn(),
}));

vi.mock('../../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/oxyHelpers')>()),
  getServiceOxyClient: () => ({
    assets: {
      importAppFile: h.importAppFile,
      publicUrl: (id: string) => `https://cloud.oxy.so/${id}`,
    },
  }),
}));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ReportInput } from '@crowdsource.you/core';
import { PostType, PostVisibility } from '@mention/shared-types';
import type { ModerationOutboxEvent } from '../../../db/moderation/moderationOutboxRepository';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { deletePostRecord, insertPostRecord } from '../../../db/posts/postRepository';
import { reports } from '../../../db/schema/moderation';
import { deliverReportOutboxEvent } from '../../../services/moderation/ModerationDeliveryWorker';

const AUTHOR = 'oxy-envelope-author';
const fid = (label: string) => `oenv-${label}-${randomUUID().slice(0, 8)}`;

/** A post with media and no body: the subject whose shape changed. */
async function mediaOnlyPost(): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: {
      media: [
        { id: fid('a'), type: 'image' },
        { id: fid('b'), type: 'image' },
      ],
    },
  });
  return record.id;
}

async function report(
  postId: string,
  state: Partial<typeof reports.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(reports)
    .values({
      reportedType: 'post',
      reportedId: postId,
      reporter: `oxy-envelope-reporter-${randomUUID().slice(0, 8)}`,
      categories: ['spam'],
      localStatus: 'queued',
      ...state,
    })
    .returning({ id: reports.id });
  return row.id;
}

function event(reportId: string, attempts: number): ModerationOutboxEvent {
  return {
    _id: `moderation:report.submit:${reportId}`,
    kind: 'report.submit',
    payload: { reportId },
    attempts,
    availableAt: new Date(),
    expiresAt: new Date(),
    createdAt: new Date(),
  } as ModerationOutboxEvent;
}

/** One delivery attempt; returns the input CrowdSource was handed. */
async function attempt(
  reportId: string,
  attempts: number,
  outcome: 'fails' | 'lands',
): Promise<ReportInput> {
  h.create.mockReset();
  if (outcome === 'fails') {
    h.create.mockRejectedValue(Object.assign(new Error('timeout'), { retryable: true }));
    await expect(deliverReportOutboxEvent(event(reportId, attempts))).rejects.toThrow('timeout');
  } else {
    h.create.mockResolvedValue({ reportId: `cs-${reportId}`, caseId: 'case-1', merged: false });
    await deliverReportOutboxEvent(event(reportId, attempts));
  }
  return h.create.mock.calls[0][0] as ReportInput;
}

async function envelopeVersionOf(reportId: string) {
  const [row] = await getDb()
    .select({ version: reports.envelopeVersion })
    .from(reports)
    .where(eq(reports.id, reportId));
  return row.version;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  h.importAppFile.mockReset();
  h.importAppFile.mockImplementation(async (url: string) => {
    const source = url.split('/').pop() as string;
    return { file: { id: `copy-${source}`, sha256: 'a'.repeat(64), size: 10, mime: 'image/png' } };
  });
});

afterAll(async () => {
  await closePostgres();
});

describe('a report first attempted before media evidence', () => {
  it('is retried with the envelope it was first sent with', async () => {
    const postId = await mediaOnlyPost();
    // What a pre-change image left behind after a failed first attempt.
    const id = await report(postId, {
      localStatus: 'delivery_failed',
      lastDeliveryError: 'The request timed out',
    });

    const retry = await attempt(id, 1, 'fails');
    const again = await attempt(id, 2, 'lands');

    // The pre-change envelope, field for field.
    expect(retry.attachments).toBeUndefined();
    expect(retry.content).toEqual({
      type: 'metadata',
      data: { bodyText: 'absent', mediaItems: 2, mediaKinds: 'image', evidenceAttached: false },
    });
    expect(retry.metadata).toMatchObject({ evidenceAttachmentsSupported: false });
    expect(again).toEqual(retry);
    expect(h.importAppFile).not.toHaveBeenCalled();
    expect(await envelopeVersionOf(id)).toBe(1);
    await deletePostRecord(postId);
  });

  it('is recognised by an earlier outbox attempt alone (a lease that expired mid-request)', async () => {
    const postId = await mediaOnlyPost();
    const id = await report(postId);

    const retry = await attempt(id, 2, 'lands');

    expect(retry.attachments).toBeUndefined();
    expect(await envelopeVersionOf(id)).toBe(1);
    await deletePostRecord(postId);
  });
});

describe('a new report', () => {
  it('carries its media as evidence, on every attempt, even after a failure is recorded', async () => {
    const postId = await mediaOnlyPost();
    const id = await report(postId);

    const first = await attempt(id, 1, 'fails');
    // The failure is now on the report — it must not flip the decided shape.
    const second = await attempt(id, 2, 'lands');

    expect(first.attachments).toHaveLength(2);
    expect(first.metadata).toMatchObject({ evidenceAttachmentsSupported: true });
    expect(first.content).toEqual({
      type: 'metadata',
      data: { bodyText: 'absent', mediaItems: 2, mediaKinds: 'image' },
    });
    expect(second).toEqual(first);
    expect(h.importAppFile).toHaveBeenCalledTimes(2);
    expect(await envelopeVersionOf(id)).toBe(2);
    await deletePostRecord(postId);
  });
});
