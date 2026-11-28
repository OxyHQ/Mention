import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { CaptureReview } from '../CaptureReview';
const mockPlayer = { play: jest.fn(), pause: jest.fn() };
jest.mock('expo-video', () => ({ useVideoPlayer: () => mockPlayer }));
jest.mock('@oxy.so/bloom/video-view', () => ({ VideoView: () => null }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

test('pauses video review during the transfer and resumes after failure', () => {
  const props = {
    capture: { uri: 'file:///clip.mp4', kind: 'video' as const, mimeType: 'video/mp4' },
    onPublish: jest.fn(),
    onAddText: jest.fn(),
    onRetake: jest.fn(),
    busy: false,
    uploadFailed: false,
    publishFailed: false,
  };
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(<CaptureReview {...props} />);
  });
  expect(mockPlayer.play).toHaveBeenCalledTimes(1);
  act(() =>
    renderer.update(
      <CaptureReview {...props} busy uploadProgress={{ phase: 'hash', loaded: 50, total: 100 }} />,
    ),
  );
  expect(mockPlayer.pause).toHaveBeenCalledTimes(1);
  const progress = renderer!.root.findAllByProps({ accessibilityRole: 'progressbar' })[0];
  expect(progress.props.accessibilityLabel).toBe('camera.preparing');
  expect(progress.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 50 });
  act(() => renderer.update(<CaptureReview {...props} uploadFailed />));
  expect(mockPlayer.play).toHaveBeenCalledTimes(2);
  act(() => renderer.unmount());
});
