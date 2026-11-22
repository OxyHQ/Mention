import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ProfileStats } from '../ProfileStats';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

/** Under Bloom's theme provider: the language paints its text and glyphs from the theme, as the app's provider supplies it. */
function themed(element: React.ReactElement): React.ReactElement {
  return <BloomThemeProvider fonts={false}>{element}</BloomThemeProvider>;
}

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const BASE_PROPS: React.ComponentProps<typeof ProfileStats> = {
  followingCount: 1,
  followerCount: 2,
  postsCount: 3,
  boostsCount: 4,
  repliesCount: 5,
  followingHref: null,
  followersHref: null,
  onPostsPress: jest.fn(),
  onBoostsPress: jest.fn(),
  onRepliesPress: jest.fn(),
};

async function renderedText(props: React.ComponentProps<typeof ProfileStats>): Promise<string[]> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(themed(<ProfileStats {...props} />));
  });
  const text = renderer.root
    .findAll((node) => String(node.type) === 'Text', { deep: true })
    .flatMap((node) => node.children)
    .filter((child): child is string => typeof child === 'string');
  act(() => renderer.unmount());
  return text;
}

describe('ProfileStats reputation', () => {
  it('renders a compact Oxy reputation total for people', async () => {
    const text = await renderedText({ ...BASE_PROPS, reputationTotal: 1234 });

    expect(text).toContain('1.2K');
    expect(text).toContain('profile.stats.reputation');
  });

  it('keeps the stat visible while its balance is unavailable', async () => {
    const text = await renderedText({ ...BASE_PROPS, reputationTotal: null });

    expect(text).toContain('--');
    expect(text).toContain('profile.stats.reputation');
  });

  it('does not add a reputation stat for channels', async () => {
    const text = await renderedText(BASE_PROPS);

    expect(text).not.toContain('profile.stats.reputation');
  });
});

describe('ProfileStats follow-graph totals', () => {
  it('renders a real zero', async () => {
    const text = await renderedText({ ...BASE_PROPS, followerCount: 0 });

    expect(text).toContain('0');
    expect(text).toContain('profile.followers');
  });

  it('hides a total that is unknown instead of rendering 0', async () => {
    const text = await renderedText({
      ...BASE_PROPS,
      followerCount: undefined,
      followingCount: undefined,
    });

    expect(text).not.toContain('profile.followers');
    expect(text).not.toContain('profile.following');
    expect(text).toContain('profile.stats.posts');
  });
});
