import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { MAX_POST_DOCUMENTS } from '@mention/shared-types/post';
import { useLinkDetection } from '../useLinkDetection';

/**
 * A PASTED PROFILE LINK GETS NO PREVIEW CARD IN THE COMPOSER.
 *
 * The published post does not have one: hydration withholds the card server-side
 * for exactly these URLs, because the reader is shown a mention there rather than
 * a link. Offering it here would show the author an attachment their post is not
 * going to carry — and, once the write boundary rewrites the link out of the body
 * entirely, an attachment for a URL that is no longer in it.
 *
 * These assertions are about what the composer ASKS FOR, since that is where the
 * card comes from: a URL nobody resolves is a URL that gets no card, and it also
 * stops us paying a preview service to scrape our own profile pages.
 */

const mockResolve = jest.fn();
const mockGetCached = jest.fn();
const mockUpsertLink = jest.fn();
let capturedGetAccessToken: (() => string | Promise<string>) | undefined;

jest.mock('@clarity.surf/sdk', () => ({
  ClarityClient: class {
    constructor(options: { getAccessToken: () => string | Promise<string> }) {
      capturedGetAccessToken = options.getAccessToken;
    }
    indexing = { resolve: (...args: unknown[]) => mockResolve(...args) };
  },
}), { virtual: true });

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    oxyServices: { getClient: () => ({ getAccessToken: () => 'token' }) },
  }),
}));
jest.mock('@oxy.so/core/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));
jest.mock('@/stores/linksStore', () => ({
  useLinksStore: () => ({ getCached: mockGetCached, upsertLink: mockUpsertLink }),
}));

function Probe({ text }: { text: string }) {
  useLinkDetection(text);
  return null;
}

/** Which URLs the composer actually asked for a preview of. */
async function requestedPreviewUrls(text: string): Promise<string[]> {
  await act(async () => {
    TestRenderer.create(<Probe text={text} />);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(600);
  });
  return mockResolve.mock.calls.flatMap(([request]) => (request as { urls: string[] }).urls);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockResolve.mockReset();
  mockGetCached.mockReset();
  mockUpsertLink.mockReset();
  mockResolve.mockImplementation(async ({ urls }: { urls: string[] }) => ({
    data: urls.map((url) => ({
      url,
      status: 'indexed',
      document: { id: url, canonicalUrl: url, title: 'a title', type: 'page', status: 'indexed', authors: [], evidence: {} },
    })),
  }));
});

it('gives the Clarity SDK the active Oxy access token', async () => {
  await act(async () => {
    TestRenderer.create(<Probe text="" />);
  });

  expect(capturedGetAccessToken).toBeDefined();
  expect(await capturedGetAccessToken?.()).toBe('token');
});

it('uses cached Clarity metadata without another request', async () => {
  mockGetCached.mockReturnValue({ url: 'https://example.com/cached', title: 'Cached', fetchedAt: 1 });
  expect(await requestedPreviewUrls('https://example.com/cached')).toEqual([]);
  expect(mockResolve).not.toHaveBeenCalled();
});

it('does not cache a pending resolution without a document', async () => {
  mockResolve.mockResolvedValue({ data: [{ url: 'https://example.com/pending', status: 'queued', jobId: 'job-1' }] });
  expect(await requestedPreviewUrls('https://example.com/pending')).toEqual(['https://example.com/pending']);
  expect(mockUpsertLink).not.toHaveBeenCalled();
});

it('treats a resolution failure as no preview', async () => {
  mockResolve.mockRejectedValue(new Error('unavailable'));
  expect(await requestedPreviewUrls('https://example.com/failure')).toEqual(['https://example.com/failure']);
  expect(mockUpsertLink).not.toHaveBeenCalled();
});

afterEach(() => {
  jest.useRealTimers();
});

it('asks for no card for a profile link on this instance', async () => {
  expect(await requestedPreviewUrls('meet https://mention.earth/@alice')).toEqual([]);
});

it('asks for no card for the actor-URI spelling either', async () => {
  expect(await requestedPreviewUrls('https://mention.earth/ap/users/alice')).toEqual([]);
});

it('still asks for a card for every other link in the same body', async () => {
  const urls = await requestedPreviewUrls(
    'https://mention.earth/@alice and https://example.com/article',
  );

  expect(urls).toEqual(['https://example.com/article']);
});

it('still asks for a card for a fediverse profile link', async () => {
  // This side cannot tell whether that link becomes a mention, so nothing about
  // it changes — it keeps the card it has always had.
  expect(await requestedPreviewUrls('https://mastodon.social/@alice')).toEqual([
    'https://mastodon.social/@alice',
  ]);
});

it('still asks for a card for a post link on this instance', async () => {
  expect(await requestedPreviewUrls('https://mention.earth/p/abc123')).toEqual([
    'https://mention.earth/p/abc123',
  ]);
});

it('renders one card fewer rather than promoting a link past the cap', async () => {
  // The cap applies BEFORE the profile-link filter, which is what hydration
  // does; matching it is what makes the composer show the published shape.
  const others = Array.from(
    { length: MAX_POST_DOCUMENTS },
    (_, index) => `https://example.com/${index}`,
  );
  const urls = await requestedPreviewUrls(
    `https://mention.earth/@alice ${others.join(' ')}`,
  );

  expect(urls).toEqual(others.slice(0, MAX_POST_DOCUMENTS - 1));
});
