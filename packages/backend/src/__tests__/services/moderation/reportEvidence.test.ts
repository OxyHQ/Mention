/**
 * A reported post's media reaches CrowdSource as evidence it will accept: a
 * copy the Mention APPLICATION owns, with Oxy's own digest — made once per
 * report, so every delivery attempt composes the same envelope.
 *
 * Real rows (posts, reports, evidence, reference marks); only Oxy is mocked.
 * Every row is one this file made, so the shared database is safe.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ adoptAppFile: vi.fn(), importAppFile: vi.fn() }));

vi.mock('../../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/oxyHelpers')>()),
  getServiceOxyClient: () => ({
    assets: {
      adoptAppFile: h.adoptAppFile,
      // Present ON PURPOSE: the copy shares the stored bytes, so a re-download
      // through an import would be a regression the test must see.
      importAppFile: h.importAppFile,
      publicUrl: (id: string) => `https://cloud.oxy.so/${id}`,
    },
  }),
}));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PostType, PostVisibility, type MediaItem } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { deletePostRecord, insertPostRecord } from '../../../db/posts/postRepository';
import { moderationReportEvidenceFiles, reports } from '../../../db/schema/moderation';
import { oxyFileReferenceSync } from '../../../db/schema/oxyFiles';
import { postMedia } from '../../../db/schema/postContent';
import { buildModerationReportInput } from '../../../services/moderation/EvidenceSnapshotService';

const AUTHOR = 'oxy-evidence-author';
const REPORTER = 'oxy-evidence-reporter';
const fid = (label: string) => `oev-${label}-${randomUUID().slice(0, 8)}`;
const sha = (id: string) => `${Buffer.from(id).toString('hex').padEnd(64, '0').slice(0, 64)}`;

/** Oxy adopts a file as a Mention-owned id derived from the source, same bytes. */
function oxyCopies() {
  h.adoptAppFile.mockImplementation(async (source: string) => ({
    file: {
      id: `copy-${source}`,
      sha256: sha(source),
      size: 1234,
      mime: 'image/webp',
      ext: 'webp',
      ownerApplicationId: 'mention',
      status: 'active',
      visibility: 'unlisted',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    outcome: 'adopted',
    deduplicated: true,
  }));
}

async function reportedPost(media: MediaItem[]) {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.IMAGE,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'look', tag: 'en' }], media },
  });
  const [report] = await getDb()
    .insert(reports)
    .values({
      reportedType: 'post',
      reportedId: record.id,
      reporter: `${REPORTER}-${randomUUID().slice(0, 8)}`,
      categories: ['spam'],
    })
    .returning();
  return { postId: record.id, report };
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  h.adoptAppFile.mockReset();
  h.importAppFile.mockReset();
  oxyCopies();
});

afterAll(async () => {
  await closePostgres();
});

