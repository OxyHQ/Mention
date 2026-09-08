import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import PostActions from '../PostActions';

/**
 * What the action bar costs to put on screen, pinned as structure.
 *
 * The bar is mounted once per feed row and a fling mounts rows continuously, so
 * a node that draws nothing is not free: under NativeWind's global class-name
 * polyfill (`withNativewind` defaults `globalClassNamePolyfill: true`, and
 * metro.config.js does not override it) Metro rewrites every `react-native`
 * import to `react-native-css/components`, so EVERY primitive here is an interop
 * component — two `useContext`, two `useState`, an effect and a rule evaluation
 * — whether or not it carries a className. Two nodes were drawing nothing:
 *
 *  1. A wrapping `<View>` around the whole bar. `PostItem` — the only caller —
 *     already renders it inside a padded column, so the wrapper laid out
 *     nothing that its parent did not already lay out.
 *  2. The engagement summary was a `PressableScale`: a reanimated shared value,
 *     an animated style and a `Pressability` instance, permanently `disabled`,
 *     because no caller ever passed `onLikesPress`/`onBoostsPress`. Those props
 *     are gone; the counters that DO open a list live on `<PostDetailStats>`.
 *
 * The second assertion is the control: it is not enough that the summary stops
 * being pressable, it must still be THERE and still say what it said.
 */

jest.mock('@oxyhq/bloom/theme', () => ({
    useTheme: () => ({
        colors: { primary: '#1d9bf0', success: '#00ba7c', textSecondary: '#8899a6' },
    }),
}));
jest.mock('@oxyhq/bloom/hooks', () => ({ useHaptics: () => () => undefined }));
jest.mock('@oxyhq/bloom/loading', () => ({ SpinnerIcon: () => null }));
jest.mock('@oxyhq/bloom/avatar', () => ({ Avatar: 'Avatar' }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@/hooks/useVoteStyle', () => ({ useVoteStyle: () => 'icons' }));

// Host element names, so a `PressableScale` reintroduced anywhere in this bar
// shows up in the tree by name instead of dissolving into the `View` it renders.
jest.mock('@oxyhq/bloom/pressable-scale', () => ({ PressableScale: 'PressableScale' }));

// Icons are react-native-svg subtrees and say nothing about the bar's shape.
jest.mock('@/assets/icons/comment-icon', () => ({ CommentIcon: () => null }));
jest.mock('@/assets/icons/boost-icon', () => ({ BoostIcon: () => null, BoostIconActive: () => null }));
jest.mock('@/assets/icons/share-icon', () => ({ ShareIcon: () => null }));
jest.mock('@/assets/icons/bookmark-icon', () => ({ Bookmark: () => null, BookmarkActive: () => null }));
jest.mock('@/assets/icons/analytics-icon', () => ({ AnalyticsIcon: () => null }));
jest.mock('@/lib/animations/AnimatedLikeIcon', () => ({ AnimatedLikeIcon: () => null }));
jest.mock('@/lib/animations/CountWheel', () => ({ CountWheel: () => null }));

const noop = () => undefined;

function renderBar() {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
        renderer = TestRenderer.create(
            <PostActions
                engagement={{ replies: 2, likes: 3 }}
                onReply={noop}
                onBoost={noop}
                onLike={noop}
                onSave={noop}
                onShare={noop}
            />,
        );
    });
    if (!renderer) throw new Error('render produced no tree');
    return renderer;
}

describe('PostActions shape', () => {
    it('renders the icon row and the summary as siblings, with no wrapper around them', () => {
        const renderer = renderBar();
        const roots = renderer.toJSON();

        // A fragment root: react-test-renderer returns an ARRAY when the
        // component renders siblings, and a single object when it wraps them.
        expect(Array.isArray(roots)).toBe(true);
        expect(roots).toHaveLength(2);

        act(() => renderer.unmount());
    });

    it('still shows the reply summary, and nothing in it is pressable', () => {
        const renderer = renderBar();

        const summaries = renderer.root.findAll(
            (node) => node.children.some((c) => c === '2 replies'),
            { deep: false },
        );
        expect(summaries).toHaveLength(1);

        // The bar's own buttons are still PressableScale; the summary is not.
        const summaryRoot = renderer.root.findAll(
            (node) => typeof node.props?.className === 'string'
                && node.props.className.includes('mt-2'),
            { deep: false },
        );
        expect(summaryRoot).toHaveLength(1);
        expect(summaryRoot[0].type).not.toBe('PressableScale');
        expect(summaryRoot[0].findAllByType('PressableScale' as never)).toHaveLength(0);

        act(() => renderer.unmount());
    });
});
