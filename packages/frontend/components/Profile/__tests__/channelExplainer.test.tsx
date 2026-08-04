import React from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

/**
 * The marker beside a channel's name opens the explainer ON THE CHANNEL PAGE.
 *
 * `AccountBadge.test.tsx` proves the badge honours the channel opt-in and that a
 * source scan keeps every other surface off it. (It also owns the only mentions
 * of the prop's NAME outside production code — that scan is an allow-list, so a
 * second test writing it down would read as a new surface arming the marker.)
 * Neither is the thing a reader experiences: between the opt-in and the badge
 * sit `ChannelHeader` and
 * `UserName`, and a prop dropped in either forwards nothing while both of those
 * suites stay green. So this one renders the REAL chain — the header the channel
 * route mounts, the real `UserName`, the real `AccountBadge` — and presses the
 * marker.
 *
 * The control is the same chain with `kind="channel"` and no opt-in, which is
 * exactly the call every other surface makes (a post header, a who-to-follow
 * row, a search result). Without it, "armed on the channel page" and "armed
 * wherever a channel is named" are the same passing run.
 *
 * Mocks below are leaves only — the avatar, the icon font, the theme, the
 * clipboard — kept out because they drag untransformed ESM or native modules
 * into the graph, not because they carry any part of the answer.
 */

const mockShowChannelInfo = jest.fn();

jest.mock('@/components/Channels/ChannelInfoDialog', () => ({
  showChannelInfo: () => mockShowChannelInfo(),
}));

jest.mock('@/components/ZoomableAvatar', () => ({ ZoomableAvatar: () => null }));
jest.mock('@/components/Profile/PrivateBadge', () => ({ PrivateBadge: () => null }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({ colors: { text: '#000000', primary: '#0000ff' } }),
}));
jest.mock('@oxyhq/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

// Host-string stand-ins so "which marker" is read off the render rather than
// re-derived from the props the test passed in.
jest.mock('@/assets/icons/channel-icon', () => ({ ChannelIcon: 'ChannelIcon' }));
jest.mock('@/assets/icons/fediverse-icon', () => ({ FediverseIcon: 'FediverseIcon' }));
jest.mock('@/assets/icons/verified-icon', () => ({ VerifiedIcon: 'VerifiedIcon' }));
jest.mock('@/assets/icons/agent-icon', () => ({ AgentIcon: 'AgentIcon' }));
jest.mock('@/assets/icons/automated-icon', () => ({ AutomatedIcon: 'AutomatedIcon' }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const catalog: Record<string, unknown> = require('@/locales/en.json');
      const resolved = key
        .split('.')
        .reduce<unknown>(
          (node, part) =>
            node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
          catalog,
        );
      return typeof resolved === 'string' ? resolved : `MISSING_I18N_KEY:${key}`;
    },
  }),
}));

// eslint-disable-next-line import/first
import { ChannelHeader } from '@/components/Profile/ChannelHeader';
// eslint-disable-next-line import/first
import UserName from '@/components/UserName';
// eslint-disable-next-line import/first
import enStrings from '@/locales/en.json';

const CHANNEL_LABEL = enStrings.channels.badge.a11yLabel;

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/** The channel marker, wherever it ended up in the tree. */
function marker(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) =>
      typeof node.type === 'string' && node.props?.accessibilityLabel === CHANNEL_LABEL,
    { deep: true },
  );
}

function pressHandlers(renderer: ReactTestRenderer): ((event?: unknown) => void)[] {
  const unique = new Set<(event?: unknown) => void>();
  renderer.root
    .findAll((node) => typeof node.props?.onPress === 'function', { deep: true })
    .forEach((node) => unique.add(node.props.onPress));
  return [...unique];
}

beforeEach(() => {
  mockShowChannelInfo.mockClear();
});

describe('the channel page arms the marker beside the name', () => {
  it('renders it as a button and opens the explainer when it is pressed', () => {
    const renderer = render(
      <ChannelHeader
        displayName="The Daily"
        username="thedaily"
        isPrivate={false}
        UserNameComponent={UserName}
      />,
    );

    const found = marker(renderer);
    expect(found).toHaveLength(1);
    expect(found[0].props.accessibilityRole).toBe('button');

    expect(mockShowChannelInfo).not.toHaveBeenCalled();
    TestRenderer.act(() => {
      pressHandlers(renderer).forEach((press) => press());
    });
    expect(mockShowChannelInfo).toHaveBeenCalledTimes(1);
  });
});

describe('every other surface that names a channel leaves the marker alone', () => {
  it('renders the SAME marker as a plain image with no handler', () => {
    // The `UserName` call a post header, a who-to-follow row and a search result
    // all make: the account's kind, no opt-in.
    const renderer = render(<UserName name="The Daily" handle="thedaily" kind="channel" />);

    const found = marker(renderer);
    // Positive control — inert is not "absent", and the whole point of this file
    // is that the two are told apart.
    expect(found).toHaveLength(1);
    expect(found[0].props.accessibilityRole).toBe('image');

    TestRenderer.act(() => {
      pressHandlers(renderer).forEach((press) => press());
    });
    expect(mockShowChannelInfo).not.toHaveBeenCalled();
  });
});
