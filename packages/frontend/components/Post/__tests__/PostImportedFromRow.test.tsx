import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';

import PostImportedFromRow from '../PostImportedFromRow';

/**
 * "Originally posted on Mastodon": the row names where an imported post was
 * first published and opens that permalink — through `openExternalLink`, the one
 * vetted way out of the app — without also opening the post it sits on.
 */

const mockOpenExternalLink = jest.fn();
jest.mock('@/utils/openExternalLink', () => ({
  openExternalLink: (...args: unknown[]) => mockOpenExternalLink(...args),
}));

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/** Host link nodes only — RN's `Text` renders a host `Text`, so a type lookup would double-count. */
function links(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) =>
      typeof node.type === 'string'
      && node.props?.accessibilityRole === 'link'
      && typeof node.props?.onPress === 'function',
  );
}

describe('PostImportedFromRow', () => {
  beforeEach(() => mockOpenExternalLink.mockReset());

  it('renders the label it is given as ONE link', () => {
    const renderer = render(
      <PostImportedFromRow
        label="Originally posted on Mastodon"
        sourceUrl="https://mastodon.example/@alice/1"
        iconColor="#999"
      />,
    );
    const [link, ...rest] = links(renderer);
    expect(rest).toHaveLength(0);
    expect(link.props.accessibilityLabel).toBe('Originally posted on Mastodon');
  });

  it('opens the original permalink and stops the press reaching the post', () => {
    const renderer = render(
      <PostImportedFromRow
        label="Originally posted on Bluesky"
        sourceUrl="https://bsky.app/profile/alice/post/1"
        iconColor="#999"
      />,
    );
    const stopPropagation = jest.fn();
    act(() => {
      links(renderer)[0].props.onPress({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalLink).toHaveBeenCalledWith('https://bsky.app/profile/alice/post/1');
  });
});
