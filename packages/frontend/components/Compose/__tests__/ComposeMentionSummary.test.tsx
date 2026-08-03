import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ComposeMentionSummary from '../ComposeMentionSummary';
import type { MentionData } from '@/utils/mentions';

/**
 * WHAT THE AUTHOR IS TOLD, BEFORE THEY SEND.
 *
 * A profile link they paste becomes a real mention at the write boundary — the
 * id lands in `post.mentions`, which notifies that person. These assertions are
 * about the composer saying so, and — the cases that matter more — about it
 * staying silent whenever the write boundary will leave the link a link.
 *
 * THE ANSWER COMES FROM THE SERVER, so the seam mocked here is the app's HTTP
 * client rather than an Oxy username lookup. That is not a detail of wiring: a
 * link to another fediverse host is folded exactly like one of ours whenever we
 * already store the actor, and only the server can say so. The cases below that
 * name a `mastodon.social` account are the ones that could not be written at all
 * while this hook resolved handles by itself.
 *
 * The real `QueryClient` runs; only the HTTP call is stubbed, so the debounce,
 * the query and the render are the code under test rather than a
 * re-implementation of it.
 */

const mockPost = jest.fn();

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    post: (...args: unknown[]) => mockPost(...args),
  },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { defaultValue?: string }) => vars?.defaultValue ?? key,
  }),
}));
jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: {} }),
}));

interface StubbedMention {
  userId: string;
  handle: string;
  displayName: string;
}

/**
 * Answer `POST /mentions/profile-links` the way the server does: one entry per
 * URL it was ASKED about, in request order, `mention: null` for a URL we hold
 * nobody for. Keying the stub by URL rather than returning a fixed list is what
 * lets a case assert which URLs were sent.
 */
function stubEndpoint(byUrl: Record<string, StubbedMention>): void {
  mockPost.mockImplementation(async (_endpoint: string, body: { urls: string[] }) => ({
    data: {
      links: body.urls.map((url) => ({ url, mention: byUrl[url] ?? null })),
    },
  }));
}

/**
 * The URLs the composer actually asked about, across every request it made.
 *
 * LOAD-BEARING, not decoration — do not trim these assertions as redundant with
 * the rendered-row ones. This wire shipped broken once: the hook read `.url` off
 * elements of what was already a `string[]`, so every request left as
 * `{"urls":[null]}` and the endpoint rejected it. Nobody would ever have been
 * named, and NO assertion about the rendered output could have caught it —
 * a row that renders nothing is indistinguishable from a body that correctly
 * mentions nobody. Only the outgoing request separates them.
 *
 * `tsc` could not see it either: the read went through a
 * `JSON.parse(...) as { url: string }[]` cast, which made the wrong access
 * legal. The only type errors on the branch at the time were in a test file,
 * pointing away from the fault.
 */
function askedUrls(): string[][] {
  return mockPost.mock.calls.map(([, body]) => (body as { urls: string[] }).urls);
}

/** Every string the rendered row puts on screen, flattened in reading order. */
function renderedText(tree: TestRenderer.ReactTestRenderer): string {
  const strings: string[] = [];
  const walk = (node: TestRenderer.ReactTestInstance) => {
    for (const child of node.children) {
      if (typeof child === 'string') strings.push(child);
      else walk(child);
    }
  };
  walk(tree.root);
  return strings.join('');
}

async function renderSummary(texts: string[], mentions: MentionData[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  let tree: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <ComposeMentionSummary texts={texts} mentions={mentions} />
      </QueryClientProvider>,
    );
  });

  // Two passes, and both are load-bearing: the first carries the text past the
  // resolve debounce, which is what STARTS the lookup; the second flushes the
  // lookup's own promise and the render it schedules.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(500);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });

  return tree as TestRenderer.ReactTestRenderer;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockPost.mockReset();
  stubEndpoint({});
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a pasted profile link that resolves is announced', () => {
  it('names the person the post is about to mention', async () => {
    stubEndpoint({
      'https://mention.earth/@alice': {
        userId: 'user-alice',
        handle: 'alice',
        displayName: 'Alice',
      },
    });

    const tree = await renderSummary(['have you seen https://mention.earth/@alice']);

    expect(askedUrls()).toEqual([['https://mention.earth/@alice']]);
    expect(renderedText(tree)).toContain('This post will mention');
    expect(renderedText(tree)).toContain('@alice');
  });

  it('names the account a link to ANOTHER fediverse host will mention', async () => {
    // The case this whole wire exists for. The write boundary folds this link
    // whenever we already store the actor, and the composer could not see that
    // while it resolved handles against Oxy by itself — so a paste rang somebody's
    // phone with nothing on screen having said so.
    stubEndpoint({
      'https://mastodon.social/@alice': {
        userId: 'user-alice-remote',
        handle: 'alice@mastodon.social',
        displayName: 'Alice',
      },
    });

    const tree = await renderSummary(['say hi to https://mastodon.social/@alice']);

    expect(askedUrls()).toEqual([['https://mastodon.social/@alice']]);
    // The CANONICAL handle, exactly as the published post will render it.
    expect(renderedText(tree)).toContain('@alice@mastodon.social');
  });

  it('lists a link-derived mention beside a picked one, in one sentence', async () => {
    stubEndpoint({
      'https://mention.earth/@carol': {
        userId: 'user-carol',
        handle: 'carol',
        displayName: 'carol',
      },
    });

    const tree = await renderSummary(
      ['hi [mention:user-bob] and https://mention.earth/@carol'],
      [{ userId: 'user-bob', username: 'bob', displayName: 'Bob' }],
    );

    const text = renderedText(tree);
    expect(text).toContain('@bob');
    expect(text).toContain('@carol');
  });

  it('reads a link in a language variant too — the post carries the union', async () => {
    stubEndpoint({
      'https://mention.earth/@alice': {
        userId: 'user-alice',
        handle: 'alice',
        displayName: 'alice',
      },
    });

    const tree = await renderSummary(['hello', 'hola https://mention.earth/@alice']);

    expect(renderedText(tree)).toContain('@alice');
  });

  it('names one person once when the body spells their profile two ways', async () => {
    // Two URLs, two slots, ONE identity — the duplicate collapses on the id in
    // the answer, which is where the server collapses it too.
    stubEndpoint({
      'https://mention.earth/@alice': {
        userId: 'user-alice',
        handle: 'alice',
        displayName: 'alice',
      },
      'https://mention.earth/ap/users/alice': {
        userId: 'user-alice',
        handle: 'alice',
        displayName: 'alice',
      },
    });

    const tree = await renderSummary([
      'https://mention.earth/@alice https://mention.earth/ap/users/alice',
    ]);

    expect(renderedText(tree).match(/@alice/g)).toHaveLength(1);
  });
});

