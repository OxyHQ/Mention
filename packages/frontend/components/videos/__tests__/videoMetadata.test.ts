import { videoTitleText } from '../videoMetadata';

it('uses the same readable mention label as the post body in video titles', () => {
  expect(videoTitleText('  Gov. [@Gavin Newsom](gavinnewsom@bsky.social): Watch this.  ')).toBe(
    'Gov. Gavin Newsom: Watch this.',
  );
  expect(videoTitleText('From [@@alice@example.social](https://example.social/@alice)')).toBe(
    'From @alice@example.social',
  );
  expect(videoTitleText('Literal [caption] and @plain')).toBe('Literal [caption] and @plain');
  expect(videoTitleText()).toBe('');
});
