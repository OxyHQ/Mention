import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

export const POST_ID = '019e23ee-2d68-7000-8000-000000000009';
export const MEDIA_ORIGIN = 'https://media.mention.earth/playback-regression';
export const POSTER = `${MEDIA_ORIGIN}/poster.svg`;

export async function arrangeVideoPost(
  page: Page,
  format: 'mp4' | 'hls',
  options: {
    rankedReady?: Promise<void>;
    otherRankedPost?: boolean;
    missingTarget?: boolean;
    thirdMedia?: boolean;
    replyCount?: number;
  } = {},
) {
  const requests: string[] = [];
  // Pointer movement over the reply author can open the real profile hover card.
  await page.route('**/statistics/user/playback-fixture-user/activity?**', (route) =>
    route.fulfill({ json: { activity: [] } }),
  );
  await page.route(`${MEDIA_ORIGIN}/**`, async (route) => {
    const filename = new URL(route.request().url()).pathname.split('/').pop();
    if (!filename) throw new Error('Fixture filename is missing');
    requests.push(filename);
    if (filename === 'poster.svg' || filename === 'avatar.svg') {
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="160"><rect width="100%" height="100%" fill="magenta"/></svg>',
        headers: { 'access-control-allow-origin': '*' },
      });
      return;
    }
    const body = await readFile(
      join(
        import.meta.dirname,
        './video',
        filename === 'second.mp4' || filename === 'third.mp4'
          ? 'clip.mp4'
          : filename === 'second.m3u8'
            ? 'clip.m3u8'
            : filename,
      ),
    );
    await route.fulfill({
      contentType: filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4',
      body,
      headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' },
    });
  });
  const media = [
    {
      id: 'playback-first',
      type: 'video',
      url: `${MEDIA_ORIGIN}/clip.mp4`,
      ...(format === 'hls' ? { hlsUrl: `${MEDIA_ORIGIN}/clip.m3u8` } : {}),
    },
    {
      id: 'playback-second',
      type: 'video',
      url: `${MEDIA_ORIGIN}/second.mp4`,
      ...(format === 'hls' ? { hlsUrl: `${MEDIA_ORIGIN}/second.m3u8` } : {}),
    },
  ].map((item) => ({ ...item, width: 90, height: 160, durationSec: 16, thumbUrl: POSTER }));
  if (options.thirdMedia)
    media.push({ ...media[1], id: 'playback-third', url: `${MEDIA_ORIGIN}/third.mp4` });
  const post = {
    id: POST_ID,
    type: 'post',
    user: {
      id: 'playback-fixture-user',
      username: 'playback-fixture',
      name: { displayName: 'Playback Fixture' },
    },
    authors: [],
    attachments: {},
    viewerState: {
      isOwner: false,
      isCollaborator: false,
      isLiked: false,
      isDownvoted: false,
      isBoosted: false,
      isSaved: false,
      isFollowingAuthor: false,
    },
    content: { text: 'Video playback regression', media },
    metadata: { visibility: 'public', status: 'published', createdAt: '2026-01-01T00:00:00Z' },
    engagement: { likes: 0, downvotes: 0, replies: 0, boosts: 0, views: 0 },
  };
  const targetResponse = options.missingTarget
    ? { status: 404, json: { message: 'Post unavailable' } }
    : { json: post };
  await page.route(`**/feed/item/${POST_ID}`, (route) => route.fulfill(targetResponse));
  await page.route(`**/posts/${POST_ID}`, (route) => route.fulfill(targetResponse));
  await page.route(`**/feed/replies/${POST_ID}**`, (route) =>
    route.fulfill({
      json: {
        items: Array.from({ length: options.replyCount ?? 0 }, (_, index) => ({
          ...post,
          id: `video-reply-${index}`,
          content: { text: `Video reply ${index}`, media: [] },
          parentPostId: POST_ID,
        })),
        hasMore: false,
      },
    }),
  );
  await page.route('**/feed/mtn?**', async (route) => {
    await options.rankedReady;
    const ranked = options.otherRankedPost
      ? {
          ...post,
          id: '019e23ee-2d68-7000-8000-000000000010',
          content: {
            text: 'Different ranked video',
            media: [media[1]],
          },
        }
      : post;
    await route.fulfill({ json: { items: [ranked], hasMore: false } });
  });
  await page.route(`**/statistics/post/${POST_ID}/view`, (route) =>
    route.fulfill({ json: { viewsCount: 1 } }),
  );
  return requests;
}
