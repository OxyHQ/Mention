import TestRenderer, { act } from 'react-test-renderer';
import { MAX_POST_DOCUMENTS } from '@mention/shared-types/post';
import { useLinksStore } from '@/stores/linksStore';
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
jest.mock('@/stores/linksStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  return {
    useLinksStore: create(() => ({
      dataVersion: 0,
      getCached: (...args: unknown[]) => mockGetCached(...args),
      upsertLink: (...args: unknown[]) => mockUpsertLink(...args),
    })),
  };
});

function Probe({ text }: { text: string }) {
  useLinkDetection(text);
  return null;
}

/** Which URLs the composer actually asked for a preview of. */
async function requestedPreviewUrls(text: string): Promise<string[]> {
  const rendered: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  await act(async () => {
    rendered.current = TestRenderer.create(<Probe text={text} />);
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('Link detection probe did not render');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(600);
  });
  const urls = mockResolve.mock.calls.flatMap(([requested]) => requested as string[]);
  act(() => renderer.unmount());
  return urls;
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

it('does not rerender when an unrelated link cache entry changes', () => {
  let renders = 0;
  function RenderProbe() {
    renders += 1;
    useLinkDetection('');
    return null;
  }
  const rendered: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    rendered.current = TestRenderer.create(<RenderProbe />);
  });
  const tree = rendered.current;
  if (!tree) throw new Error('Link detection probe did not render');
  const before = renders;
  act(() => useLinksStore.setState((state) => ({ dataVersion: state.dataVersion + 1 })));
  expect(renders).toBe(before);
  act(() => tree.unmount());
});

it.each(['before', 'after'] as const)(
  'ignores an aborted preview response settling %s the newer request',
  async (order) => {
    type PreviewResponse = { previews: ReturnType<typeof preview>[]; pending: string[] };
    let resolveOld: (response: PreviewResponse) => void = () => {
      throw new Error('Old request was not started');
    };
    let resolveNew: (response: PreviewResponse) => void = () => {
      throw new Error('New request was not started');
    };
    mockResolve
      .mockReturnValueOnce(new Promise<PreviewResponse>((resolve) => (resolveOld = resolve)))
      .mockReturnValueOnce(new Promise<PreviewResponse>((resolve) => (resolveNew = resolve)));
    const result: { current: ReturnType<typeof useLinkDetection> | null } = { current: null };
    function RenderProbe({ text }: { text: string }) {
      result.current = useLinkDetection(text);
      return null;
    }
    const rendered: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
    act(() => {
      rendered.current = TestRenderer.create(<RenderProbe text="https://example.com/old" />);
    });
    const tree = rendered.current;
    if (!tree) throw new Error('Link detection probe did not render');
    await act(async () => jest.advanceTimersByTimeAsync(500));
    act(() => tree.update(<RenderProbe text="https://example.com/new" />));
    await act(async () => jest.advanceTimersByTimeAsync(500));
    const finishOld = () =>
      act(async () => {
        resolveOld({ previews: [preview('https://example.com/old')], pending: [] });
        await Promise.resolve();
      });
    const finishNew = () =>
      act(async () => {
        resolveNew({ previews: [preview('https://example.com/new')], pending: [] });
        await Promise.resolve();
      });
    if (order === 'before') {
      await finishOld();
      expect(result.current?.isLoading).toBe(true);
      expect(result.current?.detectedLinks).toEqual([]);
      await finishNew();
    } else {
      await finishNew();
      await finishOld();
    }
    expect(result.current?.isLoading).toBe(false);
    expect(result.current?.detectedLinks.map((link) => link.url)).toEqual([
      'https://example.com/new',
    ]);
    act(() => tree.unmount());
  },
);

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

    const rendered: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
    await act(async () => {
      rendered.current = TestRenderer.create(
        <Reader text="https://example.org/fresh then https://example.com/cached" />,
      );
    });
    const renderer = rendered.current;
    if (!renderer) throw new Error('Link detection reader did not render');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(600);
    });

    expect(mockResolve).toHaveBeenCalledWith(['https://example.org/fresh'], expect.anything());
    expect(links.map((link) => (link as { url: string }).url)).toEqual([
      'https://example.org/fresh',
      'https://example.com/cached',
    ]);
    act(() => renderer.unmount());
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
    act(() => renderer?.unmount());
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
