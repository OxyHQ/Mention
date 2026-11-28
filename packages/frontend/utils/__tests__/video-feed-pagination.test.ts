import { loadVideoPagesUntilProgress } from '../video-feed-pagination';

describe('video feed pagination', () => {
  it('walks empty pages using the response cursor until a new video arrives', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce({ added: 0, hasMore: true, nextCursor: 'second' })
      .mockResolvedValueOnce({ added: 1, hasMore: true, nextCursor: 'third' });
    await loadVideoPagesUntilProgress(fetchPage);
    expect(fetchPage.mock.calls).toEqual([[undefined], ['second']]);
  });

  it.each([null, { added: 0, hasMore: false, nextCursor: 'unused' }, { added: 0, hasMore: true }])(
    'stops on failure, stale response or exhaustion: %j',
    async (response) => {
      const fetchPage = jest.fn().mockResolvedValue(response);
      await loadVideoPagesUntilProgress(fetchPage, 'current');
      expect(fetchPage.mock.calls).toEqual([['current']]);
    },
  );

  it('stops a repeated or cyclic cursor instead of rereading pages', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce({ added: 0, hasMore: true, nextCursor: 'second' })
      .mockResolvedValueOnce({ added: 0, hasMore: true, nextCursor: 'first' });
    await loadVideoPagesUntilProgress(fetchPage, 'first');
    expect(fetchPage.mock.calls).toEqual([['first'], ['second']]);
  });

  it('bounds a sparse feed to four reads', async () => {
    let next = 0;
    const fetchPage = jest.fn(async () => ({
      added: 0,
      hasMore: true,
      nextCursor: String(++next),
    }));
    await loadVideoPagesUntilProgress(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });
});