describe('media evidence', () => {
  it('sends application-owned unlisted copies with Oxy’s digest, and declares the rest', async () => {
    const a = fid('a');
    const b = fid('b');
    const { postId, report } = await reportedPost([
      { id: a, type: 'image', width: 800, height: 600 },
      { id: b, type: 'video', durationSec: 12 },
      { id: 'https://remote.example/c.jpg', type: 'image' },
    ]);

    const input = await buildModerationReportInput(report);

    // Adopted by file id (ADR 0041 stage 4b): no URL, no re-download.
    expect(h.adoptAppFile).toHaveBeenCalledTimes(2);
    expect(h.adoptAppFile).toHaveBeenCalledWith(a, { visibility: 'unlisted' });
    expect(h.importAppFile).not.toHaveBeenCalled();
    expect(input?.reportInput.attachments).toEqual([
      {
        type: 'image',
        asset: {
          fileId: `copy-${a}`,
          mimeType: 'image/webp',
          sha256: sha(a),
          sizeBytes: 1234,
          width: 800,
          height: 600,
        },
      },
      {
        type: 'video',
        asset: {
          fileId: `copy-${b}`,
          mimeType: 'image/webp',
          sha256: sha(b),
          sizeBytes: 1234,
          durationSeconds: 12,
        },
      },
    ]);
    expect(input?.reportInput.metadata).toMatchObject({ evidenceAttachmentsSupported: true });

    const rows = await getDb()
      .select()
      .from(moderationReportEvidenceFiles)
      .where(eq(moderationReportEvidenceFiles.reportId, report.id));
    expect(rows.find((row) => row.position === 2)).toMatchObject({
      evidenceFileId: null,
      unavailableReason: 'not_rehosted',
      sourceUrl: 'https://remote.example/c.jpg',
    });

    // Each copy is in use by the report, for Oxy (`moderation_report`).
    const marks = await getDb()
      .select({
        entityType: oxyFileReferenceSync.entityType,
        entityId: oxyFileReferenceSync.entityId,
      })
      .from(oxyFileReferenceSync)
      .where(eq(oxyFileReferenceSync.fileId, `copy-${a}`));
    expect(marks).toEqual([{ entityType: 'moderation_report', entityId: report.id }]);
    await deletePostRecord(postId);
  });

  it('composes the SAME envelope on every attempt, without copying again', async () => {
    const a = fid('again');
    const { postId, report } = await reportedPost([{ id: a, type: 'image' }]);

    const first = await buildModerationReportInput(report);
    h.adoptAppFile.mockRejectedValue(new Error('must not be called'));
    const second = await buildModerationReportInput(report);

    expect(second).toEqual(first);
    expect(h.adoptAppFile).toHaveBeenCalledTimes(1);
    await deletePostRecord(postId);
  });

  it('puts the evidence digest in the snapshot hash', async () => {
    const a = fid('hash');
    const one = await reportedPost([{ id: a, type: 'image' }]);
    const two = await reportedPost([{ id: a, type: 'image' }]);
    const first = await buildModerationReportInput(one.report);
    h.adoptAppFile.mockImplementation(async () => ({
      file: { id: 'copy-other', sha256: 'f'.repeat(64), size: 1, mime: 'image/png' },
      outcome: 'adopted',
      deduplicated: true,
    }));
    const second = await buildModerationReportInput(two.report);
    expect(first?.snapshotHash).not.toBe(second?.snapshotHash);
    await deletePostRecord(one.postId);
    await deletePostRecord(two.postId);
  });

  it('declares a file Oxy refuses to adopt, and retries an Oxy outage', async () => {
    const gone = fid('gone');
    const down = fid('down');
    const refused = await reportedPost([{ id: gone, type: 'image' }]);
    h.adoptAppFile.mockRejectedValue(
      Object.assign(new Error('missing'), { status: 404, code: 'FILE_NOT_FOUND' }),
    );
    const input = await buildModerationReportInput(refused.report);
    expect(input?.reportInput.attachments).toBeUndefined();
    const [row] = await getDb()
      .select()
      .from(moderationReportEvidenceFiles)
      .where(eq(moderationReportEvidenceFiles.reportId, refused.report.id));
    expect(row).toMatchObject({ evidenceFileId: null, unavailableReason: 'FILE_NOT_FOUND' });

    // A private source cannot become an `unlisted` copy: Oxy refuses the
    // widening, and the item stays declared.
    const hidden = fid('private');
    const narrow = await reportedPost([{ id: hidden, type: 'image' }]);
    h.adoptAppFile.mockRejectedValue(
      Object.assign(new Error('wider'), { status: 400, code: 'VISIBILITY_WIDER_THAN_SOURCE' }),
    );
    await buildModerationReportInput(narrow.report);
    const [narrowRow] = await getDb()
      .select()
      .from(moderationReportEvidenceFiles)
      .where(eq(moderationReportEvidenceFiles.reportId, narrow.report.id));
    expect(narrowRow).toMatchObject({
      evidenceFileId: null,
      unavailableReason: 'VISIBILITY_WIDER_THAN_SOURCE',
    });

    const outage = await reportedPost([{ id: down, type: 'image' }]);
    h.adoptAppFile.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }));
    await expect(buildModerationReportInput(outage.report)).rejects.toThrow('unavailable');
    const stored = await getDb()
      .select()
      .from(moderationReportEvidenceFiles)
      .where(eq(moderationReportEvidenceFiles.reportId, outage.report.id));
    expect(stored).toEqual([]);
    oxyCopies();
    const recovered = await buildModerationReportInput(outage.report);
    expect(recovered?.reportInput.attachments).toHaveLength(1);
    await deletePostRecord(refused.postId);
    await deletePostRecord(narrow.postId);
    await deletePostRecord(outage.postId);
  });

  it('never copies a withheld item', async () => {
    const a = fid('withheld');
    const { postId, report } = await reportedPost([{ id: a, type: 'image' }]);
    // Oxy took the file down after the post was written.
    await getDb()
      .update(postMedia)
      .set({ withheld: 'blocked' })
      .where(eq(postMedia.postId, postId));
    const input = await buildModerationReportInput(report);
    expect(h.adoptAppFile).not.toHaveBeenCalled();
    expect(input?.reportInput.attachments).toBeUndefined();
    await deletePostRecord(postId);
  });
});
