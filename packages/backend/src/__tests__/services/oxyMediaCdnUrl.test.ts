import http from 'node:http';
import https from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The READ boundary of the federated media cache: the URL a mirrored object is
 * served from.
 *
 * This exists because the previous implementation asked oxy-api for that URL and
 * was rejected every single time. `GET /assets/:id/url` sits behind
 * `authMiddleware`, which accepts only session-based tokens (`if
 * (!decoded.sessionId) return 401`); the media cache holds a SERVICE token,
 * which has no `sessionId`. Six hours of production `/media/proxy` traffic
 * counted 481 cache fronts and 481 failed Oxy calls, ~4ms apiece — an auth
 * rejection, not a lookup — so every federated image and video was streamed from
 * its third-party host through our origin, and the ones whose host had gone away
 * were answered 404 despite a mirrored copy sitting in Oxy.
 *
 * Nothing needs to be asked: every asset this store creates is uploaded with
 * `visibility: 'public'`, and a public asset's URL is the deterministic by-id CDN
 * form that `cloud.oxy.so` resolves on its own.
 *
 * The client here is a REAL `OxyServices`, so the asserted URL is the SDK's, not
 * a shape invented by this file.
 */
vi.mock('../../utils/oxyHelpers', async () => {
  const { OxyServices } = await vi.importActual<typeof import('@oxyhq/core')>('@oxyhq/core');
  const client = new OxyServices({ baseURL: 'http://oxy.test' });
  return { getServiceOxyClient: () => client };
});

import { cachedMediaCdnUrl } from '../../services/mediaCache/oxyMediaStore';

const FILE_ID = 'oxyfile123';

describe('cachedMediaCdnUrl', () => {
  it('names the object on the public by-id CDN origin', () => {
    expect(cachedMediaCdnUrl(FILE_ID)).toBe(`https://cloud.oxy.so/${FILE_ID}`);
  });

  it('asks the CDN resolver for a sized render when a variant is wanted', () => {
    // The variant has to be built INTO the URL: `cloud.oxy.so/<id>` reads
    // `?variant=` and redirects to the sized object, whereas the content-addressed
    // key form goes straight to the storage origin, where a query string means
    // nothing. Appending it after the fact was silently serving originals.
    expect(cachedMediaCdnUrl(FILE_ID, 'w320')).toBe(`https://cloud.oxy.so/${FILE_ID}?variant=w320`);
  });

  it('costs no request to oxy-api', async () => {
    // The defect, stated as a test: asking the API to name a public asset IS the
    // bug, whether or not the answer is awaited.
    const { getServiceOxyClient } = await import('../../utils/oxyHelpers');
    const ask = vi.spyOn(getServiceOxyClient(), 'getFileDownloadUrlAsync');
    const httpRequest = vi.spyOn(http, 'request');
    const httpsRequest = vi.spyOn(https, 'request');

    expect(cachedMediaCdnUrl(FILE_ID, 'w320')).toBe(`https://cloud.oxy.so/${FILE_ID}?variant=w320`);

    // A fired-and-forgotten resolution reaches its transport a microtask later,
    // so drain the queue before concluding that nothing was sent.
    await Promise.resolve();
    await Promise.resolve();

    expect(ask).not.toHaveBeenCalled();
    expect(httpRequest).not.toHaveBeenCalled();
    expect(httpsRequest).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
