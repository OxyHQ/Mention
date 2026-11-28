import { Profiler } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { EXTERNAL_EMBED_SOURCES, type EmbedPlayerSource } from '@mention/shared-types';
import PostAttachmentsRow from '../PostAttachmentsRow';
import PostAttachmentExternalEmbed from '../Attachments/PostAttachmentExternalEmbed';
import { ExternalEmbedPlayer } from '../Attachments/ExternalEmbedPlayer';
import { useExternalEmbedsStore } from '@/stores/externalEmbedsStore';
import { parseEmbedPlayerFromUrl } from '@/utils/embedPlayer';

jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: jest.fn() }));
jest.mock('@/utils/api', () => ({ authenticatedClient: { get: jest.fn(), put: jest.fn() } }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
const mockOpen = jest.fn();
jest.mock('@oxy.so/bloom/dialog', () => ({ useDialogControl: () => ({ open: mockOpen }) }));
jest.mock('@/components/common/LazyZoomableGallery', () => ({ LazyZoomableGallery: () => null }));
jest.mock('../Attachments', () => ({
  PostAttachmentMedia: () => null,
  PostAttachmentArticle: () => null,
  PostAttachmentLink: () => null,
  PostAttachmentExternalEmbed: require('../Attachments/PostAttachmentExternalEmbed').default,
  PostAttachmentPoll: () => null,
  PostAttachmentNested: () => null,
  PostAttachmentEvent: () => null,
  PostAttachmentRoom: () => null,
}));
jest.mock('../Attachments/PostAttachmentLink', () => ({ __esModule: true, default: () => null }));
jest.mock('../Attachments/ExternalEmbedPlayer', () => ({ ExternalEmbedPlayer: () => null }));
jest.mock('../Attachments/EmbedConsentDialog', () => ({ EmbedConsentDialog: () => null }));
jest.mock('../Attachments/HomiioCaseCard', () => ({ HomiioCaseCard: () => null }));
jest.mock('@/components/Podcast/PostPodcastAttachment', () => ({
  PostPodcastAttachment: () => null,
}));
jest.mock('@/components/Post/JobCard', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { assets: { renderUrl: (id: string) => id } },
}));
jest.mock('@/lib/navigation/router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@oxy.so/bloom/media-flight', () => ({
  useMediaFlight: () => ({ measureAnchor: jest.fn(), flyTo: jest.fn() }),
}));
jest.mock('@/stores/videoPlayerRegistry', () => ({
  holdAcrossTransition: jest.fn(),
  peekVideoPlayer: () => null,
  videoPlayerKey: () => '',
}));

const urls: Record<EmbedPlayerSource, string> = {
  youtube: 'https://youtube.com/watch?v=abc',
  youtubeShorts: 'https://youtube.com/shorts/abc',
  vimeo: 'https://vimeo.com/123',
  twitch: 'https://twitch.tv/channel',
  giphy: 'https://giphy.com/gifs/test-abc',
  spotify: 'https://open.spotify.com/track/abc',
  appleMusic: 'https://music.apple.com/us/album/album/123',
  soundcloud: 'https://soundcloud.com/artist/track',
  flickr: 'https://www.flickr.com/photos/user/albums/123',
  bandcamp: 'https://artist.bandcamp.com/track/song',
};
const row = (url: string) => <PostAttachmentsRow postId="p" text={url} />;
let renderer: TestRenderer.ReactTestRenderer;
const embedCount = () => renderer.root.findAllByType(PostAttachmentExternalEmbed).length;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockOpen.mockClear();
  act(() => useExternalEmbedsStore.setState({ prefs: {}, hydrated: false }));
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
});

it.each(EXTERNAL_EMBED_SOURCES)('preserves missing, show and hide for %s', (source) => {
  expect(parseEmbedPlayerFromUrl(urls[source])?.source).toBe(source);
  act(() => {
    renderer = TestRenderer.create(row(urls[source]));
  });
  expect(embedCount()).toBe(1);
  act(() => useExternalEmbedsStore.setState({ prefs: { [source]: 'show' } }));
  expect(embedCount()).toBe(1);
  act(() => useExternalEmbedsStore.setState({ prefs: { [source]: 'hide' } }));
  expect(embedCount()).toBe(0);
  act(() => useExternalEmbedsStore.setState({ prefs: {} }));
  expect(embedCount()).toBe(1);
});

it('updates on recycled cells and account resets without unrelated row renders', () => {
  let commits = 0;
  act(() => {
    renderer = TestRenderer.create(
      <Profiler
        id="row"
        onRender={() => {
          commits++;
        }}
      >
        {row(urls.youtube)}
      </Profiler>,
    );
  });
  commits = 0;
  act(() => useExternalEmbedsStore.setState({ prefs: { spotify: 'hide' } }));
  expect(commits).toBe(0);
  expect(embedCount()).toBe(1);
  act(() =>
    renderer.update(
      <Profiler
        id="row"
        onRender={() => {
          commits++;
        }}
      >
        {row(urls.spotify)}
      </Profiler>,
    ),
  );
  expect(embedCount()).toBe(0);
  act(() => useExternalEmbedsStore.getState().resetViewerState('second-viewer'));
  expect(embedCount()).toBe(1);
  act(() => useExternalEmbedsStore.setState({ prefs: { spotify: 'hide' } }));
  expect(embedCount()).toBe(0);
});

it('applies cached viewer preferences after reset and hydration', async () => {
  const storage = jest
    .spyOn(AsyncStorage, 'getItem')
    .mockResolvedValue(JSON.stringify({ youtube: 'hide' }));
  act(() => {
    renderer = TestRenderer.create(row(urls.youtube));
  });
  expect(embedCount()).toBe(1);
  await act(async () => {
    await useExternalEmbedsStore.getState().hydrate(false, 'hydrated-viewer');
  });
  expect(embedCount()).toBe(0);
  act(() => useExternalEmbedsStore.getState().resetViewerState('next-viewer'));
  expect(embedCount()).toBe(1);
  storage.mockResolvedValue(JSON.stringify({ youtube: 'show' }));
  await act(async () => {
    await useExternalEmbedsStore.getState().hydrate(false, 'next-viewer');
  });
  expect(embedCount()).toBe(1);
  storage.mockRestore();
});

it('updates consent behavior when a visible embed goes from absent preference to show', () => {
  act(() => {
    renderer = TestRenderer.create(row(urls.youtube));
  });
  act(() => renderer.root.findByType(ExternalEmbedPlayer).props.onPressPlay());
  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByType(ExternalEmbedPlayer).props.active).toBe(false);
  act(() => useExternalEmbedsStore.setState({ prefs: { youtube: 'show' } }));
  act(() => renderer.root.findByType(ExternalEmbedPlayer).props.onPressPlay());
  expect(mockOpen).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByType(ExternalEmbedPlayer).props.active).toBe(true);
});
