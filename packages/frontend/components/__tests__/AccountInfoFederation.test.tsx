import React from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

/**
 * The About screen's federation section: the SAME title and icon for every
 * non-Oxy account (no "Bluesky" / "Instagram" section), while its rows still
 * say where the account lives — the network by name, the handle, and the link
 * to the original profile.
 *
 * Bloom's settings list and the screen's chrome are host strings, so the
 * section's title and each row's icon/title/value are read off the render.
 */

const mockProfile: { current: Record<string, unknown> | null } = { current: null };

// Same stand-in as `utils/__tests__/federationInfo.test.ts` (core ships ESM only).
jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: ({ username, instance }: { username?: string; instance?: string }) =>
    username && !username.includes('@') && instance ? `${username}@${instance}` : username,
}));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: 'PageHeader' }));
jest.mock('@oxy.so/bloom/avatar', () => ({ Avatar: 'Avatar' }));
jest.mock('@oxy.so/bloom/settings-list', () => ({
  SettingsListGroup: 'SettingsListGroup',
  SettingsListItem: 'SettingsListItem',
}));
jest.mock('@oxy.so/bloom/theme', () => ({ BloomColorScope: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: 'Loading' }));
jest.mock('expo-router', () => ({ Redirect: 'Redirect' }));
jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));
jest.mock('@/hooks/useAccountCategoryLabel', () => ({ useAccountCategoryLabel: () => (id: string) => id }));
jest.mock('@/components/UserName', () => ({ __esModule: true, default: 'UserName' }));
jest.mock('@/components/settings/RowIcon', () => ({ RowIcon: 'RowIcon' }));
jest.mock('@/assets/icons/fediverse-icon', () => ({ FediverseIcon: 'FediverseIcon' }));
jest.mock('@/assets/icons/verified-icon', () => ({ VerifiedIcon: 'VerifiedIcon' }));
jest.mock('@/assets/icons/calendar-month-icon', () => ({ CalendarMonthIcon: 'CalendarMonthIcon' }));
jest.mock('@/assets/icons/external-link-icon', () => ({ ExternalLinkIcon: 'ExternalLinkIcon' }));
jest.mock('@/components/Fediverse/FediverseInfoDialog', () => ({ showFediverseInfo: jest.fn() }));
jest.mock('@/utils/openExternalLink', () => ({ openExternalLink: jest.fn() }));
jest.mock('@/components/Profile/ProfileUnavailable', () => ({ ProfileUnavailable: 'ProfileUnavailable' }));
jest.mock('@/components/Profile/hooks/useRoutedProfileUsername', () => ({ useRoutedProfileUsername: () => 'someone' }));
jest.mock('@/components/Profile/hooks/useProfileAccount', () => ({
  useProfileAccount: () => ({
    profileData: mockProfile.current,
    loading: false,
    notFound: false,
    refresh: jest.fn(),
    colorName: undefined,
  }),
  useProfileCanonicalHref: () => null,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      const catalog: Record<string, unknown> = require('@/locales/en.json');
      return typeof catalog[key] === 'string' ? catalog[key] : options?.defaultValue ?? key;
    },
  }),
}));

// eslint-disable-next-line import/first
import { AccountInfoScreen } from '../AccountInfoScreen';
// eslint-disable-next-line import/first
import enStrings from '@/locales/en.json';

function render(profile: Record<string, unknown>): ReactTestRenderer {
  mockProfile.current = {
    id: 'p1',
    username: profile.username,
    design: { displayName: 'Someone' },
    isFederated: true,
    ...profile,
  };
  let renderer!: ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(<AccountInfoScreen routedFamily="person" />);
  });
  return renderer;
}

function federationSection(renderer: ReactTestRenderer): ReactTestInstance {
  const [section] = renderer.root.findAll(
    (node) => node.type === ('SettingsListGroup' as unknown) && node.props.footer !== undefined
      && node.findAll((child) => child.props?.title === enStrings['fediverse.about.network']).length > 0,
  );
  return section;
}

function row(section: ReactTestInstance, title: string): ReactTestInstance {
  return section.find((node) => node.type === ('SettingsListItem' as unknown) && node.props.title === title);
}

describe('AccountInfoScreen — one Fediverse section for every non-Oxy account', () => {
  it.each([
    ['ActivityPub', { username: 'alice', instance: 'mastodon.social', actorUri: 'https://mastodon.social/users/alice' }, 'networkActivityPub', 'https://mastodon.social/users/alice'],
    ['Bluesky', { username: 'alice.bsky.social', instance: 'bsky.social', actorUri: 'did:plc:abc123' }, 'networkBluesky', 'https://bsky.app/profile/did:plc:abc123'],
    ['Instagram (Graph API)', { username: 'zuck', instance: 'instagram.com', actorUri: 'instagram-graph:1784140' }, 'networkInstagram', 'https://www.instagram.com/zuck/'],
  ] as const)('%s: generic title and icon; the rows still name the network and link out', (_case, profile, networkKey, original) => {
    const section = federationSection(render({ ...profile }));

    expect(section.props.title).toBe(enStrings['fediverse.about.title']);
    const network = row(section, enStrings['fediverse.about.network']);
    expect(network.props.icon.type).toBe('FediverseIcon');
    expect(network.props.value).toBe(enStrings[`fediverse.about.${networkKey}`]);

    // Kept: the link to the ORIGINAL profile.
    const view = row(section, enStrings['fediverse.about.viewOriginal']);
    const { openExternalLink } = jest.requireMock('@/utils/openExternalLink') as { openExternalLink: jest.Mock };
    openExternalLink.mockClear();
    TestRenderer.act(() => view.props.onPress());
    expect(openExternalLink).toHaveBeenCalledWith(original);
  });

  it('draws no federation section for an Oxy account', () => {
    const renderer = render({ username: 'oxyuser', isFederated: false });
    expect(federationSection(renderer)).toBeUndefined();
  });
});
