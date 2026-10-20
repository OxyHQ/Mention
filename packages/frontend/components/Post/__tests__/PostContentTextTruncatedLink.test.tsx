import type React from 'react';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import PostContentText from '../PostContentText';

// Worklets require a native host; the Markdown renderer itself remains real.
jest.mock('react-native-reanimated', () => {
  const { Animated } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: Animated, useSharedValue: (value: number) => ({ value }) };
});

jest.mock('expo-font', () => ({ useFonts: () => [true, null], isLoaded: () => true }));

const mockOpenExternalLink = jest.fn();
let mockReadMoreAction: 'openPost' | 'expandInline' = 'openPost';

jest.mock('@/lib/navigation/router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: (user: { username?: string }) => user.username ?? null,
}));

jest.mock('@/stores/appearanceStore', () => ({
  useAppearanceStore: (selector: (state: unknown) => unknown) =>
    selector({
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
const LINK_CASES = [
  { source: FULL_URL, destination: FULL_URL },
  {
    source: 'www.example.com/articles/a-very-long-article-slug',
    destination: 'https://www.example.com/articles/a-very-long-article-slug',
  },
  {
    source: 'HTTPS://example.com/articles/a-very-long-article-slug',
    destination: 'HTTPS://example.com/articles/a-very-long-article-slug',
  },
];

describe('PostContentText — truncated link destination', () => {
  beforeEach(() => {
    mockOpenExternalLink.mockReset();
  });

  it.each(
    (['openPost', 'expandInline'] as const).flatMap((mode) =>
      LINK_CASES.map((link) => ({ mode, ...link })),
    ),
  )('opens the complete $source while collapsed in $mode mode', ({ mode, source, destination }) => {
    mockReadMoreAction = mode;
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(
        <BloomThemeProvider>
          <PostContentText content={`${'a'.repeat(250)} ${source}`} postId="post-1" />
        </BloomThemeProvider>,
      );
    });
    if (!renderer) throw new Error('render produced no tree');

    const link = renderer.root.findAll(
      (node) => typeof node.props.onPress === 'function' && node.props.role === 'link',
    )[0];
    if (!link) throw new Error('render produced no pressable truncated URL');

    expect(link.props.children).not.toBe(source);
    act(() => link.props.onPress({ stopPropagation: jest.fn(), preventDefault: jest.fn() }));
    expect(mockOpenExternalLink).toHaveBeenCalledWith(destination);
    act(() => renderer?.unmount());
  });

  it.each(['openPost', 'expandInline'] as const)(
    'renders a clipped mention label with its complete internal link in %s mode',
    (mode) => {
      mockReadMoreAction = mode;
      let renderer: TestRenderer.ReactTestRenderer | undefined;
      act(() => {
        renderer = TestRenderer.create(
          <BloomThemeProvider>
            <PostContentText
              content="Mention, [@Allo](allo) answers too"
              previewChars={11}
              postId="post-1"
            />
          </BloomThemeProvider>,
        );
      });
      if (!renderer) throw new Error('render produced no tree');
      const links = renderer.root.findAll((node) => node.props.href === '/@allo');
      expect(links.length).toBeGreaterThan(0);
      expect(JSON.stringify(renderer.toJSON())).toContain('Al…');
      expect(JSON.stringify(renderer.toJSON())).not.toContain('[@');
      act(() => renderer?.unmount());
    },
  );

  it.each(['openPost', 'expandInline'] as const)(
    'renders a clipped mention label with its complete internal link in %s mode',
    (mode) => {
      mockReadMoreAction = mode;
      let renderer: TestRenderer.ReactTestRenderer | undefined;
      act(() => {
        renderer = TestRenderer.create(
          <BloomThemeProvider>
            <PostContentText
              content="Mention, [@Allo](allo) answers too"
              previewChars={11}
              postId="post-1"
            />
          </BloomThemeProvider>,
        );
      });
      if (!renderer) throw new Error('render produced no tree');
      const links = renderer.root.findAll((node) => node.props.href === '/@allo');
      expect(links.length).toBeGreaterThan(0);
      const rendered = JSON.stringify(renderer.toJSON());
      expect(rendered).toContain('Al…');
      expect(rendered).not.toContain('[@');
      act(() => renderer?.unmount());
    },
  );
});

describe('PostContentText Markdown', () => {
  it('renders composer bold with the shared renderer, including after expansion', () => {
    mockReadMoreAction = 'expandInline';
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      renderer = TestRenderer.create(
        <BloomThemeProvider>
          <PostContentText
            content="Meet **Deck**. Your social world, **your way**."
            previewChars={9}
            postId="post-1"
          />
        </BloomThemeProvider>,
      );
    });
    if (!renderer) throw new Error('render produced no tree');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('**');
    expect(
      renderer.root.findAll((node) => StyleSheet.flatten(node.props.style)?.fontWeight === '600')
        .length,
    ).toBeGreaterThan(0);
    const more = renderer.root.findAll(
      (node) => node.props.children === ' Read more' && typeof node.props.onPress === 'function',
    )[0];
    if (!more) throw new Error('render produced no expansion action');
    act(() => more.props.onPress());
    expect(JSON.stringify(renderer.toJSON())).toContain('your way');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('**');
    act(() => renderer?.unmount());
  });
});
