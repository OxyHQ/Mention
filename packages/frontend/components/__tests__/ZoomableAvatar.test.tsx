import TestRenderer, { act } from 'react-test-renderer';
import { ZoomableAvatar } from '../ZoomableAvatar';

const mockAvatar = jest.fn((_props: unknown) => null);
const mockOpen = jest.fn();
const mockGalleryProps = jest.fn((_props: unknown) => undefined);
const mockFileDownload = jest.fn((_client: unknown, _id: string | undefined) => ({}));
const mockImageResolver = jest.fn((id: string, variant: string) =>
  id ? `https://photo.test/${id}/${variant}` : undefined,
);
const mockCapability = jest.fn(() => ({ sharedLiveRendering: true }));
jest.mock('@oxy.so/bloom/avatar', () => ({
  ...jest.requireActual('@oxy.so/bloom/avatar'),
  Avatar: (props: unknown) => mockAvatar(props),
}));
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
  useAvatarRendererCapabilities: () => mockCapability(),
}));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const React = jest.requireActual('react');
  // React Native's own (lazy) exports as OWN properties: a namespace import
  // (`import * as ReactNative`, as Bloom's agent avatar reads Platform) copies only
  // own properties, so a prototype-chained mock would hand it no Platform.
  const mock = Object.defineProperties({}, Object.getOwnPropertyDescriptors(actual));
  Object.defineProperty(mock, 'View', {
    value: React.forwardRef(function MockMeasuredView(props: unknown, ref: unknown) {
      React.useImperativeHandle(ref, () => ({
        measureInWindow: (callback: (...values: number[]) => void) => callback(0, 0, 90, 90),
      }));
      return React.createElement(actual.View, props);
    }),
  });
  return mock;
});
jest.mock('react-native-reanimated', () => ({
  // Reanimated's real exports for what the Bloom language's motion layer reads at load
  // (Easing and the rest); the component's own animation stays inert.
  ...jest.requireActual('react-native-reanimated'),
  __esModule: true,
  default: {
    ...jest.requireActual('react-native-reanimated').default,
    // The measured View: the photo the viewer flies from is an Animated.View.
    View: require('react-native').View,
  },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: unknown) => ({ value }),
  Extrapolation: { CLAMP: 'clamp' },
}));
jest.mock('@oxy.so/bloom/image-resolver', () => ({
  ...jest.requireActual('@oxy.so/bloom/image-resolver'),
  useImageResolver: () => mockImageResolver,
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ oxyServices: {} }),
  useFileDownloadUrl: (client: unknown, id: string | undefined) => mockFileDownload(client, id),
}));
jest.mock('@oxy.so/bloom/zoomable-media-gallery', () => {
  const React = jest.requireActual('react');
  return {
    ZoomableMediaGallery: React.forwardRef(function MockZoomableGallery(
      props: unknown,
      ref: unknown,
    ) {
      mockGalleryProps(props);
      React.useImperativeHandle(ref, () => ({ open: mockOpen }));
      return null;
    }),
  };
});

afterEach(() => {
  mockAvatar.mockClear();
  mockOpen.mockClear();
  mockCapability.mockClear();
  mockFileDownload.mockClear();
  mockImageResolver.mockClear();
});

it('keeps photo zoom and delegates the resting photo to Bloom', async () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <ZoomableAvatar source="human-file" account={{ kind: 'personal' }} size={90} />,
    );
  });
  expect(mockAvatar.mock.lastCall?.[0]).toMatchObject({ account: { kind: 'personal' }, size: 90 });
  await act(async () => {
    tree.root.findAllByProps({ accessibilityLabel: 'Profile avatar' })[0].props.onPress();
  });
  expect(mockOpen).toHaveBeenCalledWith(
    [expect.objectContaining({ uri: expect.stringContaining('/human-file/') })],
    0,
    { x: 0, y: 0, width: 90, height: 90 },
  );
  expect(mockCapability).not.toHaveBeenCalled();
  // The viewer is handed the value that hides the photo while its copy flies:
  // at rest it hides nothing.
  expect(mockGalleryProps.mock.lastCall?.[0]).toMatchObject({ hiddenThumbIndex: { value: -1 } });
  act(() => tree.unmount());
});

