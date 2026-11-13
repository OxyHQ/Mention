import TestRenderer, { act } from 'react-test-renderer';
import { ProfileMedia } from '../ProfileMedia';
import { PinnedMediaSection } from '../EditProfile/PinnedMediaSection';

const mockOpen = jest.fn();
let mockMedia: unknown = null;
jest.mock('../openProfileMediaPicker', () => ({
  openProfileMediaPicker: (...args: unknown[]) => mockOpen(...args),
}));
jest.mock('@/stores/appearanceStore', () => ({
  useAppearanceStore: (select: (state: unknown) => unknown) =>
    select({ mySettings: { profileMedia: mockMedia } }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { primary: '#000' } }) }));
jest.mock('@oxy.so/bloom/icons/RiAddLine', () => ({ RiAddLine: () => null }));
jest.mock('../ProfileSong', () => ({
  ProfileSong: ({ onEdit }: { onEdit: () => void }) => {
    const React = jest.requireActual<typeof import('react')>('react');
    const { Pressable: Button } = jest.requireActual<typeof import('react-native')>('react-native');
    return React.createElement(Button, { onPress: onEdit, testID: 'edit-song' });
  },
}));
jest.mock('@/components/Podcast/PodcastCard', () => ({
  PodcastCard: ({ onEdit }: { onEdit: () => void }) => {
    const React = jest.requireActual<typeof import('react')>('react');
    const { Pressable: Button } = jest.requireActual<typeof import('react-native')>('react-native');
    return React.createElement(Button, { onPress: onEdit, testID: 'edit-podcast' });
  },
}));

const song = {
  type: 'song' as const,
  syraTrackId: 'track',
  title: 'Song',
  artist: 'Artist',
  previewUrl: 'https://example.test/preview',
  startSec: 0,
};
const podcast = {
  type: 'podcast' as const,
  syraPodcastId: 'podcast',
  title: 'Podcast',
  showUrl: 'https://example.test/show',
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockOpen.mockClear();
  mockMedia = null;
});

it.each([song, podcast])('opens the existing $type from the profile', (media) => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ProfileMedia media={media} isOwnProfile />);
  });
  act(() => renderer.root.findByProps({ testID: `edit-${media.type}` }).props.onPress());
  expect(mockOpen).toHaveBeenCalledWith(media);
  act(() => renderer.unmount());
});

it('opens an empty picker to add pinned media in profile settings', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<PinnedMediaSection />);
  });
  act(() => renderer.root.findByProps({ accessibilityLabel: 'profile.media.add' }).props.onPress());
  expect(mockOpen).toHaveBeenCalledWith(null);
  act(() => renderer.unmount());
});

it('opens the existing selection from profile settings', () => {
  mockMedia = podcast;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<PinnedMediaSection />);
  });
  act(() => renderer.root.findByProps({ testID: 'edit-podcast' }).props.onPress());
  expect(mockOpen).toHaveBeenCalledWith(podcast);
  act(() => renderer.unmount());
});
