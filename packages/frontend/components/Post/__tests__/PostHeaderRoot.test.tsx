import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import PostHeader from '../PostHeader';

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

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@/components/ui/LiveAvatar', () => ({ LiveAvatar: 'LiveAvatar' }));
jest.mock('@oxyhq/bloom/avatar-group', () => ({ AvatarGroup: 'AvatarGroup' }));
jest.mock('../../UserName', () => ({ __esModule: true, default: 'UserName' }));
jest.mock('@oxyhq/bloom/toast', () => ({ toast: () => undefined }));
jest.mock('@oxyhq/bloom/theme', () => ({
    useTheme: () => ({ colors: { textSecondary: '#8899a6' } }),
}));
jest.mock('@/components/AccountBadge', () => ({ AccountBadge: () => null }));
jest.mock('@/assets/icons/boost-icon', () => ({ BoostIcon: () => null }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// `@oxyhq/core` ships ESM and is not transformed in this suite; the header only
// reaches it for the handle, and this is its rule for a local account.
jest.mock('@oxyhq/core', () => ({
    getNormalizedUserHandle: (user: { username?: string }) => user?.username ?? null,
}));

it('renders one root node carrying both the padding and the row layout', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
        renderer = TestRenderer.create(
            <PostHeader
                user={{ displayName: 'Nate Isern', handle: 'nate' }}
                date="2026-08-01T10:00:00.000Z"
                paddingHorizontal={12}
            />,
        );
    });
    if (!renderer) throw new Error('render produced no tree');
    const root = renderer.toJSON();
    if (root === null || Array.isArray(root)) throw new Error('expected a single root');

    expect(root.props.style).toEqual({ paddingHorizontal: 12 });
    expect(root.props.className).toContain('flex-row');

    // The avatar and the content column are the root's OWN children — there is
    // no single-child View between them and the padding.
    const childTypes = (root.children ?? []).map((c) =>
        typeof c === 'string' ? 'text' : (c as { type: string }).type,
    );
    expect(childTypes).toContain('LiveAvatar');

    act(() => renderer?.unmount());
});
