import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import type { LaneSummary } from '@mention/shared-types';

import PostLaneChip from '../PostLaneChip';

/**
 * The chip sits inside the post's own press target and names a lane that may or
 * may not have anywhere to go, so it has three jobs and every one of them fails
 * silently when broken:
 *
 *  - it opens the lane tab ONLY for a `tab` lane (a `mixed` lane's posts are
 *    already on the main tab, and a `hidden` lane has no profile surface at all —
 *    both would be a link to a tab the owner deliberately took away),
 *  - pressing it never opens the post underneath,
 *  - it disappears inside the lane's own tab, where every row is on that lane.
 */

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (...args: unknown[]) => mockPush(...args) }),
}));

const laneOf = (displayMode: LaneSummary['displayMode']): LaneSummary => ({
  id: 'lane-1',
  name: 'dev notes',
  displayMode,
});

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/**
 * The chip's link, when it has one. Found by its accessibility role rather than
 * by `Pressable`'s component identity: RN wraps `Pressable` in a memo/forwardRef
 * pair, so a type lookup finds nothing and the test would pass a broken chip as
 * "correctly not pressable".
 */
function linkOrNull(renderer: TestRenderer.ReactTestRenderer): ReactTestInstance | null {
  const found = renderer.root.findAll(
    (node) => node.props?.accessibilityRole === 'link' && typeof node.props?.onPress === 'function',
  );
  return found.length > 0 ? found[0] : null;
}

describe('PostLaneChip', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('opens the lane tab for a `tab` lane, and swallows the press', () => {
    const renderer = render(
      <PostLaneChip lane={laneOf('tab')} authorHandle="nate" feedDescriptor="for_you" />,
    );
    const link = linkOrNull(renderer);
    expect(link).not.toBeNull();

    const stopPropagation = jest.fn();
    act(() => {
      link?.props.onPress({ stopPropagation });
    });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/@nate/lane/lane-1');
  });

  it('renders plain text — never a link — for a mixed or hidden lane', () => {
    for (const mode of ['mixed', 'hidden'] as const) {
      const renderer = render(
        <PostLaneChip lane={laneOf(mode)} authorHandle="nate" feedDescriptor="for_you" />,
      );
      expect(linkOrNull(renderer)).toBeNull();
      expect(renderer.root.findAllByType(Text)).toHaveLength(1);
    }
  });

  it('is not pressable without a handle to route by', () => {
    const renderer = render(
      <PostLaneChip lane={laneOf('tab')} authorHandle="" feedDescriptor="for_you" />,
    );
    expect(linkOrNull(renderer)).toBeNull();
  });

  it('shows the lane name after a chevron', () => {
    const renderer = render(
      <PostLaneChip lane={laneOf('mixed')} authorHandle="nate" />,
    );
    expect(renderer.root.findByType(Text).props.children).toBe('› dev notes');
  });

  it('suppresses itself inside the lane’s own tab', () => {
    const renderer = render(
      <PostLaneChip lane={laneOf('tab')} authorHandle="nate" feedDescriptor="lane|lane-1" />,
    );
    expect(renderer.toJSON()).toBeNull();
  });

  it('still renders inside a DIFFERENT lane’s tab', () => {
    const renderer = render(
      <PostLaneChip lane={laneOf('tab')} authorHandle="nate" feedDescriptor="lane|lane-2" />,
    );
    expect(renderer.toJSON()).not.toBeNull();
  });

  it('yields its space before the @handle does', () => {
    const renderer = render(
      <PostLaneChip lane={laneOf('tab')} authorHandle="nate" feedDescriptor="for_you" />,
    );
    // The identity line ranks the handle at 10 and the name/time at 0, so the
    // chip has to shrink harder than any of them or it pushes the handle out.
    expect(linkOrNull(renderer)?.props.style.flexShrink).toBeGreaterThan(10);
    expect(linkOrNull(renderer)?.props.style.minWidth).toBe(0);
  });
});
