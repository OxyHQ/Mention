import { beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../utils/logger', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * The process `OxyServer`, faked at the one seam the service uses: `withUser`
 * builds a client bound to the bearer it is given, and that client's
 * `withCallOptions` scope is what sends `setVisibility`.
 */
const oxy = vi.hoisted(() => {
  const setVisibility = vi.fn();
  const withCallOptions = vi.fn(() => ({ assets: { setVisibility } }));
  const withUser = vi.fn(
    async (_bearer: string, use: (user: { withCallOptions: typeof withCallOptions }) => unknown) =>
      use({ withCallOptions }),
  );
  return { setVisibility, withCallOptions, withUser };
});
vi.mock('../../utils/oxyHelpers', () => ({
  MEDIA_VISIBILITY_TIMEOUT_MS: 60_000,
  getServiceOxyClient: () => ({ withUser: oxy.withUser }),
}));

import { ensurePostMediaPublic, postMediaFileIds } from '../../services/postMediaVisibility';

beforeEach(() => {
  vi.clearAllMocks();
  oxy.setVisibility.mockResolvedValue({ file: {} });
});

describe('postMediaFileIds', () => {
  it('collects shared media, variant replacement media and variant alt keys, deduped', () => {
    const ids = postMediaFileIds({
      text: 'hola',
      media: [
        { id: 'video-1', type: 'video' },
        { id: 'image-1', type: 'image' },
      ],
      variants: [
        {
          source: 'author',
          language: 'es',
          text: 'hola',
          media: [{ id: 'image-es', type: 'image' }],
        },
        { source: 'author', language: 'en', text: 'hi', alt: { 'image-1': 'A cat' } },
        {
          source: 'machine',
          language: 'fr',
          text: 'salut',
          media: [{ id: 'machine-only', type: 'image' }],
        },
      ],
    } as never);
    expect(ids.sort()).toEqual(['image-1', 'image-es', 'video-1']);
  });

  it('skips temp ids and absolute URLs, which have no Oxy visibility', () => {
    const ids = postMediaFileIds({
      media: [
        { id: 'temp-123', type: 'image' },
        { id: 'https://files.example/cat.jpg', type: 'image' },
        { id: 'real-1', type: 'image' },
      ],
    } as never);
    expect(ids).toEqual(['real-1']);
  });

  it('is empty for a post without media', () => {
    expect(postMediaFileIds({ text: 'just words' } as never)).toEqual([]);
    expect(postMediaFileIds(undefined)).toEqual([]);
  });
});

describe('ensurePostMediaPublic', () => {
  const author = { user: { id: 'author' }, accessToken: 'author-token' };

  it("makes every media file public with the author's verified session and a long budget", async () => {
    await ensurePostMediaPublic(author, {
      media: [
        { id: 'video-1', type: 'video' },
        { id: 'image-1', type: 'image' },
      ],
    } as never);
    expect(oxy.withUser).toHaveBeenCalledTimes(1);
    expect(oxy.withUser).toHaveBeenCalledWith('author-token', expect.any(Function));
    // Oxy moves every variant before it answers: past the SDK's 5 s default.
    expect(oxy.withCallOptions).toHaveBeenCalledWith({ timeout: 60_000 });
    expect(oxy.setVisibility).toHaveBeenCalledTimes(2);
    expect(oxy.setVisibility).toHaveBeenCalledWith('video-1', 'public');
    expect(oxy.setVisibility).toHaveBeenCalledWith('image-1', 'public');
  });

  it('asks nothing without a verified person session', async () => {
    const media = { media: [{ id: 'video-1', type: 'video' }] } as never;
    // A raw header the optional auth mount refused is not a person's proof.
    await ensurePostMediaPublic({ headers: { authorization: 'Bearer unverified' } }, media);
    // An MCP caller's uploads are already public; capability and service
    // requests name no person whose session may move the file.
    await ensurePostMediaPublic({ accessToken: 't', mcp: { activeUserId: 'a' } }, media);
    await ensurePostMediaPublic({ accessToken: 't', capability: { ticket: 'c' } }, media);
    await ensurePostMediaPublic(
      { accessToken: 't', serviceApp: { authority: 'first_party' } },
      media,
    );
    expect(oxy.withUser).not.toHaveBeenCalled();
  });

  it('asks nothing for a post without Oxy media', async () => {
    await ensurePostMediaPublic(author, { text: 'just words' } as never);
    expect(oxy.withUser).not.toHaveBeenCalled();
  });

  it('never fails the write: a refused file is logged and the rest still go public', async () => {
    oxy.setVisibility.mockImplementation((id: string) =>
      id === 'not-mine' ? Promise.reject(new Error('Forbidden')) : Promise.resolve({ file: {} }),
    );
    await expect(
      ensurePostMediaPublic(author, {
        media: [
          { id: 'not-mine', type: 'image' },
          { id: 'mine', type: 'image' },
        ],
      } as never),
    ).resolves.toBeUndefined();
    expect(oxy.setVisibility).toHaveBeenCalledWith('mine', 'public');
    expect(warn).toHaveBeenCalledWith(
      '[postMediaVisibility] Failed to make post media public',
      expect.objectContaining({ fileId: 'not-mine', error: 'Forbidden' }),
    );
  });

  it('never fails the write when no user client can be built', async () => {
    oxy.withUser.mockRejectedValueOnce(new Error('A user client needs a bearer token'));
    await expect(
      ensurePostMediaPublic(author, { media: [{ id: 'mine', type: 'image' }] } as never),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[postMediaVisibility] No user client for the post author',
      expect.objectContaining({ error: 'A user client needs a bearer token' }),
    );
  });
});
