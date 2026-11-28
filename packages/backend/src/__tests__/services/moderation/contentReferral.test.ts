import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Referring content to Oxy's claim review (oxy ADR 0043 D14).
 *
 * What is under test is what Mention SENDS and what it does with Oxy's answer:
 * the subject's own media and its page, never anything about the reporter; a
 * media item Oxy does not hold is dropped and the rest is sent again; content
 * that is gone, or that Mention cannot describe, is not referred at all.
 */

const referContent = vi.fn();
vi.mock('../../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ referContent }),
}));
vi.mock('../../../services/moderation/subjects/registry', () => ({
  subjectProviderFor: vi.fn(),
}));
vi.mock('../../../db/moderation/reportRepository', () => ({
  findReportById: vi.fn(),
}));
vi.mock('../../../config', () => ({
  config: { frontendUrl: 'https://mention.earth/' },
}));

import { findReportById } from '../../../db/moderation/reportRepository';
import {
  referReportOutboxEvent,
  referSubjectForChildSafety,
} from '../../../services/moderation/ContentReferralWorker';
import { ModerationDeliveryRejectedError } from '../../../services/moderation/ModerationDeliveryWorker';
import { subjectProviderFor } from '../../../services/moderation/subjects/registry';
import type { ModerationOutboxEvent } from '../../../db/moderation/moderationOutboxRepository';

const snapshot = vi.fn();

function withProvider(media: { id: string }[] | undefined): void {
  snapshot.mockResolvedValue({
    subject: {},
    content: 'a post',
    ...(media ? { evidenceMedia: media.map((item) => ({ ...item, type: 'image' })) } : {}),
  });
  vi.mocked(subjectProviderFor).mockReturnValue({
    reportedType: 'post',
    subjectType: 'social.post',
    snapshot,
  });
}

function unknownFiles(fileIds: string[]): Error {
  return Object.assign(new Error('A referral names files Oxy does not hold'), {
    response: { data: { code: 'CONTENT_REFERRAL_UNKNOWN_FILES', details: { fileIds } } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  referContent.mockResolvedValue({ id: 'claim_1', reference: 'OXY-7K3M-9Q2D' });
});

describe('referSubjectForChildSafety', () => {
  it('sends the subject’s media and its page, and nothing about who reported it', async () => {
    withProvider([{ id: 'file_a' }, { id: 'file_b' }]);

    const outcome = await referSubjectForChildSafety({ type: 'post', id: 'post 1' }, 'reporter_9');

    expect(outcome).toEqual({ referred: true, reference: 'OXY-7K3M-9Q2D' });
    expect(referContent).toHaveBeenCalledTimes(1);
    expect(referContent).toHaveBeenCalledWith({
      reason: 'child_safety',
      fileIds: ['file_a', 'file_b'],
      pageUrls: ['https://mention.earth/p/post%201'],
    });
    expect(JSON.stringify(referContent.mock.calls)).not.toContain('reporter_9');
    // The reporter is only who the snapshot is read FOR.
    expect(snapshot).toHaveBeenCalledWith('post 1', 'reporter_9');
  });

  it('refers a post with no media by its page alone', async () => {
    withProvider(undefined);
    await referSubjectForChildSafety({ type: 'post', id: 'p2' });
    expect(referContent).toHaveBeenCalledWith({
      reason: 'child_safety',
      fileIds: [],
      pageUrls: ['https://mention.earth/p/p2'],
    });
  });

  it('drops the media Oxy does not hold and sends the rest again', async () => {
    withProvider([{ id: 'file_a' }, { id: 'remote_b' }]);
    referContent.mockRejectedValueOnce(unknownFiles(['remote_b']));

    const outcome = await referSubjectForChildSafety({ type: 'post', id: 'p3' });

    expect(outcome).toEqual({ referred: true, reference: 'OXY-7K3M-9Q2D' });
    expect(referContent).toHaveBeenCalledTimes(2);
    expect(referContent.mock.calls[1][0]).toEqual({
      reason: 'child_safety',
      fileIds: ['file_a'],
      pageUrls: ['https://mention.earth/p/p3'],
    });
  });

  it('lets any other failure through, so the caller retries', async () => {
    withProvider([{ id: 'file_a' }]);
    referContent.mockRejectedValueOnce(new Error('Oxy is unavailable'));
    await expect(referSubjectForChildSafety({ type: 'post', id: 'p4' })).rejects.toThrow(
      'Oxy is unavailable',
    );
    expect(referContent).toHaveBeenCalledTimes(1);
  });

  it('does not refer content that is gone', async () => {
    withProvider([{ id: 'file_a' }]);
    snapshot.mockResolvedValue(null);
    expect(await referSubjectForChildSafety({ type: 'post', id: 'gone' })).toEqual({
      referred: false,
      reason: 'The reported content no longer exists',
    });
    expect(referContent).not.toHaveBeenCalled();
  });

  it('does not refer a noun Mention cannot describe', async () => {
    vi.mocked(subjectProviderFor).mockReturnValue(undefined);
    const outcome = await referSubjectForChildSafety({ type: 'room', id: 'r1' });
    expect(outcome.referred).toBe(false);
    expect(referContent).not.toHaveBeenCalled();
  });

  it('does not refer a subject with no file and no public page', async () => {
    withProvider(undefined);
    vi.mocked(subjectProviderFor).mockReturnValue({
      reportedType: 'user',
      subjectType: 'identity.account',
      snapshot,
    });
    const outcome = await referSubjectForChildSafety({ type: 'user', id: 'u1' });
    expect(outcome).toEqual({
      referred: false,
      reason: 'The reported content has no file and no public page',
    });
    expect(referContent).not.toHaveBeenCalled();
  });
});

describe('referReportOutboxEvent', () => {
  const event = (payload: Record<string, unknown>) =>
    ({ kind: 'report.refer', payload, attempts: 1 }) as unknown as ModerationOutboxEvent;

  it('refers the report’s subject', async () => {
    withProvider([{ id: 'file_a' }]);
    vi.mocked(findReportById).mockResolvedValue({
      id: 'report_1',
      reportedType: 'post',
      reportedId: 'p9',
      reporter: 'reporter_9',
    } as never);

    await referReportOutboxEvent(event({ reportId: 'report_1' }));

    expect(referContent).toHaveBeenCalledWith({
      reason: 'child_safety',
      fileIds: ['file_a'],
      pageUrls: ['https://mention.earth/p/p9'],
    });
  });

  it('is done, without a referral, when the report no longer exists', async () => {
    vi.mocked(findReportById).mockResolvedValue(null as never);
    await expect(referReportOutboxEvent(event({ reportId: 'gone' }))).resolves.toBeUndefined();
    expect(referContent).not.toHaveBeenCalled();
  });

  it('refuses an event that names no report, which no retry can fix', async () => {
    await expect(referReportOutboxEvent(event({}))).rejects.toBeInstanceOf(
      ModerationDeliveryRejectedError,
    );
  });
});