describe('a link that stays a link is never announced', () => {
  it('says nothing for a profile the server holds nobody for', async () => {
    // The server resolves this through the same lookup and gets nothing, so it
    // stores no mention and leaves the URL in the body. It answers `null` for
    // that URL rather than failing.
    const tree = await renderSummary(['https://mention.earth/@ghost']);

    expect(askedUrls()).toEqual([['https://mention.earth/@ghost']]);
    expect(renderedText(tree)).toBe('');
  });

  it('says nothing for a fediverse profile we do not store', async () => {
    const tree = await renderSummary(['https://mastodon.social/@stranger']);

    expect(renderedText(tree)).toBe('');
  });

  it('says nothing, and asks nothing, for an ordinary link', async () => {
    const tree = await renderSummary(['https://example.com/alice']);

    expect(mockPost).not.toHaveBeenCalled();
    expect(renderedText(tree)).toBe('');
  });

  it('asks about the profile-shaped links only, never the whole body', async () => {
    stubEndpoint({
      'https://mention.earth/@alice': {
        userId: 'user-alice',
        handle: 'alice',
        displayName: 'alice',
      },
    });

    await renderSummary([
      'read https://example.com/blog then https://mention.earth/@alice',
    ]);

    expect(askedUrls()).toEqual([['https://mention.earth/@alice']]);
  });

  it('says nothing when the lookup fails outright — it never guesses', async () => {
    mockPost.mockRejectedValue(new Error('network down'));

    const tree = await renderSummary(['https://mention.earth/@alice']);

    expect(renderedText(tree)).toBe('');
  });

  it('renders nothing at all for a body with no mentions', async () => {
    const tree = await renderSummary(['just some words']);

    expect(tree.toJSON()).toBeNull();
  });
});

describe('the summary describes the body, and only the body', () => {
  it('drops a picked mention whose placeholder the author deleted', async () => {
    const tree = await renderSummary(
      ['the text no longer names them'],
      [{ userId: 'user-bob', username: 'bob', displayName: 'Bob' }],
    );

    expect(tree.toJSON()).toBeNull();
  });

  it('asserts nothing until the lookup has answered', async () => {
    let settle: (value: unknown) => void = () => {};
    mockPost.mockReturnValue(new Promise((resolve) => { settle = resolve; }));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        <QueryClientProvider client={client}>
          <ComposeMentionSummary texts={['https://mention.earth/@alice']} mentions={[]} />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });

    // In flight: no name on screen, so the row can never assert and then retract.
    expect(renderedText(tree as TestRenderer.ReactTestRenderer)).toBe('');

    await act(async () => {
      settle({
        data: {
          links: [
            {
              url: 'https://mention.earth/@alice',
              mention: { userId: 'user-alice', handle: 'alice', displayName: 'alice' },
            },
          ],
        },
      });
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(renderedText(tree as TestRenderer.ReactTestRenderer)).toContain('@alice');
  });

  it('does not spend a lookup on every keystroke of a URL being typed', async () => {
    stubEndpoint({
      'https://mention.earth/@alice': {
        userId: 'user-alice',
        handle: 'alice',
        displayName: 'alice',
      },
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        <QueryClientProvider client={client}>
          <ComposeMentionSummary texts={['https://mention.earth/@a']} mentions={[]} />
        </QueryClientProvider>,
      );
    });

    for (const text of ['https://mention.earth/@al', 'https://mention.earth/@ali', 'https://mention.earth/@alice']) {
      await act(async () => {
        (tree as TestRenderer.ReactTestRenderer).update(
          <QueryClientProvider client={client}>
            <ComposeMentionSummary texts={[text]} mentions={[]} />
          </QueryClientProvider>,
        );
        await jest.advanceTimersByTimeAsync(50);
      });
    }

    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });

    expect(askedUrls()).toEqual([['https://mention.earth/@alice']]);
  });
});
