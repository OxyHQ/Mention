import TestRenderer, { act } from 'react-test-renderer';

import PostAttachmentsRow from '../PostAttachmentsRow';
import type { HydratedPostSummary } from '@mention/shared-types';
import type { NestedPostRenderer } from '../Attachments/PostAttachmentNested';

type Captured = { kind: string; props: Record<string, unknown> };
const captured: Captured[] = [];
const capture = (kind: string) => (props: Record<string, unknown>) => {
  captured.push({ kind, props });
  return null;
};

jest.mock('../Attachments', () => ({
  PostAttachmentMedia: capture('media'),
  PostAttachmentArticle: capture('article'),
  PostAttachmentLink: capture('link'),
  PostAttachmentExternalEmbed: capture('embed'),
  PostAttachmentPoll: capture('poll'),
  PostAttachmentNested: ({
    nestedPost,
    renderPost,
    nestingDepth,
  }: {
    nestedPost: HydratedPostSummary;
    renderPost: NestedPostRenderer;
    nestingDepth: number;
  }) => renderPost(nestedPost, nestingDepth + 1),
  PostAttachmentEvent: capture('event'),
  PostAttachmentRoom: capture('room'),
}));
jest.mock('../Attachments/HomiioCaseCard', () => ({ HomiioCaseCard: capture('homiio') }));
jest.mock('@/components/Podcast/PostPodcastAttachment', () => ({
  PostPodcastAttachment: capture('podcast'),
}));
jest.mock('@/components/Post/JobCard', () => ({ __esModule: true, default: capture('job') }));
jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { assets: { renderUrl: (id: string) => `https://cdn/${id}` } },
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
const mockOpen = jest.fn();
jest.mock('@/components/common/LazyZoomableGallery', () => {
  const React = jest.requireActual('react');
  return {
    LazyZoomableGallery: React.forwardRef(function MockLazyZoomableGallery(
      _props: unknown,
      ref: unknown,
    ) {
      React.useImperativeHandle(ref, () => ({ open: mockOpen }));
      return null;
    }),
  };
});
jest.mock('@oxy.so/bloom/media-flight', () => ({
  useMediaFlight: () => ({ registerAnchor: jest.fn(), measureAnchor: jest.fn(), flyTo: jest.fn() }),
}));
jest.mock('@/stores/videoPlayerRegistry', () => ({
  holdAcrossTransition: jest.fn(),
  peekVideoPlayer: () => undefined,
  videoPlayerKey: (postId: string, mediaId: string) => `${postId}:${mediaId}`,
}));
jest.mock('@/utils/mediaUrls', () => ({
  videoPosterUrl: (id: string) => `https://cdn/${id}?poster`,
}));
jest.mock('@/stores/externalEmbedsStore', () => ({
  useExternalEmbedsStore: (selector: (s: { prefs: Record<string, unknown> }) => unknown) =>
    selector({ prefs: {} }),
}));

const privateMedia = (id: string) => ({
  id,
  type: 'image' as const,
  url: `https://media.test/${id}?token=fixture`,
});

afterEach(() => {
  captured.length = 0;
  mockOpen.mockClear();
});

it('shares the quoted post permalink for its own image, not the outer post or media URL', () => {
  const quotedPost = { id: 'quoted' } as HydratedPostSummary;
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <PostAttachmentsRow
        postId="outer"
        media={[privateMedia('outer-image')]}
        nestedPost={quotedPost}
        renderNestedPost={(post) => (
          <PostAttachmentsRow postId={post.id} media={[privateMedia('quoted-image')]} />
        )}
      />,
    );
  });
  const media = captured.filter((item) => item.kind === 'media');
  expect(media).toHaveLength(2);
  act(() => (media[0].props.onPress as () => void)());
  expect(mockOpen).toHaveBeenLastCalledWith(
    [expect.objectContaining({ shareUrl: 'https://mention.earth/p/outer' })],
    0,
    undefined,
  );
  act(() => (media[1].props.onPress as () => void)());
  expect(mockOpen).toHaveBeenLastCalledWith(
    [expect.objectContaining({ shareUrl: 'https://mention.earth/p/quoted' })],
    0,
    undefined,
  );
  act(() => tree.unmount());
});

it('disables sharing if the post id is absent', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<PostAttachmentsRow media={[privateMedia('image')]} />);
  });
  const media = captured.find((item) => item.kind === 'media');
  if (!media) throw new Error('Expected image');
  act(() => (media.props.onPress as () => void)());
  expect(mockOpen).toHaveBeenCalledWith(
    [expect.objectContaining({ shareUrl: null })],
    0,
    undefined,
  );
  act(() => tree.unmount());
});
