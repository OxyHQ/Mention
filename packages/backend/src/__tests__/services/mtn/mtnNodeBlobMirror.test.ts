import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { MentionPostRecord } from '@mention/shared-types';

/**
 * MTN node-blob mirror tests — `mirrorNodeBlobsForRecord` pulls a record's
 * not-yet-resolvable content-addressed media blobs from the node and uploads them
 * to Oxy S3 via the durable federated-media path. The Oxy reverse lookup, the
 * federated-media upload, and the media-cache enable flag are mocked so the REAL
 * mirror logic (existence pre-check, candidate bounding, node fetch, upload) runs
 * without any network or real upstream. Temp files are written to the OS tmpdir
 * and cleaned up by the helper itself.
 */

// Service-scoped Oxy client: the reverse `sha256 → fileId` existence pre-check.
const oxyMock = vi.hoisted(() => ({
  getServiceAssetMetadataBySha256: vi.fn<
    (sha256s: string[]) => Promise<
      Array<{ sha256: string; id: string; mime: string; size: number; status: 'active' | 'trash'; url?: string }>
    >
  >(),
}));
vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => oxyMock,
}));

// Durable federated-media upload + the write-side enable flag.
const storeMock = vi.hoisted(() => ({
  isMediaCacheEnabled: vi.fn<() => boolean>(),
  uploadFederatedMedia: vi.fn<
    (source: { filePath: string; contentType: string; ownerUserId: string; sizeBytes?: number }) => Promise<{
      oxyFileId: string;
    }>
  >(),
}));
vi.mock('../../../services/mediaCache/oxyMediaStore', () => ({
  isMediaCacheEnabled: storeMock.isMediaCacheEnabled,
  uploadFederatedMedia: storeMock.uploadFederatedMedia,
}));

import { mirrorNodeBlobsForRecord, type NodeBlobFetcher } from '../../../services/mtn/mtnNodeBlobMirror';

const OWNER = '650000000000000000000abc';

/** Build a post record carrying a media embed with the given blob items. */
function makeRecord(
  items: Array<{ sha256: string; mediaType: 'image' | 'video' | 'gif'; mime?: string; size?: number; alt?: string }>,
): MentionPostRecord {
  return {
    text: 'a post with media',
    createdAt: new Date().toISOString(),
    embed: {
      type: 'media',
      items: items.map((b) => ({
        blob: {
          sha256: b.sha256,
          mediaType: b.mediaType,
          ...(b.mime ? { mime: b.mime } : {}),
          ...(typeof b.size === 'number' ? { size: b.size } : {}),
        },
        ...(b.alt ? { alt: b.alt } : {}),
      })),
    },
  };
}

beforeEach(() => {
  oxyMock.getServiceAssetMetadataBySha256.mockReset();
  oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([]); // default: nothing already in S3
  storeMock.isMediaCacheEnabled.mockReset();
  storeMock.isMediaCacheEnabled.mockReturnValue(true); // default: write side enabled
  storeMock.uploadFederatedMedia.mockReset();
  storeMock.uploadFederatedMedia.mockResolvedValue({ oxyFileId: 'file-new' });
});

