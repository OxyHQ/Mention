/**
 * Importing a GIF into the library makes Mention-APPLICATION-owned public files
 * (ADR 0043), not files in the evictable federation cache: Oxy fetches the
 * Klipy URL itself, a Klipy mp4 served as `application/octet-stream` (Oxy's 415)
 * is uploaded declaring `video/mp4`, and nothing but a Klipy host is imported.
 * The row's own insert marks both files as used by the `gif` entity.
 *
 * Real `gifs` rows with ids this file made; Oxy and the source fetch are mocked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';

const h = vi.hoisted(() => ({
  importAppFile: vi.fn(),
  uploadAppFile: vi.fn(),
  fetchUpstream: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/oxyHelpers')>()),
  getServiceOxyClient: () => ({
    assets: { importAppFile: h.importAppFile, uploadAppFile: h.uploadAppFile },
  }),
}));

vi.mock('../../utils/safeUpstreamFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/safeUpstreamFetch')>()),
  fetchUpstreamFollowingRedirects: h.fetchUpstream,
}));

import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { gifs } from '../../db/schema/discovery';
import { oxyFileReferenceSync } from '../../db/schema/oxyFiles';
import { ensureImported } from '../../services/gifLibrary/gifLibraryService';

const klipy = (name: string) => `https://static.klipy.com/ii/${name}.mp4`;

function candidate(overrides: Partial<Parameters<typeof ensureImported>[0]> = {}) {
  const id = `ogi-${randomUUID().slice(0, 8)}`;
  return {
    klipyId: id,
    slug: `slug-${id}`,
    title: 'cat',
    mp4Url: klipy(`${id}-hd`),
    previewUrl: klipy(`${id}-sm`),
    width: 320,
    height: 240,
    ...overrides,
  };
}

function oxyImports() {
  h.importAppFile.mockImplementation(async (url: string) => ({
    file: { id: `app-${url.split('/').pop()}`, visibility: 'public' },
    outcome: 'downloaded',
  }));
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  h.importAppFile.mockReset();
  h.uploadAppFile.mockReset();
  h.fetchUpstream.mockReset();
  oxyImports();
});

afterAll(async () => {
  await closePostgres();
});

describe('importing a GIF', () => {
  it('has Oxy import both files as public application files and records the row as such', async () => {
    const gif = candidate();
    const imported = await ensureImported(gif);
    if (!imported) throw new Error('expected an imported GIF');
    const row = imported;

    expect(h.importAppFile).toHaveBeenCalledWith(gif.mp4Url, { visibility: 'public' });
    expect(h.importAppFile).toHaveBeenCalledWith(gif.previewUrl, { visibility: 'public' });
    expect(row).toMatchObject({
      storage: 'application',
      mp4FileId: `app-${gif.klipyId}-hd.mp4`,
      previewFileId: `app-${gif.klipyId}-sm.mp4`,
    });
    const marks = await getDb()
      .select({
        entityType: oxyFileReferenceSync.entityType,
        entityId: oxyFileReferenceSync.entityId,
      })
      .from(oxyFileReferenceSync)
      .where(inArray(oxyFileReferenceSync.fileId, [row.mp4FileId, row.previewFileId]));
    expect(marks).toEqual([
      { entityType: 'gif', entityId: row.id },
      { entityType: 'gif', entityId: row.id },
    ]);
  });

  it.each(['public', 'private'])(
    'checks %s visibility after fallback upload as well as URL import',
    async (visibility) => {
      const gif = candidate({ previewUrl: '' });
      h.importAppFile.mockRejectedValue(Object.assign(new Error('unsupported'), { status: 415 }));
      h.fetchUpstream.mockImplementation(async () => {
        const stream = new PassThrough();
        const response = Object.assign(stream, {
          statusCode: 200,
          headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
          setTimeout: () => stream,
        });
        response.end(Buffer.from('mp4!'));
        return { response, finalUrl: gif.mp4Url };
      });
      h.uploadAppFile.mockResolvedValue({
        file: { id: 'app-uploaded', visibility },
        deduplicated: false,
      });

      const row = await ensureImported(gif);

      expect(h.uploadAppFile).toHaveBeenCalledWith(expect.any(Uint8Array), 'video/mp4', {
        visibility: 'public',
        originalName: expect.stringContaining('-mp4'),
      });
      expect(Buffer.from(h.uploadAppFile.mock.calls[0][0]).toString()).toBe('mp4!');
      if (visibility === 'public')
        expect(row).toMatchObject({ mp4FileId: 'app-uploaded', previewFileId: 'app-uploaded' });
      else expect(row).toBeNull();
    },
  );

  it.each(['private', 'unlisted', undefined])(
    'never exposes a deduplicated %s application file as a public GIF',
    async (visibility) => {
      const gif = candidate();
      h.importAppFile.mockResolvedValue({
        file: { id: 'protected-membership-file', visibility },
        outcome: 'deduplicated',
      });
      expect(await ensureImported(gif)).toBeNull();
      expect(await getDb().select().from(gifs).where(eq(gifs.klipyId, gif.klipyId))).toEqual([]);
      expect(h.uploadAppFile).not.toHaveBeenCalled();
    },
  );

  it('imports nothing but a Klipy host', async () => {
    const gif = candidate({ mp4Url: 'https://evil.example/x.mp4' });
    expect(await ensureImported(gif)).toBeNull();
    expect(h.importAppFile).not.toHaveBeenCalled();
    const rows = await getDb().select().from(gifs).where(eq(gifs.klipyId, gif.klipyId));
    expect(rows).toEqual([]);
  });

  it('falls back to the full mp4 when the preview cannot be imported', async () => {
    const gif = candidate();
    h.importAppFile.mockImplementation(async (url: string) => {
      if (url === gif.previewUrl) throw Object.assign(new Error('gone'), { status: 502 });
      return { file: { id: 'app-full', visibility: 'public' } };
    });
    const row = await ensureImported(gif);
    expect(row).toMatchObject({ mp4FileId: 'app-full', previewFileId: 'app-full' });
  });

  it('creates no row when Oxy cannot import the full mp4', async () => {
    const gif = candidate();
    h.importAppFile.mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
    expect(await ensureImported(gif)).toBeNull();
    const rows = await getDb().select().from(gifs).where(eq(gifs.klipyId, gif.klipyId));
    expect(rows).toEqual([]);
  });
});
