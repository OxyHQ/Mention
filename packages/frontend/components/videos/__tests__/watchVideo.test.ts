import { portraitVideo, watchVideo, type WatchPost } from '../watchVideo';

const video = {
  id: 'file',
  url: 'https://example.com/video.mp4',
  type: 'video' as const,
};

function postWithMedia(media: NonNullable<WatchPost['content']['media']>) {
  return {
    id: 'example-post',
    content: { media },
    attachments: {},
  } as WatchPost;
}

it('uses the matching attachment index for each viewing mode', () => {
  const post = postWithMedia([
    { id: 'poster', type: 'image', width: 240, height: 640 },
    { ...video, width: 1280, height: 720 },
    { ...video, width: 720, height: 1280, orientation: 'landscape' },
  ]);

  expect(watchVideo(post, null)?.mediaIndex).toBe(1);
  expect(portraitVideo(post, null)?.mediaIndex).toBe(2);
});

it('excludes square and unknown dimensions from the clips shelf', () => {
  expect(
    portraitVideo(postWithMedia([{ ...video, width: 640, height: 640 }, video]), null),
  ).toBeNull();
  expect(
    portraitVideo(postWithMedia([{ ...video, orientation: 'portrait' }]), null)?.mediaIndex,
  ).toBe(0);
});
