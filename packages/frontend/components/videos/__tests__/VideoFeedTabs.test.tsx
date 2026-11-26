import TestRenderer, { act } from 'react-test-renderer';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { Screen } from '@oxy.so/bloom/screen';
import { BloomColorScope } from '@oxy.so/bloom/theme';
import { Embed, Header, defineTokens, toElement } from '@oxy.so/bloom-language';
import { VideoFeedTabs } from '../VideoFeedTabs';
import type { VideoFeedTab } from '@/hooks/useVideoFeed';

jest.mock('../FollowingAvatars', () => ({ FollowingAvatars: () => null }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const colors = defineTokens({ color: { black: '#000000' } });

/** The reel's header as videos.tsx places it: the tabs as the floating header's title, over a dark Screen. */
function renderReelHeader(value: VideoFeedTab) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <BloomProvider fonts={false} haptics={false} defaultMode="light">
        <BloomColorScope mode="dark" asChild>
          <Screen
            scroll="auto"
            headerPlacement="overlay"
            contentClearance={0}
            testID="videos-screen"
            header={toElement(
              Header(Embed(<VideoFeedTabs value={value} onValueChange={() => {}} />))
                .testID('videos-header')
                .titleAlign('center')
                .presentation('floating')
                .scrollEdge('always')
                .scrimColor(colors.color.black)
                .scrimFalloff('linear')
                .tone('onImage')
                .onBack(null)
                .inPage(),
            )}
          >
            {null}
          </Screen>
        </BloomColorScope>
      </BloomProvider>,
    );
  });
  return renderer;
}

/** The host view a tab's test ID names (the one carrying its press and role). */
function tabHost(renderer: TestRenderer.ReactTestRenderer, tab: VideoFeedTab) {
  return renderer.root.find(
    (node) => typeof node.type === 'string' && node.props.testID === `video-feed-tab-${tab}`,
  );
}

/** What hides a host or anything above it from a screen reader: a hidden subtree, or no opacity. */
function hiddenBy(node: TestRenderer.ReactTestInstance): string[] {
  const reasons: string[] = [];
  for (let at: TestRenderer.ReactTestInstance | null = node; at; at = at.parent) {
    if (typeof at.type !== 'string') continue;
    const { props } = at;
    if (props.accessibilityElementsHidden === true) reasons.push(`${props.testID}: elementsHidden`);
    if (props.importantForAccessibility === 'no-hide-descendants')
      reasons.push(`${props.testID}: no-hide-descendants`);
    if (props['aria-hidden'] === true) reasons.push(`${props.testID}: aria-hidden`);
    const style = Object.assign({}, ...[props.style].flat(Infinity).filter(Boolean));
    if (style.opacity === 0) reasons.push(`${props.testID}: opacity 0`);
  }
  return reasons;
}

it.each(['videos', 'following'] as const)(
  'announces the %s tab as a selected tab, reachable in the header',
  (value) => {
    const renderer = renderReelHeader(value);
    for (const tab of ['videos', 'following'] as const) {
      const host = tabHost(renderer, tab);
      expect(host.props.accessibilityRole).toBe('tab');
      expect(host.props.accessible).toBe(true);
      expect(host.props.accessibilityState).toEqual({ selected: tab === value });
      // The press is the Pressable's around the host.
      expect(
        renderer.root.findAll(
          (node) =>
            node.props.testID === `video-feed-tab-${tab}` &&
            typeof node.props.onPress === 'function',
        ),
      ).not.toHaveLength(0);
      expect(hiddenBy(host)).toEqual([]);
    }
    act(() => renderer.unmount());
  },
);
