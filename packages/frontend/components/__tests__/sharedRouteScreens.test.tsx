import type { ComponentType } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import * as boundaries from '../sharedRouteScreens';

/**
 * Every shared route screen paints its skeleton, then the screen it loads, with
 * the props the route gave it. Each screen module is stubbed: what is under test
 * is the boundary, not the screens.
 */

jest.mock('@/components/loading/ContentSkeleton', () => ({
  DetailSkeleton: () => 'loading',
  FormSkeleton: () => 'loading',
  ListSkeleton: () => 'loading',
}));

function mockScreen(name: string) {
  return (props: object) => `${name} ${JSON.stringify(props)}`;
}
jest.mock('../AccountInfoScreen', () => ({ AccountInfoScreen: mockScreen('about') }));
jest.mock('../Profile/ConnectionsScreen', () => ({ default: mockScreen('connections') }));
jest.mock('../OperatedAccounts/OperatedAccountsScreen', () => ({
  OperatedAccountsScreen: mockScreen('operated'),
}));
jest.mock('../OperatedAccounts/OperatedAccountSettingsScreen', () => ({
  OperatedAccountSettingsScreen: mockScreen('operated-settings'),
}));
jest.mock('../Commerce/ProfileShop', () => ({ ProfileShop: mockScreen('shop') }));
jest.mock('../Jobs/JobFormFields', () => ({ JobFormFields: mockScreen('job-fields') }));
jest.mock('../WhoToFollowTab', () => ({
  WhoToFollowTab: mockScreen('who-to-follow'),
  NewUsersTab: mockScreen('new-users'),
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// The connections screen and the new-users tab read the route, not props.
const cases: [keyof typeof boundaries, string][] = [
  ['LazyAccountInfoScreen', 'about {"marker":"from-route"}'],
  ['LazyConnectionsScreen', 'connections {}'],
  ['LazyOperatedAccountsScreen', 'operated {"marker":"from-route"}'],
  ['LazyOperatedAccountSettingsScreen', 'operated-settings {"marker":"from-route"}'],
  ['LazyProfileShop', 'shop {"marker":"from-route"}'],
  ['LazyJobFormFields', 'job-fields {"marker":"from-route"}'],
  ['LazyWhoToFollowTab', 'who-to-follow {"marker":"from-route"}'],
  ['LazyNewUsersTab', 'new-users {}'],
];

it.each(cases)(
  '%s shows its skeleton, then its screen with what the route passed',
  async (name, rendered) => {
    const Boundary = boundaries[name] as ComponentType<{ marker: string }>;
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<Boundary marker="from-route" />);
    });
    expect(tree.toJSON()).toBe('loading');

    await act(async () => {});
    expect(tree.toJSON()).toBe(rendered);
  },
);
