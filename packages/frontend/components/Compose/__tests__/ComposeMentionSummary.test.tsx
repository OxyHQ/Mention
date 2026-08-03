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
 * The real `QueryClient` runs; only the profile lookup and the untranspiled SDK
 * modules are mocked, so the debounce, the query and the render are the code
 * under test rather than a re-implementation of it.
 */

const mockGetProfileByUsername = jest.fn();

jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: () => ({
    oxyServices: {
      getProfileByUsername: (...args: unknown[]) => mockGetProfileByUsername(...args),
    },
  }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { defaultValue?: string }) => vars?.defaultValue ?? key,
  }),
}));
jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: {} }),
}));

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
  mockGetProfileByUsername.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a pasted profile link that resolves is announced', () => {
  it('names the person the post is about to mention', async () => {
    mockGetProfileByUsername.mockResolvedValue({
      id: 'user-alice',
      username: 'alice',
      name: { displayName: 'Alice' },
    });

    const tree = await renderSummary(['have you seen https://mention.earth/@alice']);

    expect(mockGetProfileByUsername).toHaveBeenCalledWith('alice');
    expect(renderedText(tree)).toContain('This post will mention');
    expect(renderedText(tree)).toContain('@alice');
  });

  it('lists a link-derived mention beside a picked one, in one sentence', async () => {
    mockGetProfileByUsername.mockResolvedValue({ id: 'user-carol', username: 'carol' });

    const tree = await renderSummary(
      ['hi [mention:user-bob] and https://mention.earth/@carol'],
      [{ userId: 'user-bob', username: 'bob', displayName: 'Bob' }],
    );

    const text = renderedText(tree);
    expect(text).toContain('@bob');
    expect(text).toContain('@carol');
  });

  it('reads a link in a language variant too — the post carries the union', async () => {
    mockGetProfileByUsername.mockResolvedValue({ id: 'user-alice', username: 'alice' });

    const tree = await renderSummary(['hello', 'hola https://mention.earth/@alice']);

    expect(renderedText(tree)).toContain('@alice');
  });

  it('names one person once when the body spells their profile two ways', async () => {
    mockGetProfileByUsername.mockResolvedValue({ id: 'user-alice', username: 'alice' });

    const tree = await renderSummary([
      'https://mention.earth/@alice https://mention.earth/ap/users/alice',
    ]);

    expect(renderedText(tree).match(/@alice/g)).toHaveLength(1);
  });
});

describe('a link that stays a link is never announced', () => {
  it('says nothing for a handle nobody holds', async () => {
    // The server resolves this through the same lookup and gets nothing, so it
    // stores no mention and leaves the URL in the body.
    mockGetProfileByUsername.mockRejectedValue(new Error('Not found'));

    const tree = await renderSummary(['https://mention.earth/@ghost']);

    expect(mockGetProfileByUsername).toHaveBeenCalledWith('ghost');
    expect(renderedText(tree)).toBe('');
  });

  it('says nothing for a profile that resolves to no id', async () => {
    mockGetProfileByUsername.mockResolvedValue({ username: 'alice' });

    const tree = await renderSummary(['https://mention.earth/@alice']);

    expect(renderedText(tree)).toBe('');
  });

  it('says nothing, and asks nothing, for a fediverse profile link', async () => {
    const tree = await renderSummary(['https://mastodon.social/@alice']);

    expect(mockGetProfileByUsername).not.toHaveBeenCalled();
    expect(renderedText(tree)).toBe('');
  });

  it('says nothing, and asks nothing, for an ordinary link', async () => {
    const tree = await renderSummary(['https://example.com/alice']);

    expect(mockGetProfileByUsername).not.toHaveBeenCalled();
    expect(renderedText(tree)).toBe('');
  });

  it('says nothing when the lookup fails outright — it never guesses', async () => {
    mockGetProfileByUsername.mockRejectedValue(new Error('network down'));

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
    mockGetProfileByUsername.mockReturnValue(new Promise((resolve) => { settle = resolve; }));

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
      settle({ id: 'user-alice', username: 'alice' });
      await jest.advanceTimersByTimeAsync(0);
    });

    expect(renderedText(tree as TestRenderer.ReactTestRenderer)).toContain('@alice');
  });

  it('does not spend a lookup on every keystroke of a URL being typed', async () => {
    mockGetProfileByUsername.mockResolvedValue({ id: 'user-alice', username: 'alice' });

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

    expect(mockGetProfileByUsername.mock.calls.map(([handle]) => handle)).toEqual(['alice']);
  });
});
