import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * What the camera shows when it is not allowed to be a camera.
 *
 * ALSO OFF THE "NEEDS A DEVICE" LIST. The reported hazard was "a reader who
 * refuses gets a black screen with no explanation", and that is a question about
 * which branch renders for which permission object — three states, all of them
 * reachable from a test, none of them needing a sensor.
 *
 * The third state is the one worth the file on its own. iOS stops showing the
 * system prompt after the reader has refused twice, and `canAskAgain` goes
 * false. An "Allow camera" button then does NOTHING when pressed — no prompt, no
 * error, no change — which is a worse screen than the black one it replaced. So
 * that state must offer a way OUT instead.
 *
 * `permission === null` is a fourth state and is NOT "denied": the module has
 * simply not answered yet. Explaining the refusal there would show the apology
 * to someone who has not been asked.
 */

const mockRequestPermission = jest.fn();
let mockPermission: { granted: boolean; canAskAgain: boolean } | null = null;

jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [mockPermission, mockRequestPermission],
  useMicrophonePermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()],
}));

/**
 * Reanimated, following `TabsPager.test.tsx`: importing the real one pulls in
 * `react-native-worklets`, whose native module is not there under jest and
 * fails the whole suite at import. None of the branches below animates
 * anything — the progress arc only exists while recording.
 */
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { createAnimatedComponent: (component: unknown) => component, View: 'Animated.View' },
  useAnimatedProps: () => ({}),
  useSharedValue: (initial: unknown) => ({ value: initial }),
  withTiming: (value: unknown) => value,
  // `GestureDetector` reaches for these two directly.
  useEvent: () => jest.fn(),
  useHandler: () => ({ doDependenciesDiffer: false }),
}));

/**
 * i18n, as the fallback it already was.
 *
 * With no i18next instance mounted, `useTranslation` warns and falls back to
 * each call's `defaultValue` — which the component supplies for every string, so
 * that is what these cases were reading anyway. Stubbing it makes that explicit,
 * and makes the limit explicit too: THESE ASSERTIONS ARE ABOUT WHICH BRANCH
 * RENDERS, not about the contents of the locale files.
 */
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

/**
 * `@/components/ui/Button` reaches `@oxy.so/bloom/theme`, which jest cannot parse
 * (untransformed ESM in `node_modules`). It renders its children through, and
 * children — the words on the screen — are exactly what these cases are about,
 * so a stub that does the same measures the same thing.
 */
jest.mock('@/components/ui/Button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => children,
}));

import { CameraCapture } from '../CameraCapture';

/** Every string the tree renders, flattened — the screen as a reader reads it. */
function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  const strings: string[] = [];
  const walk = (node: TestRenderer.ReactTestRendererJSON | string | null) => {
    if (node === null) return;
    if (typeof node === 'string') {
      strings.push(node);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  const tree = renderer.toJSON();
  for (const root of Array.isArray(tree) ? tree : [tree]) walk(root);
  return strings.join(' | ');
}

function mount() {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<CameraCapture onCaptured={jest.fn()} onClose={jest.fn()} />);
  });
  return renderer!;
}

afterEach(() => {
  mockRequestPermission.mockReset();
  mockPermission = null;
});

describe('before the permission module has answered', () => {
  it('says nothing at all, rather than apologising to someone who was never asked', () => {
    mockPermission = null;
    const renderer = mount();

    expect(textOf(renderer)).toBe('');
    act(() => renderer.unmount());
  });
});

describe('when the reader has refused', () => {
  it('EXPLAINS itself instead of showing a black screen', () => {
    // The reported hazard, in one assertion.
    mockPermission = { granted: false, canAskAgain: true };
    const renderer = mount();

    const text = textOf(renderer);
    expect(text).toContain('Let Mention use the camera');
    expect(text).toContain('only posted when you choose to');
    act(() => renderer.unmount());
  });

  it('offers to ask again while asking again would do something', () => {
    mockPermission = { granted: false, canAskAgain: true };
    const renderer = mount();

    expect(textOf(renderer)).toContain('Allow camera');
    expect(textOf(renderer)).not.toContain('Close');
    act(() => renderer.unmount());
  });

  it('offers a way OUT once the system will no longer prompt', () => {
    // `canAskAgain` false means the button would open nothing. A control that
    // silently does nothing is worse than the black screen this replaced.
    mockPermission = { granted: false, canAskAgain: false };
    const renderer = mount();

    const text = textOf(renderer);
    expect(text).toContain('Close');
    expect(text).not.toContain('Allow camera');
    act(() => renderer.unmount());
  });

  it('never touches the camera while it is refused', () => {
    mockPermission = { granted: false, canAskAgain: true };
    const renderer = mount();

    // Asking on RENDER would re-prompt on every re-render; the button asks.
    expect(mockRequestPermission).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe('when the reader has allowed it', () => {
  it('drops the explanation and shows the camera', () => {
    mockPermission = { granted: true, canAskAgain: true };
    const renderer = mount();

    const text = textOf(renderer);
    expect(text).not.toContain('Let Mention use the camera');
    // The capture surface's own chrome instead: the mode carousel says what the
    // shutter is for, and it only exists on the granted path.
    expect(text).toContain('Photo');
    expect(text).toContain('Video');
    act(() => renderer.unmount());
  });
});
