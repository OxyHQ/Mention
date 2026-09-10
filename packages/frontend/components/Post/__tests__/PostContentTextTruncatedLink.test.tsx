import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import PostContentText from '../PostContentText';

const mockOpenExternalLink = jest.fn();
let mockReadMoreAction: 'openPost' | 'expandInline' = 'openPost';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: (user: { username?: string }) => user.username ?? null,
}));

jest.mock('@/stores/appearanceStore', () => ({
  useAppearanceStore: (selector: (state: unknown) => unknown) => selector({
    mySettings: {
      appearance: {
        postTextExpand: 'default',
        postReadMoreAction: mockReadMoreAction,
      },
    },
  }),
}));

jest.mock('@/components/ProfileHoverCard', () => ({
  ProfileHoverCard: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/utils/openExternalLink', () => ({
  openExternalLink: (...args: unknown[]) => mockOpenExternalLink(...args),
}));

const FULL_URL = 'https://example.com/articles/a-very-long-article-slug';
const LONG_POST = `${'a'.repeat(250)} ${FULL_URL}`;

describe('PostContentText — truncated link destination', () => {
  beforeEach(() => {
    mockOpenExternalLink.mockReset();
  });

  it.each(['openPost', 'expandInline'] as const)(
    'opens the complete URL while the post is collapsed in %s mode',
    (mode) => {
      mockReadMoreAction = mode;
      let renderer: TestRenderer.ReactTestRenderer | undefined;
      act(() => {
        renderer = TestRenderer.create(
          <PostContentText content={LONG_POST} postId="post-1" />,
        );
      });
      if (!renderer) throw new Error('render produced no tree');

      const link = renderer.root.findAll(
        (node) => typeof node.props.onPress === 'function' &&
          typeof node.props.children === 'string' &&
          node.props.children.startsWith('https://'),
      )[0];
      if (!link) throw new Error('render produced no pressable truncated URL');

      expect(link.props.children).not.toBe(FULL_URL);
      act(() => link.props.onPress());
      expect(mockOpenExternalLink).toHaveBeenCalledWith(FULL_URL);
      act(() => renderer?.unmount());
    },
  );
});
