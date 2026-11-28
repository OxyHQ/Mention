import {
  concealVideo,
  isVideoWarned,
  revealVideo,
  useRevealedVideos,
  videoContentWarning,
} from '../videoWarning';
import type { WatchPost } from '../watchVideo';

const post = (metadata: Partial<WatchPost['metadata']>) =>
  ({ metadata }) as Pick<WatchPost, 'metadata'>;

it('hides a preview for sensitive media or a written content warning', () => {
  expect(isVideoWarned(post({}))).toBe(false);
  expect(isVideoWarned(post({ spoilerText: '   ' }))).toBe(false);
  expect(isVideoWarned(post({ isSensitive: true }))).toBe(true);
  expect(isVideoWarned(post({ spoilerText: ' spoilers ' }))).toBe(true);
  expect(videoContentWarning(post({ spoilerText: ' spoilers ' }))).toBe('spoilers');
});

it('remembers an opened video until it is concealed again', () => {
  revealVideo('a');
  expect(useRevealedVideos.getState().ids.has('a')).toBe(true);
  concealVideo('a');
  expect(useRevealedVideos.getState().ids.has('a')).toBe(false);
});
