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

// The composer asks MENTION's backend, never Clarity: this is the only seam the
// hook has to the network.
jest.mock('@/services/feedService', () => ({
  feedService: {
    resolveLinkPreviews: (...args: unknown[]) => mockResolve(...args),
  },
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
  return mockResolve.mock.calls.flatMap(([urls]) => urls as string[]);
}

function preview(url: string) {
  return {
    url,
    document: {
      id: url,
      canonicalUrl: url,
      title: 'a title',
      type: 'page',
      status: 'indexed',
      authors: [],
      evidence: {},
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockResolve.mockReset();
  mockGetCached.mockReset();
  mockUpsertLink.mockReset();
  mockResolve.mockImplementation(async (urls: string[]) => ({
    previews: urls.map(preview),
    pending: [],
  }));
});

it('asks for every uncached link in one backend call', async () => {
  const urls = await requestedPreviewUrls('https://example.com/a and https://example.org/b');
  expect(mockResolve).toHaveBeenCalledTimes(1);
  expect(urls).toEqual(['https://example.com/a', 'https://example.org/b']);
  expect(mockUpsertLink).toHaveBeenCalledTimes(2);
});

it('uses cached metadata without another request', async () => {
  mockGetCached.mockReturnValue({
    url: 'https://example.com/cached',
    title: 'Cached',
    fetchedAt: 1,
  });
  expect(await requestedPreviewUrls('https://example.com/cached')).toEqual([]);
  expect(mockResolve).not.toHaveBeenCalled();
});

it('does not cache a link the backend reports still pending', async () => {
  mockResolve.mockResolvedValue({ previews: [], pending: ['https://example.com/pending'] });
  expect(await requestedPreviewUrls('https://example.com/pending')).toEqual([
    'https://example.com/pending',
  ]);
  expect(mockUpsertLink).not.toHaveBeenCalled();
});

it('treats a resolution failure as no preview', async () => {
  mockResolve.mockRejectedValue(new Error('unavailable'));
  expect(await requestedPreviewUrls('https://example.com/failure')).toEqual([
    'https://example.com/failure',
  ]);
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
  const urls = await requestedPreviewUrls(`https://mention.earth/@alice ${others.join(' ')}`);

  expect(urls).toEqual(others.slice(0, MAX_POST_DOCUMENTS - 1));
});

describe('the composer resolves only what it does not already have', () => {
  it('keeps cached cards and asks only for the rest, in text order', async () => {
    const cached = { url: 'https://example.com/cached', title: 'Cached', fetchedAt: 1 };
    mockGetCached.mockImplementation((url: string) => (url === cached.url ? cached : undefined));
    let links: unknown[] = [];
    function Reader({ text }: { text: string }) {
      links = useLinkDetection(text).detectedLinks;
      return null;
    }

    await act(async () => {
      TestRenderer.create(
        <Reader text="https://example.org/fresh then https://example.com/cached" />,
      );
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(600);
    });

    expect(mockResolve).toHaveBeenCalledWith(['https://example.org/fresh'], expect.anything());
    expect(links.map((link) => (link as { url: string }).url)).toEqual([
      'https://example.org/fresh',
      'https://example.com/cached',
    ]);
  });
});

describe('an answer that arrives after the draft changed', () => {
  async function typeThenRetype(
    settle: (resolve: (value: unknown) => void, reject: (error: unknown) => void) => void,
  ) {
    let settleFirst: ((value: unknown) => void) | undefined;
    let failFirst: ((error: unknown) => void) | undefined;
    mockResolve.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          settleFirst = resolve;
          failFirst = reject;
        }),
    );
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(<Probe text="https://example.com/first" />);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(600);
    });
    // The author keeps typing: the first request is abandoned.
    await act(async () => {
      renderer?.update(<Probe text="" />);
    });
    await act(async () => {
      settle(settleFirst as (value: unknown) => void, failFirst as (error: unknown) => void);
      await jest.advanceTimersByTimeAsync(600);
    });
  }

  it('is dropped rather than cached', async () => {
    await typeThenRetype((resolve) =>
      resolve({ previews: [preview('https://example.com/first')], pending: [] }),
    );
    expect(mockUpsertLink).not.toHaveBeenCalled();
  });

  it('is dropped quietly when it failed', async () => {
    await typeThenRetype((_resolve, reject) => reject(new Error('aborted')));
    expect(mockUpsertLink).not.toHaveBeenCalled();
  });
});
