import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';

import { ChromeFab } from '@/components/ChromeFab';

/**
 * The FAB fades off the SAME shared value the bottom bar's minimize and the
 * home/explore headers' translate are driven by.
 *
 * That is the whole point of the component, and it is a regression test for two
 * shipped attempts at doing it the other way. Bloom published the bar's collapse
 * through its layout registry — first as a live height, then as a boolean — and
 * both felt wrong on a device: the bar animates on the UI thread while a React
 * consumer arrives via `runOnJS` plus two render passes, so the FAB started one
 * to three frames late, worst exactly while scrolling. Reading the shared value
 * directly is what removes the lag, because nothing crosses a thread.
 *
 * If this ever goes back through React state, this suite still passes — it can
 * only assert the mapping — so the guard that matters is the one in
 * `ChromeFab`'s own doc comment. What IS asserted here is the mapping itself and
 * the input-blocking, both of which are easy to get wrong silently.
 */
// Reanimated's worklet runtime is not initialized under jest-expo, so the thin
// surface this component uses is mocked the same way
// `context/__tests__/BottomBarVisibilityContext.test.tsx` does it: shared values
// are plain mutable holders and `useAnimatedStyle` just runs its worklet body,
// which under jest is an ordinary function — so the real mapping is exercised.
const mockHidden = { value: 0 };

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const { useEffect, useRef } = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: { View },
    useAnimatedStyle: (fn: () => Record<string, unknown>) => fn(),
    // In an EFFECT, never in render: every real caller sets state from the
    // reaction, and doing that during render is an infinite loop.
    useAnimatedReaction: (prepare: () => unknown, react: (c: unknown, p: unknown) => void) => {
      const previous = useRef<unknown>(null);
      const current = prepare();
      useEffect(() => {
        if (Object.is(current, previous.current)) return;
        const before = previous.current;
        previous.current = current;
        react(current, before);
      });
    },
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  };
});

jest.mock('@/context/BottomBarVisibilityContext', () => ({
  useBottomBarHidden: () => mockHidden,
}));

jest.mock('@oxyhq/bloom/fab', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Fab: () => <View testID="inner-fab" /> };
});

function Harness({ hidden }: { hidden: number }) {
  mockHidden.value = hidden;
  return <ChromeFab onPress={() => {}} icon={null} accessibilityLabel="New post" />;
}

/** The Animated.View the fade rides on: the inner FAB's nearest styled ancestor. */
function wrapperProps(root: ReactTestInstance) {
  const inner = root.findAll((n) => n.props?.testID === 'inner-fab')[0];
  let node = inner?.parent;
  while (node && node.props?.style === undefined) node = node.parent;
  return node?.props ?? {};
}

function renderAt(hidden: number) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(<Harness hidden={hidden} />);
  });
  return wrapperProps(tree!.root);
}

describe('ChromeFab', () => {
  it('is fully opaque while the chrome is shown', () => {
    expect(renderAt(0).style).toMatchObject({ opacity: 1 });
  });

  it('tracks the chrome continuously rather than snapping', () => {
    // `hidden` is a CONTINUOUS 0..1 integration of scroll, not a flag — the FAB
    // has to interpolate off it the way the headers do, or it would step while
    // they slide.
    expect(renderAt(0.4).style).toMatchObject({ opacity: 0.6 });
  });

  it('is invisible and inert once the chrome is fully hidden', () => {
    const props = renderAt(1);
    expect(props.style).toMatchObject({ opacity: 0 });
    // An invisible target that still takes a tap is worse than a visible one.
    expect(props.pointerEvents).toBe('none');
    expect(props.accessibilityElementsHidden).toBe(true);
  });
});
