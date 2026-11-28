import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { PostPodcastAttachment } from '../PostPodcastAttachment';
import { syraPodcastCards } from '@/lib/references/syraPodcastCards';

const mockLoad = jest.fn();
let mockVisible = true;
jest.mock('@/lib/references/syraPodcastCards', () => {
  const { VisibleReferenceStore } = jest.requireActual('@/lib/references/VisibleReferenceStore');
  return {
    syraPodcastCards: new VisibleReferenceStore(
      (ids: readonly string[], options: { signal: AbortSignal }) => mockLoad(ids, options),
    ),
  };
});
jest.mock('@oxy.so/bloom/video-playback', () => ({
  useViewableVisible: () => mockVisible,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options: { defaultValue: string }) => options.defaultValue,
  }),
}));
jest.mock('../PodcastCard', () => ({
  PodcastCard: ({ saveButton: _saveButton, ...props }: { saveButton?: unknown }) =>
    require('react').createElement('PodcastCard', props),
}));
jest.mock('../PodcastSaveButton', () => ({ PodcastSaveButton: () => null }));
const legacy = {
  syraPodcastId: 'show',
  title: 'Old copied title',
  artworkUrl: 'https://secret.invalid/old',
  showUrl: 'https://evil.invalid',
  episode: { title: 'Old episode', videoUrl: 'https://secret.invalid/video' },
};
const current = { id: 'show', title: 'Current title', showUrl: 'https://syra.fm/podcasts/show' };
let renderer: TestRenderer.ReactTestRenderer;
const screen = () => JSON.stringify(renderer.toJSON());
const box = () => renderer.root.findByProps({ testID: 'syra-podcast-card' }).props.style;
beforeEach(() => {
  jest.useFakeTimers();
  mockLoad.mockReset();
  mockVisible = true;
});
afterEach(() => {
  act(() => renderer?.unmount());
  jest.useRealTimers();
});
it('keeps feed usable during outage without ever rendering cached metadata, preserving dimensions', async () => {
  mockLoad.mockReturnValue(new Promise(() => {}));
  act(() => {
    renderer = TestRenderer.create(
      <>
        <Text>Feed ready</Text>
        <PostPodcastAttachment podcast={legacy} width="100%" />
      </>,
    );
  });
  expect(screen()).toContain('Feed ready');
  expect(screen()).not.toContain('Old copied');
  expect(screen()).not.toContain('secret.invalid');
  expect(box()).toEqual({ width: '100%', height: 200 });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(8016);
  });
  expect(screen()).toContain('unavailable');
  expect(screen()).not.toContain('Old copied');
  expect(box()).toEqual({ width: '100%', height: 200 });
});
it('renders current facts, then forgets them immediately on withdrawal and never falls back', async () => {
  mockLoad
    .mockResolvedValueOnce({ items: [current], unavailableIds: [] })
    .mockResolvedValueOnce({ items: [], unavailableIds: ['show'] });
  act(() => {
    renderer = TestRenderer.create(<PostPodcastAttachment podcast={legacy} width={340} />);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(16);
  });
  expect(screen()).toContain('Current title');
  expect(screen()).not.toContain('Old copied');
  act(() => syraPodcastCards.refresh());
  expect(screen()).not.toContain('Current title');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(16);
  });
  expect(screen()).toContain('unavailable');
  expect(screen()).not.toContain('Old copied');
});
it('deduplicates visible cards and defers hidden cards', async () => {
  mockVisible = false;
  mockLoad.mockResolvedValue({ items: [current], unavailableIds: [] });
  const cards = (
    <>
      <PostPodcastAttachment podcast={legacy} width={340} />
      <PostPodcastAttachment podcast={legacy} width={340} />
    </>
  );
  act(() => {
    renderer = TestRenderer.create(cards);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(16);
  });
  expect(mockLoad).not.toHaveBeenCalled();
  mockVisible = true;
  act(() => {
    renderer.update(
      <>
        <PostPodcastAttachment podcast={legacy} width={341} />
        <PostPodcastAttachment podcast={legacy} width={341} />
      </>,
    );
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(16);
  });
  expect(mockLoad).toHaveBeenCalledTimes(1);
  expect(mockLoad.mock.calls[0][0]).toEqual(['show']);
});
