import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `resolveClarityDocuments` is the one door to Clarity's `POST /v1/resolve`. These
 * pin the parts of Clarity's contract it exists to honour: at most 50 URLs a
 * call, and results that answer by position with the URL echoed canonicalised.
 */

const { resolve } = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock('../../utils/clarityClient', () => ({
  getClarityClient: async () => ({ indexing: { resolve } }),
}));

import { CLARITY_RESOLVE_BATCH, resolveClarityDocuments } from '../../utils/clarityDocuments';

function document(url: string) {
  return { id: `doc:${url}`, canonicalUrl: url, type: 'page', status: 'indexed', authors: [], evidence: {} };
}

/** Answers like Clarity: one result per requested URL, in request order. */
function answerEveryUrl() {
  resolve.mockImplementation(async ({ urls }: { urls: string[] }) => ({
    data: urls.map((url) => ({ url, status: 'indexed', document: document(url) })),
  }));
}

describe('resolveClarityDocuments', () => {
  beforeEach(() => {
    resolve.mockReset();
  });

  it('asks nothing for an empty set', async () => {
    const result = await resolveClarityDocuments([]);
    expect(resolve).not.toHaveBeenCalled();
    expect(result.documents.size).toBe(0);
    expect(result.pending.size).toBe(0);
  });

  it('never sends Clarity more than its per-call cap', async () => {
    answerEveryUrl();
    const urls = Array.from({ length: 120 }, (_, index) => `https://example.com/a/${index}`);

    const result = await resolveClarityDocuments(urls);

    expect(resolve).toHaveBeenCalledTimes(3);
    for (const [request] of resolve.mock.calls) {
      expect(request.urls.length).toBeLessThanOrEqual(CLARITY_RESOLVE_BATCH);
    }
    expect(result.documents.size).toBe(120);
  });

  it('keeps the other batches when one call fails, and reports the failed one pending', async () => {
    let call = 0;
    resolve.mockImplementation(async ({ urls }: { urls: string[] }) => {
      call += 1;
      if (call === 1) throw new Error('active_crawl_quota_exceeded');
      return { data: urls.map((url) => ({ url, status: 'indexed', document: document(url) })) };
    });
    const urls = Array.from({ length: 60 }, (_, index) => `https://example.com/b/${index}`);

    const result = await resolveClarityDocuments(urls);

    expect(result.pending.size).toBe(CLARITY_RESOLVE_BATCH);
    expect(result.documents.size).toBe(10);
  });

  it('dedupes before asking', async () => {
    answerEveryUrl();
    await resolveClarityDocuments(['https://example.com/x', 'https://example.com/x']);
    expect(resolve).toHaveBeenCalledWith({ urls: ['https://example.com/x'] });
  });

  it('only sends a wait when the caller asks for one', async () => {
    answerEveryUrl();
    await resolveClarityDocuments(['https://example.com/x']);
    await resolveClarityDocuments(['https://example.com/y'], { waitMs: 3_000 });
    expect(resolve.mock.calls[0][0]).not.toHaveProperty('waitMs');
    expect(resolve.mock.calls[1][0]).toEqual({ urls: ['https://example.com/y'], waitMs: 3_000 });
  });
});