describe('mirrorNodeBlobsForRecord', () => {
  it('fetches an unresolved blob from the node and uploads it (becomes resolvable)', async () => {
    const bytes = Buffer.from('fake-image-bytes');
    const getBlob = vi.fn<NodeBlobFetcher>().mockResolvedValue(bytes);

    await mirrorNodeBlobsForRecord(
      makeRecord([{ sha256: 'sha-img', mediaType: 'image', mime: 'image/png', size: bytes.length }]),
      OWNER,
      getBlob,
    );

    // The node was asked for the blob bytes by content address.
    expect(getBlob).toHaveBeenCalledTimes(1);
    expect(getBlob).toHaveBeenCalledWith('sha-img');

    // The bytes were uploaded as a durable federated asset owned by the author,
    // with the blob's declared content type.
    expect(storeMock.uploadFederatedMedia).toHaveBeenCalledTimes(1);
    const source = storeMock.uploadFederatedMedia.mock.calls[0][0];
    expect(source.ownerUserId).toBe(OWNER);
    expect(source.contentType).toBe('image/png');
    expect(source.sizeBytes).toBe(bytes.length);
    expect(typeof source.filePath).toBe('string');
  });

  it('is a clean no-op when the federated-media write side is disabled', async () => {
    storeMock.isMediaCacheEnabled.mockReturnValue(false);
    const getBlob = vi.fn<NodeBlobFetcher>();

    await mirrorNodeBlobsForRecord(makeRecord([{ sha256: 'sha-x', mediaType: 'image' }]), OWNER, getBlob);

    // No existence check, no node fetch, no upload.
    expect(oxyMock.getServiceAssetMetadataBySha256).not.toHaveBeenCalled();
    expect(getBlob).not.toHaveBeenCalled();
    expect(storeMock.uploadFederatedMedia).not.toHaveBeenCalled();
  });

  it('skips a blob already resolvable in our S3 (idempotent — no re-fetch/re-upload)', async () => {
    oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([
      { sha256: 'sha-have', id: 'file-have', mime: 'image/png', size: 10, status: 'active' },
    ]);
    const getBlob = vi.fn<NodeBlobFetcher>().mockResolvedValue(Buffer.from('x'));

    await mirrorNodeBlobsForRecord(makeRecord([{ sha256: 'sha-have', mediaType: 'image' }]), OWNER, getBlob);

    expect(getBlob).not.toHaveBeenCalled();
    expect(storeMock.uploadFederatedMedia).not.toHaveBeenCalled();
  });

  it('mirrors only the unresolved blobs in a mixed record', async () => {
    oxyMock.getServiceAssetMetadataBySha256.mockResolvedValue([
      { sha256: 'sha-have', id: 'file-have', mime: 'image/png', size: 10, status: 'active' },
    ]);
    const getBlob = vi.fn<NodeBlobFetcher>().mockResolvedValue(Buffer.from('bytes'));

    await mirrorNodeBlobsForRecord(
      makeRecord([
        { sha256: 'sha-have', mediaType: 'image' },
        { sha256: 'sha-need', mediaType: 'video', mime: 'video/mp4' },
      ]),
      OWNER,
      getBlob,
    );

    expect(getBlob).toHaveBeenCalledTimes(1);
    expect(getBlob).toHaveBeenCalledWith('sha-need');
    expect(storeMock.uploadFederatedMedia).toHaveBeenCalledTimes(1);
    expect(storeMock.uploadFederatedMedia.mock.calls[0][0].contentType).toBe('video/mp4');
  });

  it('does not upload when the node has no bytes for the blob (getBlob → null)', async () => {
    const getBlob = vi.fn<NodeBlobFetcher>().mockResolvedValue(null);

    await mirrorNodeBlobsForRecord(makeRecord([{ sha256: 'sha-gone', mediaType: 'image' }]), OWNER, getBlob);

    expect(getBlob).toHaveBeenCalledWith('sha-gone');
    expect(storeMock.uploadFederatedMedia).not.toHaveBeenCalled();
  });

  it('falls back to a per-kind content type when the blob carries no mime', async () => {
    const getBlob = vi.fn<NodeBlobFetcher>().mockResolvedValue(Buffer.from('gif-bytes'));

    await mirrorNodeBlobsForRecord(makeRecord([{ sha256: 'sha-gif', mediaType: 'gif' }]), OWNER, getBlob);

    expect(storeMock.uploadFederatedMedia).toHaveBeenCalledTimes(1);
    expect(storeMock.uploadFederatedMedia.mock.calls[0][0].contentType).toBe('image/gif');
  });

  it('never uses a disallowed mime (e.g. SVG) as the upload content type', async () => {
    const getBlob = vi.fn<NodeBlobFetcher>().mockResolvedValue(Buffer.from('img'));

    await mirrorNodeBlobsForRecord(
      makeRecord([{ sha256: 'sha-svg', mediaType: 'image', mime: 'image/svg+xml' }]),
      OWNER,
      getBlob,
    );

    // image/svg+xml is rejected by the media-type policy, so the per-kind default
    // (image/jpeg) is used instead — never the dangerous SVG content type.
    expect(storeMock.uploadFederatedMedia).toHaveBeenCalledTimes(1);
    expect(storeMock.uploadFederatedMedia.mock.calls[0][0].contentType).toBe('image/jpeg');
  });

  it('never throws when the upload fails (fail-soft per blob)', async () => {
    const getBlob = vi.fn<NodeBlobFetcher>().mockResolvedValue(Buffer.from('x'));
    storeMock.uploadFederatedMedia.mockRejectedValue(new Error('upload boom'));

    await expect(
      mirrorNodeBlobsForRecord(makeRecord([{ sha256: 'sha-img', mediaType: 'image' }]), OWNER, getBlob),
    ).resolves.toBeUndefined();
  });

  it('never throws when the node fetch fails (fail-soft per blob)', async () => {
    const getBlob = vi.fn<NodeBlobFetcher>().mockRejectedValue(new Error('node down'));

    await expect(
      mirrorNodeBlobsForRecord(makeRecord([{ sha256: 'sha-img', mediaType: 'image' }]), OWNER, getBlob),
    ).resolves.toBeUndefined();
    expect(storeMock.uploadFederatedMedia).not.toHaveBeenCalled();
  });

  it('is a no-op for a record with no embed', async () => {
    const getBlob = vi.fn<NodeBlobFetcher>();
    const record: MentionPostRecord = { text: 'no media', createdAt: new Date().toISOString() };

    await mirrorNodeBlobsForRecord(record, OWNER, getBlob);

    expect(oxyMock.getServiceAssetMetadataBySha256).not.toHaveBeenCalled();
    expect(getBlob).not.toHaveBeenCalled();
    expect(storeMock.uploadFederatedMedia).not.toHaveBeenCalled();
  });
});
