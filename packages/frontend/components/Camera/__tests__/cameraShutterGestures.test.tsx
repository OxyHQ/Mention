import 'react-native-gesture-handler/jestSetup';
import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { createGestureController } from 'react-native-gesture-handler/jest-utils';

let mockFinishRecording: ((result: { uri: string }) => void) | undefined;
const mockCamera = {
  takePictureAsync: jest.fn(async () => ({ uri: 'file:///photo.jpg' })),
  recordAsync: jest.fn(
    () =>
      new Promise<{ uri: string }>((resolve) => {
        mockFinishRecording = resolve;
      }),
  ),
  stopRecording: jest.fn(() => mockFinishRecording?.({ uri: 'file:///video.mp4' })),
};
jest.mock('expo-camera', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    CameraView: React.forwardRef((props: object, ref) => {
      React.useImperativeHandle(ref, () => mockCamera);
      return React.createElement('CameraView', props);
    }),
    useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()],
    useMicrophonePermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()],
  };
});
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { createAnimatedComponent: (component: unknown) => component, View: 'Animated.View' },
  useAnimatedProps: () => ({}),
  useSharedValue: (initial: unknown) => ({ value: initial }),
  withTiming: (value: unknown) => value,
  useEvent: () => jest.fn(),
  useHandler: () => ({ doDependenciesDiffer: false }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: { error: jest.fn() } }));
jest.mock('@oxy.so/bloom/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/typography', () => ({ Text: 'Text' }));

import { CameraCapture } from '../CameraCapture';

let renderer: TestRenderer.ReactTestRenderer | undefined;
const captured = jest.fn();
function button(label: string) {
  const node = renderer?.root.findAll(
    (entry) =>
      entry.props.accessibilityLabel === label && typeof entry.props.onPress === 'function',
  )[0];
  if (!node) throw new Error(`Missing button: ${label}`);
  return node;
}
function shutter() {
  const node = renderer?.root.findAll((entry) => typeof entry.props.onLongPress === 'function')[0];
  if (!node) throw new Error('Missing shutter');
  return node;
}
function cameraView() {
  const camera = renderer?.root.findAll(
    (node) => typeof node.props.onCameraReady === 'function',
  )[0];
  if (!camera) throw new Error('Missing native camera');
  return camera;
}
function ready() {
  act(() => cameraView().props.onCameraReady());
}
async function mount(mode: 'Photo' | 'Video') {
  act(() => {
    renderer = TestRenderer.create(
      <GestureHandlerRootView>
        <CameraCapture onCaptured={captured} onClose={jest.fn()} />
      </GestureHandlerRootView>,
    );
  });
  if (mode === 'Video') act(() => button('Video').props.onPress());
  return createGestureController('camera-shutter-drag');
}
async function hold() {
  await act(async () => {
    shutter().props.onLongPress();
  });
  ready();
  expect(mockCamera.recordAsync).toHaveBeenCalledTimes(1);
}
async function releasePressable() {
  // Native responder termination on pan activation emits this before finger up.
  await act(async () => {
    shutter().props.onPressOut?.();
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockFinishRecording = undefined;
});
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = undefined;
});

it.each(['Photo', 'Video'] as const)(
  'keeps a %s hold recording through drag takeover, then ends on finger up',
  async (mode) => {
    const pan = await mount(mode);
    act(() => pan.begin());
    await hold();
    act(() => {
      pan.activate();
      pan.update({ translationY: -100 });
    });
    await releasePressable();
    expect(cameraView().props.zoom).toBeGreaterThan(0);
    expect(mockCamera.stopRecording).not.toHaveBeenCalled();
    await act(async () => pan.end());
    expect(cameraView().props.zoom).toBe(0);
    expect(mockCamera.stopRecording).toHaveBeenCalledTimes(1);
    expect(captured).toHaveBeenCalledWith({
      uri: 'file:///video.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
    });
  },
);

it.each(['Photo', 'Video'] as const)(
  'ends a stationary %s hold when the unactivated pan finalizes',
  async (mode) => {
    const pan = await mount(mode);
    act(() => pan.begin());
    await hold();
    await releasePressable();
    await act(async () => pan.fail());
    expect(mockCamera.stopRecording).toHaveBeenCalledTimes(1);
  },
);

it('keeps tap photo separate from hold recording', async () => {
  const pan = await mount('Photo');
  act(() => {
    pan.begin();
    pan.fail();
  });
  await act(async () => {
    shutter().props.onPress();
  });
  expect(mockCamera.recordAsync).not.toHaveBeenCalled();
  expect(captured).toHaveBeenCalledWith({
    uri: 'file:///photo.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
  });
});

it('keeps tap video running after release and stops on the second tap', async () => {
  const pan = await mount('Video');
  act(() => {
    pan.begin();
    pan.fail();
  });
  await act(async () => {
    shutter().props.onPress();
  });
  ready();
  await releasePressable();
  expect(mockCamera.stopRecording).not.toHaveBeenCalled();
  act(() => {
    pan.begin();
    pan.fail();
  });
  await act(async () => {
    shutter().props.onPress();
  });
  expect(mockCamera.stopRecording).toHaveBeenCalledTimes(1);
});

it('stops a held recording on gesture cancellation', async () => {
  const pan = await mount('Photo');
  act(() => pan.begin());
  await hold();
  await act(async () => pan.cancel());
  expect(mockCamera.stopRecording).toHaveBeenCalledTimes(1);
});

it('stops on unmount without delivering a late capture', async () => {
  const pan = await mount('Photo');
  act(() => pan.begin());
  await hold();
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(mockCamera.stopRecording).toHaveBeenCalledTimes(1);
  expect(captured).not.toHaveBeenCalled();
});

it('cancels a released hold before the asynchronous arm can start the camera', async () => {
  const pan = await mount('Video');
  act(() => pan.begin());
  await act(async () => {
    shutter().props.onLongPress();
    pan.fail();
  });
  ready();
  expect(mockCamera.recordAsync).not.toHaveBeenCalled();
  expect(captured).not.toHaveBeenCalled();
});
