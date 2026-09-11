import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import type { CrosspostProvenance } from '@mention/shared-types';

import PostCrosspostRow from '../PostCrosspostRow';

/**
 * The row names one piece of writing that was published to two networks, on the
 * card that renders it once. Three jobs, each of which fails silently:
 *
 *  - it names BOTH networks, because "also on Threads" reads as a second,
 *    different post — the exact misunderstanding the collapse exists to prevent;
 *  - the hidden variant is reachable, INTERNALLY, at `/p/<id>` — both variants
 *    are real Mention posts, and a reader who wants the other version should not
 *    be sent to a site that may ask them to log in;
 *  - pressing it never opens the post underneath, since the row lives inside the
 *    card's own press target.
 */

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (...args: unknown[]) => mockPush(...args) }),
}));

const PROVENANCE: CrosspostProvenance = {
  variants: [
    { network: 'instagram.com', label: 'Instagram', postId: 'p-ig', rendered: true },
    { network: 'threads.net', label: 'Threads', postId: 'p-th', rendered: false },
  ],
};

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/**
 * Every link in the row, found by accessibility role rather than by component
 * identity: RN wraps its primitives in memo/forwardRef pairs, so a type lookup
 * finds nothing and would pass a broken row as "correctly not pressable".
 *
 * HOST nodes only (`typeof type === 'string'`). RN's `Text` is a class component
 * that renders a host `Text`, so the same logical link matches twice and a
 * count assertion would read one link as two — which is the assertion that
 * matters here, since linking the RENDERED variant would be a link to where the
 * reader already is.
 */
function links(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) =>
      typeof node.type === 'string'
      && node.props?.accessibilityRole === 'link'
      && typeof node.props?.onPress === 'function',
  );
}

/** Every string the row renders, flattened — what a reader actually sees. */
function text(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: ReactTestInstance | string): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    for (const child of node.children ?? []) walk(child as ReactTestInstance | string);
  };
  walk(renderer.root);
  return out.join('');
}

describe('PostCrosspostRow', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('names every network the writing was published to', () => {
    const renderer = render(<PostCrosspostRow crosspost={PROVENANCE} iconColor="#888" />);

    expect(text(renderer)).toContain('Instagram');
    expect(text(renderer)).toContain('Threads');
  });

  it('opens the hidden variant internally, and swallows the press', () => {
    const renderer = render(<PostCrosspostRow crosspost={PROVENANCE} iconColor="#888" />);
    const [link, ...rest] = links(renderer);

    // Exactly one: the rendered variant is this card, so linking it would be a
    // link to where the reader already is.
    expect(rest).toHaveLength(0);

    const stopPropagation = jest.fn();
    act(() => {
      link.props.onPress({ stopPropagation });
    });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    // `/p/<id>`, never instagram.com or threads.net.
    expect(mockPush).toHaveBeenCalledWith('/p/p-th');
  });

  it('never links off-site', () => {
    const renderer = render(<PostCrosspostRow crosspost={PROVENANCE} iconColor="#888" />);
    act(() => {
      links(renderer)[0].props.onPress({ stopPropagation: jest.fn() });
    });

    const [[target]] = mockPush.mock.calls;
    expect(String(target).startsWith('/p/')).toBe(true);
    expect(String(target)).not.toContain('://');
  });

  /**
   * One network is not provenance, it is simply where the post is. A cluster can
   * be read mid-repair with a single member (`reevaluateCluster` dissolves it
   * moments later), and `Instagram` alone would say nothing while looking like
   * it meant something.
   */
  it.each([
    ['a single variant', { variants: [PROVENANCE.variants[0]] }],
    ['no variants', { variants: [] }],
  ])('renders nothing for %s', (_label, crosspost) => {
    const renderer = render(
      <PostCrosspostRow crosspost={crosspost as CrosspostProvenance} iconColor="#888" />,
    );

    expect(renderer.toJSON()).toBeNull();
  });
});
