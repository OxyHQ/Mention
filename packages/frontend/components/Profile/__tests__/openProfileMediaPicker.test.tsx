import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { openProfileMediaPicker } from '../openProfileMediaPicker';

const mockPresent = jest.fn();
const mockLoad = jest.fn();
const mockDismiss = jest.fn();
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/components/loading/ContentSkeleton', () => ({ FormSkeleton: () => null }));
jest.mock('@/utils/sheet', () => ({ presentSheet: (...args: unknown[]) => mockPresent(...args) }));
jest.mock('../MediaPickerSheet', () => {
  mockLoad();
  return {
    MediaPickerSheet: ({
      currentMedia,
      onClose,
    }: {
      currentMedia: { title: string };
      onClose: () => void;
    }) => {
      const React = jest.requireActual<typeof import('react')>('react');
      const { Text: NativeText } =
        jest.requireActual<typeof import('react-native')>('react-native');
      return React.createElement(NativeText, { onPress: onClose }, currentMedia.title);
    },
  };
});

it('loads the picker on demand with the selected media and lets it close the surface', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  expect(mockLoad).not.toHaveBeenCalled();
  openProfileMediaPicker({
    type: 'song',
    syraTrackId: 'track',
    title: 'Selected song',
    artist: 'Artist',
    previewUrl: 'https://example.test/preview',
    startSec: 0,
  });
  expect(mockPresent).toHaveBeenCalledTimes(1);
  expect(mockLoad).not.toHaveBeenCalled();

  const render = mockPresent.mock.calls[0][0];
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(render({ dismiss: mockDismiss }));
  });
  expect(renderer.root.findByType(Text).props.children).toBe('profile.media.title');
  await act(async () => {
    await Promise.resolve();
  });
  const title = renderer.root.findByType(Text);
  expect(title.props.children).toBe('Selected song');
  act(() => title.props.onPress());
  expect(mockDismiss).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
});
