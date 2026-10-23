import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The Telegram channel import, against real rows.
 *
 * What a reviewer has to believe before it runs against production:
 *
 *  1. **It reads only the private staging prefix** — a manifest naming any other
 *     URL is rejected before anything is fetched.
 *  2. **A dry run uploads and writes nothing.**
 *  3. **Every item goes through the ingest path** — its media uploaded as the
 *     TARGET account's own assets first, then `ingestBatch` with platform
 *     `telegram` and the original date.
 *  4. **It is idempotent before the upload** — an item already in the ledger is
 *     neither re-uploaded nor re-sent. The ledger row the test seeds carries
 *     platform `telegram`, so it also proves the widened CHECK.
 */

import { closePostgres, connectPostgres } from '../../db/postgres';
import { insertPostImport } from '../../db/imports/postImportRepository';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import {
  STAGING_HOST,
  importTelegramChannelExport,
  isStagedUrl,
  parseManifest,
  type TelegramImportDeps,
} from '../../scripts/importTelegramChannelExport';

const scope = serviceScope('import-telegram-channel-export');

const staged = (path: string) =>
  `https://${STAGING_HOST}/telegram-import/run/${path}?X-Amz-Signature=x`;

function manifest(items: unknown[]) {
  return parseManifest({ channel: { name: 'Notas de Nate', telegramId: 1 }, items });
}

function item(id: string, overrides: Record<string, unknown> = {}) {
  return {
    sourceId: `1/${id}`,
    sourceUrl: `https://t.me/c/1/${id}`,
    sourceAccountId: '1',
    sourceItemId: id,
    createdAt: '2024-05-20T13:18:52Z',
    text: `post ${id}`,
    media: [],
    ...overrides,
  };
}

