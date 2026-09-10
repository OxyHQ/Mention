import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { CountWheel } from '../CountWheel';
import { AnimatedLikeIcon } from '../AnimatedLikeIcon';

/**
 * The like control on a row nobody has touched yet.
 *
 * Both components staged their animation unconditionally: `CountWheel` always
 * rendered a positioning `View` and an `Animated.View` around the number, and
 * `AnimatedLikeIcon` always rendered a `View` to position two burst rings. On a
 * freshly mounted row — which is every row a fast fling creates — neither
 * animation exists: `CountWheel`'s two `entering` props are `undefined` and its
 * outgoing count is not rendered, and the rings are gated on `isLiked &&
 * shouldAnimate`. So the nodes drew nothing, and a node that draws nothing is
 * not free here: Metro's NativeWind resolver makes every react-native primitive
 * a `react-native-css` interop component, and `Animated.View` adds reanimated's
 * animated-component machinery on top.
 *
 * Each pair below is a shape assertion plus its control — the second half is
 * what stops "render less" from becoming "render nothing", and what pins that
 * the animated structure is still there the moment it is needed.
 */

/**
 * Reanimated's worklet runtime is not initialized under jest-expo, and none of
 * it is what this file measures — the motion belongs to a device. What matters
 * here is that `Animated.View` and `LayoutAnimationConfig` stay DISTINGUISHABLE
 * from a plain `View` in the rendered tree, which is why `Animated.View` is a
 * host name rather than `react-native`'s `View`.
 */
jest.mock('react-native-reanimated', () => {
    // Reanimated's entering/exiting builders are chainable; every method
    // returns the builder, and `lib/animations/entryExit` chains at import time.
    const chain: Record<string, unknown> = new Proxy({}, { get: () => () => chain });
    return {
        __esModule: true,
        default: { View: 'Animated.View' },
        LayoutAnimationConfig: ({ children }: { children: unknown }) => children,
        useReducedMotion: () => false,
        useSharedValue: (v: unknown) => ({ value: v }),
        useAnimatedStyle: (fn: () => object) => fn(),
        withTiming: (v: unknown) => v,
        withSequence: (...v: unknown[]) => v[v.length - 1],
        withDelay: (_d: number, v: unknown) => v,
        Easing: { bezier: () => () => 0 },
        FadeIn: chain,
        FadeOut: chain,
        FadeInDown: chain,
        FadeInUp: chain,
        FadeOutDown: chain,
        FadeOutUp: chain,
    };
});

jest.mock('@oxy.so/bloom/theme', () => ({
    useTheme: () => ({
        colors: { error: '#f4212e', textSecondary: '#8899a6', background: '#ffffff' },
    }),
}));
jest.mock('@/assets/icons/heart-icon', () => ({
    HeartIcon: () => null,
    HeartIconActive: () => null,
}));

/** Host node types, in tree order. */
function hostTypes(element: React.ReactElement) {
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
        renderer = TestRenderer.create(element);
    });
    if (!renderer) throw new Error('render produced no tree');
    const out: string[] = [];
    const walk = (node: unknown) => {
        if (node === null || typeof node !== 'object') return;
        const n = node as { type: string; children: unknown[] | null };
        out.push(n.type);
        for (const child of n.children ?? []) walk(child);
    };
    const root = renderer.toJSON();
    for (const node of Array.isArray(root) ? root : [root]) walk(node);
    act(() => renderer?.unmount());
    return out;
}

describe('CountWheel', () => {
    it('draws an untouched count as one text node', () => {
        expect(hostTypes(<CountWheel likeCount={3} isLiked={false} hasBeenToggled={false} />))
            .toEqual(['Text']);
    });

    it('stages the roll once the reader has toggled the like', () => {
        // The control: without it, "one text node" is also satisfied by a
        // component that dropped the roll animation altogether.
        const types = hostTypes(<CountWheel likeCount={3} isLiked hasBeenToggled />);
        expect(types.filter((t) => t === 'View')).toHaveLength(1);
        expect(types.filter((t) => t === 'Animated.View')).toHaveLength(2);
        expect(types.filter((t) => t === 'Text')).toHaveLength(2);
    });
});

describe('AnimatedLikeIcon', () => {
    it('draws an untouched heart with no positioning wrapper', () => {
        // The heart itself is a mocked svg, so the only host nodes an unliked
        // icon can produce are wrappers — and there must be none.
        expect(hostTypes(<AnimatedLikeIcon isLiked={false} hasBeenToggled={false} />))
            .toEqual([]);
    });

    it('keeps the wrapper while the burst rings are on screen', () => {
        // The control: the rings are absolutely positioned against that wrapper,
        // so dropping it unconditionally would move them onto the action row.
        const types = hostTypes(<AnimatedLikeIcon isLiked hasBeenToggled />);
        expect(types.filter((t) => t === 'View')).toHaveLength(1);
        expect(types.filter((t) => t === 'Animated.View')).toHaveLength(3);
    });
});
