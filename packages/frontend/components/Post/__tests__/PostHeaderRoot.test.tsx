jest.mock('@oxy.so/bloom/agent-avatar', () => ({
  parseAvatarCharacter: jest.requireActual(
    require('node:path').join(
      require.resolve('@oxy.so/bloom/package.json'),
      '../src/agent-avatar/character.ts',
    ),
  ).parseAvatarCharacter,
  avatarCharacterInColor: jest.requireActual(
    require('node:path').join(
      require.resolve('@oxy.so/bloom/package.json'),
      '../src/agent-avatar/character.ts',
    ),
  ).avatarCharacterInColor,
  useAvatarRendererCapabilities: () => ({ sharedLiveRendering: true }),
}));
import { StyleSheet } from 'react-native';
import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer';

import PostHeader from '../PostHeader';
// The subject draws language text, whose Painted leaf reads Bloom's theme from the app's provider.
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

/**
 * The header's root is ONE node, and it carries both jobs.
 *
 * It used to be two nested `View`s with a single child between them: an outer
 * one holding `paddingHorizontal` and an inner one holding the row layout.
 * Padding and `flex-row` do not interact, so the pair drew exactly what one node
 * draws — but a react-native primitive is not free here. Metro's NativeWind
 * resolver (`withNativewind` defaults `globalClassNamePolyfill: true`, and
 * metro.config.js does not override it) rewrites every `react-native` import to
 * `react-native-css/components`, so each primitive is an interop component: two
 * `useContext`, two `useState`, an effect and a rule evaluation, per post, per
 * mount, className or not.
 *
 * Both halves are needed. Alone, "one root node" is satisfied by a header that
 * dropped the caller's padding; alone, "the padding is applied" is satisfied by
 * the nested pair this test exists to forbid.
 */

jest.mock('@oxy.so/bloom/icons', () => ({
  ...jest.requireActual('@oxy.so/bloom/icons'),
  RiChat3Fill: 'RiChat3Fill',
  RiMoreFill: 'RiMoreFill',
}));
jest.mock('@/components/ui/LiveAvatar', () => ({ LiveAvatar: 'LiveAvatar' }));
jest.mock('@oxy.so/bloom/avatar-group', () => ({ AvatarGroup: 'AvatarGroup' }));
jest.mock('../../UserName', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  const { Embed } =
    jest.requireActual<typeof import('@oxy.so/bloom-language')>('@oxy.so/bloom-language');
  // UserName is a language view: the stand-in is a node holding a host element of its name.
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => Embed(createElement('UserName', props)),
  };
});
jest.mock('@oxy.so/bloom/toast', () => ({ toast: () => undefined }));
jest.mock('@oxy.so/bloom/theme', () => {
  const theme = { colors: { textSecondary: '#8899a6' } };
  return {
    ...jest.requireActual('@oxy.so/bloom/theme'),
    useTheme: () => theme,
    readThemePaint: () => ({ theme, paint: theme.colors }),
  };
});
jest.mock('@/components/AccountBadge', () => ({ AccountBadge: () => null }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// `@oxy.so/core` ships ESM and is not transformed in this suite; the header only
// reaches it for the handle, and this is its rule for a local account.
jest.mock('@oxy.so/core', () => ({
  ...jest.requireActual('@oxy.so/core'),
  getNormalizedUserHandle: (user: { username?: string }) => user?.username ?? null,
}));

it('renders one root node carrying both the padding and the row layout', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        {
          <PostHeader
            user={{ displayName: 'Nate Isern', handle: 'nate' }}
            date="2026-08-01T10:00:00.000Z"
            paddingHorizontal={12}
          />
        }
      </BloomThemeProvider>,
    );
  });
  if (!renderer) throw new Error('render produced no tree');
  // The header is the theme provider's one child.
  const provider = renderer.toJSON() as ReactTestRendererJSON;
  const root = provider.children?.[0];
  if (!root || typeof root === 'string' || provider.children?.length !== 1)
    throw new Error('expected a single root');

  // The language writes a horizontal padding as its two logical edges.
  expect(StyleSheet.flatten(root.props.style)).toMatchObject({
    paddingStart: 12,
    paddingEnd: 12,
    flexDirection: 'row',
  });

  // The avatar and the content column are the root's OWN children — there is
  // no single-child View between them and the padding.
  const childTypes = (root.children ?? []).map((c) =>
    typeof c === 'string' ? 'text' : (c as { type: string }).type,
  );
  expect(childTypes).toContain('LiveAvatar');

  act(() => renderer?.unmount());
});

it('stacks the focused handle below the name and omits the relative timestamp', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        {
          <PostHeader
            detail
            user={{ displayName: 'Nate Isern', handle: 'nate' }}
            date="2026-08-01T10:00:00.000Z"
          />
        }
      </BloomThemeProvider>,
    );
  });
  if (!renderer) throw new Error('render produced no tree');
  const json = JSON.stringify(renderer.toJSON());
  expect(json).toContain('@nate');
  expect(json).not.toContain('·');
  const styleOf = (node: { props: { style?: unknown } }) =>
    StyleSheet.flatten(node.props.style as never) ?? {};
  const column = renderer.root.findAll(
    (node) =>
      typeof node.type === 'string' &&
      styleOf(node).alignItems === 'flex-start' &&
      styleOf(node).flexDirection !== 'row',
  )[0];
  expect(column).toBeDefined();
  const nameRow = column.findAll(
    (node) =>
      typeof node.type === 'string' &&
      styleOf(node).flexDirection === 'row' &&
      styleOf(node).alignItems === 'center',
  )[0];
  expect(nameRow.findAll((node) => node.props.name === 'Nate Isern').length).toBeGreaterThan(0);
  expect(nameRow.findAll((node) => node.children.includes('@nate'))).toHaveLength(0);
  act(() => renderer?.unmount());
});
