import { podcastReference } from '../podcastReference';
it('keeps only the canonical reference and removes legacy cached metadata', () => {
  expect(
    podcastReference({
      syraPodcastId: '  podcast-1 ',
      title: 'stale',
      description: 'copy',
      cover: 'private',
    }),
  ).toEqual({ syraPodcastId: 'podcast-1' });
});
it.each([
  null,
  undefined,
  1,
  'podcast',
  {},
  { syraPodcastId: 1 },
  { syraPodcastId: ' ' },
  { syraPodcastId: 'x'.repeat(257) },
])('rejects a malformed reference %j', (input) => {
  expect(podcastReference(input)).toBeNull();
});