it('shows the stored character without clipping or opening a photo, and tolerates invalid saved data', () => {
  const account = {
    kind: 'bot' as const,
    character: {
      shape: 'rounded_head_two_ears',
      eyes: 'oval',
      color: 'teal',
      eyewear: 'none',
      accessory: 'none',
    },
  };
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ZoomableAvatar source="old-file-id" account={account} size={90} />);
  });
  expect(mockAvatar.mock.lastCall?.[0]).toMatchObject({ account, motion: 'always' });
  expect(mockImageResolver).not.toHaveBeenCalled();
  expect(mockFileDownload).toHaveBeenLastCalledWith(expect.anything(), undefined);
  expect(tree.root.findAllByProps({ accessibilityLabel: 'Profile avatar' })[0].props.disabled).toBe(
    true,
  );
  act(() => tree.root.findAllByProps({ accessibilityLabel: 'Profile avatar' })[0].props.onPress());
  expect(mockOpen).not.toHaveBeenCalled();
  act(() => {
    tree.update(
      <ZoomableAvatar
        source="https://photo.test/old.jpg"
        account={{ kind: 'bot', character: { shape: 'bad' } }}
      />,
    );
  });
  // Enabled: the language's press host carries `disabled` only while it is disabled.
  expect(
    tree.root.findAllByProps({ accessibilityLabel: 'Profile avatar' })[0].props.disabled,
  ).toBeFalsy();
  act(() => tree.unmount());
});

it('a failed photo disables zoom, while replacement and late old errors keep the new source usable', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ZoomableAvatar source="https://photo.test/first.jpg" />);
  });
  const props = mockAvatar.mock.lastCall?.[0] as
    | { onImageError: () => void; source: unknown; fallbackSource: unknown }
    | undefined;
  if (!props) throw new Error('Avatar did not render');
  const oldError = props.onImageError;
  act(() => oldError());
  expect(mockAvatar.mock.lastCall?.[0]).toMatchObject({
    source: props.source,
    fallbackSource: props.fallbackSource,
  });
  expect(tree.root.findAllByProps({ accessibilityLabel: 'Profile avatar' })[0].props.disabled).toBe(
    true,
  );
  act(() => tree.update(<ZoomableAvatar source="https://photo.test/second.jpg" />));
  // Enabled: the language's press host carries `disabled` only while it is disabled.
  expect(
    tree.root.findAllByProps({ accessibilityLabel: 'Profile avatar' })[0].props.disabled,
  ).toBeFalsy();
  act(() => oldError());
  // Enabled: the language's press host carries `disabled` only while it is disabled.
  expect(
    tree.root.findAllByProps({ accessibilityLabel: 'Profile avatar' })[0].props.disabled,
  ).toBeFalsy();
  const replacement = mockAvatar.mock.lastCall?.[0] as typeof props;
  if (!replacement) throw new Error('Replacement avatar did not render');
  act(() => replacement.onImageError());
  act(() => oldError());
  expect(tree.root.findAllByProps({ accessibilityLabel: 'Profile avatar' })[0].props.disabled).toBe(
    true,
  );
  expect(mockAvatar.mock.lastCall?.[0]).toMatchObject({ source: replacement.source });
  act(() => tree.unmount());
});

it.each([
  ['https://mention.earth/@alice', 'https://mention.earth/@alice'],
  [undefined, null],
])('passes a safe share URL or disables sharing', async (shareUrl, expected) => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <ZoomableAvatar source="https://media.test/private?token=fixture" shareUrl={shareUrl} />,
    );
  });
  await act(async () => {
    tree.root.findByProps({ accessibilityLabel: 'Profile avatar' }).props.onPress();
  });
  expect(mockOpen).toHaveBeenCalledWith(
    [
      expect.objectContaining({
        uri: 'https://media.test/private?token=fixture',
        shareUrl: expected,
      }),
    ],
    0,
    expect.anything(),
  );
  act(() => tree.unmount());
});
