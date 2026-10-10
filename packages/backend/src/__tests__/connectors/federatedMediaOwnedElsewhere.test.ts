import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ActivityPub / atproto media whose bytes Oxy holds for ANOTHER owner or app
 * (409 `FEDERATED_MEDIA_OWNED_ELSEWHERE`): the source URL is stable, so the
 * item keeps it and is served through the media proxy — neither dropped (as a
 * 404 would be) nor re-queued for a durable upload that would be refused again.
 */

const h = vi.hoisted(() => ({ persist: vi.fn(), recordAccess: vi.fn() }));

vi.mock('../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: h.persist,
}));
vi.mock('../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: h.recordAccess,
}));
vi.mock('../../services/MediaMetadataService', () => ({
  mediaMetadataService: { enrichFromOxy: vi.fn(async (items: unknown) => items) },
}));

import { materializeFederatedMedia } from '../../connectors/shared/federatedMedia';

const URL_A = 'https://files.mastodon.example/a.jpg';
const URL_B = 'https://files.mastodon.example/b.jpg';

beforeEach(() => {
  h.persist.mockReset();
  h.recordAccess.mockReset();
});

describe('materializeFederatedMedia and 409 owned elsewhere', () => {
  it('keeps the stable remote URL, and does not re-queue it', async () => {
    h.persist.mockResolvedValue({ ok: false, reason: 'owned-elsewhere', permanent: true });
    const result = await materializeFederatedMedia(
      [{ id: URL_A, type: 'image' }],
      [{ type: 'media', id: URL_A, mediaType: 'image' }],
      'oxy-owner',
    );
    expect(result.media).toEqual([{ id: URL_A, type: 'image' }]);
    expect(result.attachments).toEqual([{ type: 'media', id: URL_A, mediaType: 'image' }]);
    expect(h.recordAccess).not.toHaveBeenCalled();
  });

  it('still drops media that is genuinely gone (the existing 404 rule)', async () => {
    h.persist.mockImplementation(async (url: string) =>
      url === URL_A
        ? { ok: false, reason: 'owned-elsewhere', permanent: true }
        : { ok: false, reason: 'upstream-error', status: 404, permanent: true },
    );
    const result = await materializeFederatedMedia(
      [
        { id: URL_A, type: 'image' },
        { id: URL_B, type: 'image' },
      ],
      [],
      'oxy-owner',
    );
    expect(result.media.map((m) => m.id)).toEqual([URL_A]);
  });
});
