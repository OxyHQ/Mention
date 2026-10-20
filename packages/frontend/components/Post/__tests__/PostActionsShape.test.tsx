import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import PostActions from '../PostActions';

/** The action bar keeps all engagement counts on their respective buttons. */

jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({
    colors: { primary: '#1d9bf0', success: '#00ba7c', textSecondary: '#8899a6' },
  }),
}));
jest.mock('@oxy.so/bloom/hooks', () => ({ useHaptics: () => () => undefined }));
jest.mock('@oxy.so/bloom/loading', () => ({ SpinnerIcon: () => null }));
jest.mock('@oxy.so/bloom/avatar', () => ({ Avatar: 'Avatar' }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@/hooks/useVoteStyle', () => ({ useVoteStyle: () => 'icons' }));

// Host element names, so a `PressableScale` reintroduced anywhere in this bar
// shows up in the tree by name instead of dissolving into the `View` it renders.
jest.mock('@oxy.so/bloom/pressable-scale', () => ({ PressableScale: 'PressableScale' }));

// Icons are react-native-svg subtrees and say nothing about the bar's shape.
jest.mock('@/assets/icons/comment-icon', () => ({ CommentIcon: () => null }));
jest.mock('@/assets/icons/boost-icon', () => ({
  BoostIcon: () => null,
  BoostIconActive: () => null,
}));
jest.mock('@/assets/icons/share-icon', () => ({ ShareIcon: () => null }));
jest.mock('@/assets/icons/bookmark-icon', () => ({
  Bookmark: () => null,
  BookmarkActive: () => null,
}));
jest.mock('@/assets/icons/analytics-icon', () => ({ AnalyticsIcon: () => null }));
jest.mock('@/lib/animations/AnimatedLikeIcon', () => ({ AnimatedLikeIcon: () => null }));
jest.mock('@/lib/animations/CountWheel', () => ({ CountWheel: () => null }));

const noop = () => undefined;

function renderBar(props: Partial<React.ComponentProps<typeof PostActions>> = {}) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <PostActions
        engagement={{ replies: 2, likes: 3 }}
        {...props}
        onReply={noop}
        onBoost={noop}
        onLike={noop}
        onSave={noop}
        onShare={noop}
      />,
    );
  });
  if (!renderer) throw new Error('render produced no tree');
  return renderer;
}

describe('PostActions shape', () => {
  it('renders a single row with the reply count inside the reply button', () => {
    const renderer = renderBar();
    expect(Array.isArray(renderer.toJSON())).toBe(false);
    const reply = renderer.root.findAll(
      (node) => String(node.type) === 'PressableScale' && node.props.accessibilityLabel === 'Reply',
    );
    expect(reply).toHaveLength(1);
    expect(reply[0].findAll((node) => node.children.includes('2'))).not.toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('2 replies');
    act(() => renderer.unmount());
  });

  it('omits a zero reply count', () => {
    const renderer = renderBar({ engagement: { replies: 0, likes: 0 } });
    const reply = renderer.root.findAll(
      (node) => String(node.type) === 'PressableScale' && node.props.accessibilityLabel === 'Reply',
    )[0];
    expect(reply.findAll((node) => node.children.includes('0'))).toHaveLength(0);
    act(() => renderer.unmount());
  });

  // The bar counted likes and saves and left the boost icon bare, so a post
  // boosted once read as boosted by nobody (OxyHQ/Mention#1140).
  it('counts boosts beside the boost icon, and draws no count at zero', () => {
    const withBoosts = renderBar({ engagement: { replies: 0, likes: 0, boosts: 1 } });
    const boostButton = withBoosts.root.findAll(
      (node) =>
        String(node.type) === 'PressableScale' &&
        node.props.accessibilityLabel === 'Repost options',
    );
    expect(boostButton).toHaveLength(1);
    expect(boostButton[0].findAll((node) => node.children.includes('1'))).not.toHaveLength(0);
    act(() => withBoosts.unmount());

    const none = renderBar({ engagement: { replies: 0, likes: 0, boosts: 0 } });
    const bare = none.root.findAll(
      (node) =>
        String(node.type) === 'PressableScale' &&
        node.props.accessibilityLabel === 'Repost options',
    );
    expect(bare[0].findAll((node) => node.children.includes('0'))).toHaveLength(0);
    act(() => none.unmount());
  });
});
