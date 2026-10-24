import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import PostActions from '../PostActions';

/**
 * The action bar is Bloom's `EngagementBar`; what is Mention's is the WIRING —
 * which count lands on which action, which state paints it, and that a
 * rejected like reaches the bar as a rejection (so it neither buzzes nor
 * animates). Bloom's own suite covers how an action draws and animates.
 */

// Host names, so the tree reads as the bar Mention builds. The bar renders its
// `trailing` group after its children, as Bloom's does.
jest.mock('@oxy.so/bloom/engagement-bar', () => {
  const { createElement } = require('react');
  return {
    EngagementBar: ({ children, trailing }: { children: unknown; trailing: unknown }) =>
      createElement('EngagementBar', null, children, trailing),
    EngagementAction: 'EngagementAction',
    EngagementGroup: 'EngagementGroup',
  };
});

let mockVoteStyle = 'icons';
jest.mock('@/hooks/useVoteStyle', () => ({ useVoteStyle: () => mockVoteStyle }));

const noop = () => undefined;

function renderBar(props: Partial<React.ComponentProps<typeof PostActions>> = {}) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <PostActions
        engagement={{ replies: 2, likes: 3, boosts: 1, saves: 0 }}
        onReply={noop}
        onBoost={noop}
        onLike={noop}
        onSave={noop}
        onShare={noop}
        {...props}
      />,
    );
  });
  if (!renderer) throw new Error('render produced no tree');
  return renderer;
}

const action = (renderer: TestRenderer.ReactTestRenderer, label: string) =>
  renderer.root.find(
    (node) => String(node.type) === 'EngagementAction' && node.props.accessibilityLabel === label,
  ).props;

describe('PostActions', () => {
  afterEach(() => {
    mockVoteStyle = 'icons';
  });

  it('puts each count on its own action and passes a rejected like back to the bar', () => {
    const onLike = jest.fn(() => false);
    const renderer = renderBar({ onLike, isBoosted: true });
    expect(action(renderer, 'Like')).toMatchObject({
      count: 3,
      active: false,
      popOnActivate: true,
    });
    expect(action(renderer, 'Reply').count).toBe(2);
    // A post boosted once must not read as boosted by nobody (OxyHQ/Mention#1140).
    expect(action(renderer, 'Repost options')).toMatchObject({ count: 1, active: true });
    expect(action(renderer, 'Save post').count).toBe(0);
    expect(action(renderer, 'Like').onPress()).toBe(false);
    act(() => renderer.unmount());
  });

  it('draws the vote pill as an up/down pair carrying the net score', () => {
    mockVoteStyle = 'pill';
    const renderer = renderBar({
      engagement: { replies: 0, likes: 5, downvotes: 2 },
      onDownvote: noop,
      isDownvoted: true,
    });
    const pill = renderer.root.find((node) => String(node.type) === 'EngagementGroup');
    const [up, down] = pill.findAll((node) => String(node.type) === 'EngagementAction');
    expect(up.props).toMatchObject({ accessibilityLabel: 'Upvote', count: 3, active: false });
    expect(down.props).toMatchObject({ accessibilityLabel: 'Downvote', active: true });
    act(() => renderer.unmount());
  });
});