function fakeDeps() {
  return {
    fetchStaged: vi.fn(async () => Buffer.from('bytes')),
    uploadMedia: vi.fn(async () => ({ fileId: 'asset-1', contentType: 'image/jpeg' })),
    ingestBatch: vi.fn(async (params: { items: Array<{ sourceId: string }> }) =>
      params.items.map((entry) => ({
        sourceId: entry.sourceId,
        status: 'created' as const,
        postId: 'p',
      })),
    ),
  } satisfies Record<keyof TelegramImportDeps, unknown>;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('the manifest', () => {
  it('accepts only presigned URLs under the staging prefix', () => {
    expect(isStagedUrl(staged('photos/a.jpg'))).toBe(true);
    expect(
      isStagedUrl(
        'https://mention-import-staging.fa4392797e57d4e63ceaaf7b1dc687ed.r2.cloudflarestorage.com/telegram-import/run/manifest.json?X-Amz-Signature=x',
      ),
    ).toBe(true);
    expect(isStagedUrl('https://example.com/telegram-import/a.jpg')).toBe(false);
    expect(isStagedUrl(`https://${STAGING_HOST}/link-previews/a.jpg`)).toBe(false);
    expect(isStagedUrl(`https://${STAGING_HOST}/staging/telegram-import/a.jpg`)).toBe(false);
    expect(isStagedUrl(`http://${STAGING_HOST}/telegram-import/a.jpg`)).toBe(false);
    // The retired S3 staging location, a dead bucket.
    expect(
      isStagedUrl(
        'https://oxy-mention-media-usw2-237343248947.s3.us-west-2.amazonaws.com/staging/telegram-import/run/a.jpg',
      ),
    ).toBe(false);
    // Path-style: the account endpoint names every bucket, so only the
    // virtual-hosted form, whose host pins this one, is accepted.
    expect(
      isStagedUrl(
        'https://fa4392797e57d4e63ceaaf7b1dc687ed.r2.cloudflarestorage.com/mention-import-staging/telegram-import/run/a.jpg',
      ),
    ).toBe(false);
    // Another bucket in the same account, and a jurisdiction endpoint.
    expect(
      isStagedUrl(
        'https://oxy-files.fa4392797e57d4e63ceaaf7b1dc687ed.r2.cloudflarestorage.com/telegram-import/a.jpg',
      ),
    ).toBe(false);
    expect(
      isStagedUrl(
        'https://mention-import-staging.fa4392797e57d4e63ceaaf7b1dc687ed.eu.r2.cloudflarestorage.com/telegram-import/a.jpg',
      ),
    ).toBe(false);
    expect(() =>
      manifest([
        item('1', {
          media: [{ url: 'https://evil.test/x.jpg', mimeType: 'image/jpeg', fileName: 'x.jpg' }],
        }),
      ]),
    ).toThrow();
  });

  it('rejects a duplicate and an empty item', () => {
    expect(() => manifest([item('1'), item('1')])).toThrow(/duplicate/);
    expect(() => manifest([item('3', { sourceId: '3' })])).toThrow();
    expect(() => manifest([item('6', { sourceItemId: '7' })])).toThrow(/link or ids/);
    expect(() => manifest([item('4', { sourceUrl: 'https://t.me/c/1/5' })])).toThrow(
      /another message/,
    );
    expect(() => manifest([item('2', { text: ' ' })])).toThrow(/neither text nor media/);
  });
});

describe('importTelegramChannelExport', () => {
  it('uploads and writes nothing on a dry run', async () => {
    const deps = fakeDeps();
    const result = await importTelegramChannelExport(
      manifest([item('1')]),
      { targetOxyUserId: scope.user('channel-dry'), batchId: 'b', dryRun: true },
      deps as unknown as TelegramImportDeps,
    );
    expect(result).toMatchObject({ items: 1, alreadyImported: 0, created: 0 });
    expect(deps.fetchStaged).not.toHaveBeenCalled();
    expect(deps.ingestBatch).not.toHaveBeenCalled();
  });

  it('uploads media as the target account, then ingests as telegram with the original date', async () => {
    const deps = fakeDeps();
    const target = scope.user('channel-live');
    const photo = staged('photos/a.jpg');
    const result = await importTelegramChannelExport(
      manifest([
        item('20', {
          createdAt: '2025-03-07T10:36:19Z',
          media: [{ url: photo, mimeType: 'image/jpeg', fileName: 'a.jpg' }],
        }),
        item('10'),
      ]),
      { targetOxyUserId: target, batchId: 'batch-1', dryRun: false },
      deps as unknown as TelegramImportDeps,
    );

    expect(result).toMatchObject({ items: 2, created: 2, failed: 0 });
    expect(deps.fetchStaged).toHaveBeenCalledWith(photo, expect.any(Number));
    expect(deps.uploadMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: target,
        contentType: 'image/jpeg',
        fileName: 'a.jpg',
      }),
    );
    const [call] = deps.ingestBatch.mock.calls[0] as unknown as [
      {
        oxyUserId: string;
        platform: string;
        batchId: string;
        items: Array<Record<string, unknown>>;
      },
    ];
    expect(call).toMatchObject({ oxyUserId: target, platform: 'telegram', batchId: 'batch-1' });
    // Oldest first.
    expect(call.items.map((entry) => entry.sourceId)).toEqual(['1/10', '1/20']);
    expect(call.items[1]).toMatchObject({
      sourceId: '1/20',
      sourceUrl: 'https://t.me/c/1/20',
      sourceAccountId: '1',
      sourceItemId: '20',
      createdAt: new Date('2025-03-07T10:36:19Z'),
      media: [{ assetId: 'asset-1' }],
      language: 'es',
    });
  });

  it('skips an item already in the ledger before uploading its media', async () => {
    const deps = fakeDeps();
    const target = scope.user('channel-held');
    const post = await seedPost(scope, { oxyUserId: target });
    await insertPostImport({
      postId: post.id,
      oxyUserId: target,
      platform: 'telegram',
      sourceId: '1/30',
      sourceUrl: 'https://t.me/c/1/30',
      sourceAccountId: '1',
      sourceItemId: '30',
      contentWarning: null,
      importBatchId: 'earlier',
    });

    const result = await importTelegramChannelExport(
      manifest([
        item('30', {
          media: [{ url: staged('photos/b.jpg'), mimeType: 'image/jpeg', fileName: 'b.jpg' }],
        }),
        item('31'),
      ]),
      { targetOxyUserId: target, batchId: 'batch-2', dryRun: false },
      deps as unknown as TelegramImportDeps,
    );

    expect(result).toMatchObject({ items: 2, alreadyImported: 1, created: 1 });
    expect(deps.fetchStaged).not.toHaveBeenCalled();
    const [call] = deps.ingestBatch.mock.calls[0] as unknown as [
      { items: Array<{ sourceId: string }> },
    ];
    expect(call.items.map((entry) => entry.sourceId)).toEqual(['1/31']);
  });

  it('reports an item whose media could not be staged, and imports the rest', async () => {
    const deps = fakeDeps();
    deps.fetchStaged.mockRejectedValueOnce(new Error('staged object answered 403'));
    const result = await importTelegramChannelExport(
      manifest([
        item('40', {
          media: [{ url: staged('photos/c.jpg'), mimeType: 'image/jpeg', fileName: 'c.jpg' }],
        }),
        item('41', { createdAt: '2024-06-01T00:00:00Z' }),
      ]),
      { targetOxyUserId: scope.user('channel-fail'), batchId: 'b', dryRun: false },
      deps as unknown as TelegramImportDeps,
    );
    expect(result).toMatchObject({ created: 1, failed: 1, failedItems: ['1/40'] });
  });
});
