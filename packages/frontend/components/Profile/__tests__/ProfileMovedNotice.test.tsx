import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { ProfileMovedNotice } from '../ProfileMovedNotice';

/**
 * A federated account that announced a verified `Move` says where it went, and
 * the notice takes the reader to the NEW account's profile here — `/@user@domain`,
 * the person route, not the old account's page or the remote server.
 */

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  router: { push: (href: string) => mockPush(href) },
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; handle?: string }) =>
      (options?.defaultValue ?? '').replace('{{handle}}', options?.handle ?? ''),
  }),
}));

// `profileRoute` imports `@oxy.so/core` (ESM) for helpers this path never calls.
jest.mock('@oxy.so/core', () => ({ getNormalizedUserHandle: () => undefined }));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { textSecondary: '#666' } }) }));
jest.mock('@oxy.so/bloom/icons/RiArrowRightLine', () => ({ RiArrowRightLine: () => null }));

const MOVE = { handle: 'alice@new.example', actorUri: 'https://new.example/users/alice' };

function render(): TestRenderer.ReactTestRenderer {
  let tree: TestRenderer.ReactTestRenderer | null = null;
  act(() => {
    tree = TestRenderer.create(<ProfileMovedNotice movedTo={MOVE} />);
  });
  return tree!;
}

beforeEach(() => mockPush.mockClear());

it('names the new account', () => {
  const tree = render();
  expect(tree.root.findByType(Text).props.children).toBe('This account has moved to @alice@new.example');
});

it('opens the new account on the person route', () => {
  const tree = render();
  act(() => {
    // By role, not by type: NativeWind's interop wraps a className'd Pressable.
    tree.root.findAll((node) => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function')[0]
      .props.onPress();
  });
  expect(mockPush).toHaveBeenCalledWith('/@alice@new.example');
});
