import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';

const POST_ID = '019e23ee-2d68-7000-8000-000000000009';
const MEDIA_ORIGIN = 'https://media.mention.earth/playback-regression';
const POSTER = `${MEDIA_ORIGIN}/poster.svg`;

async function arrangeVideoPost(page: Page, format: 'mp4' | 'hls') {
  const requests: string[] = [];
  await page.route(`${MEDIA_ORIGIN}/**`, async (route) => {
    const filename = new URL(route.request().url()).pathname.split('/').pop();
    if (!filename) throw new Error('Fixture filename is missing');
    requests.push(filename);
    if (filename === 'poster.svg') {
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
        '../fixtures/video',
        filename === 'second.mp4'
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
  await page.route(`**/feed/item/${POST_ID}`, (route) => route.fulfill({ json: post }));
  await page.route(`**/posts/${POST_ID}`, (route) => route.fulfill({ json: post }));
  await page.route(`**/feed/replies/${POST_ID}**`, (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  );
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({ json: { items: [post], hasMore: false } }),
  );
  await page.route(`**/statistics/post/${POST_ID}/view`, (route) =>
    route.fulfill({ json: { viewsCount: 1 } }),
  );
  return requests;
}

async function observeFrames(page: Page, index = 0) {
  const video = page.locator('video').nth(index);
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.videoWidth))
    .toBe(90);
  await video.evaluate((element: HTMLVideoElement) => {
    element.dataset.playbackSubject = 'true';
    element.dataset.presentedFrames = '0';
    const frame = () => {
      element.dataset.presentedFrames = String(Number(element.dataset.presentedFrames) + 1);
      element.requestVideoFrameCallback(frame);
    };
    element.requestVideoFrameCallback(frame);
  });
  return page.locator('video[data-playback-subject="true"]');
}

for (const format of ['mp4', 'hls'] as const) {
  for (const origin of ['post', 'feed'] as const) {
    test(`${format} keeps its decoder, frames and position from ${origin} to videos`, async ({
      page,
      candidate,
    }) => {
      await page.setViewportSize({ width: 412, height: 915 });
      const requests = await arrangeVideoPost(page, format);
      await page.goto(origin === 'post' ? `/p/${POST_ID}` : '/');
      const video = await observeFrames(page);
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
        .toBeGreaterThan(0.3);
      const before = await video.evaluate((element: HTMLVideoElement) => ({
        time: element.currentTime,
        source: element.currentSrc,
      }));
      const manifestsBefore = requests.filter((name) => name.endsWith('.m3u8')).length;
      const bounds = await video.boundingBox();
      if (!bounds) throw new Error('Video has no bounds');
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await expect(page).toHaveURL(new RegExp(`/videos\\?postId=${POST_ID}&mediaIndex=0`));
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
        .toBeGreaterThan(before.time + 0.5);
      await expect
        .poll(() =>
          video.evaluate((element: HTMLVideoElement) => Number(element.dataset.presentedFrames)),
        )
        .toBeGreaterThan(4);
      expect(await video.evaluate((element: HTMLVideoElement) => element.currentSrc)).toBe(
        before.source,
      );
      expect(requests.filter((name) => name.endsWith('.m3u8')).length).toBe(manifestsBefore);
      if (format === 'hls') expect(manifestsBefore).toBe(1);
      await expect(page.getByTestId('videos-screen').locator(`img[src="${POSTER}"]`)).toHaveCount(
        0,
      );
      expect(candidate.scriptErrors).toEqual([]);
    });
  }
}

test('returning to a post and opening its second video changes the selected media', async ({
  page,
  candidate,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await arrangeVideoPost(page, 'mp4');
  await page.goto(`/p/${POST_ID}`);
  const first = await observeFrames(page);
  const bounds = await first.boundingBox();
  if (!bounds) throw new Error('Video has no bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page).toHaveURL(/mediaIndex=0/);
  // Finish the first handoff before navigating back; the URL changes before
  // the flying surface reaches its destination.
  const firstPosition = await first.evaluate((element: HTMLVideoElement) => element.currentTime);
  await expect
    .poll(() => first.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(firstPosition + 0.5);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/p/${POST_ID}$`));
  const second = page.locator(`video[src="${MEDIA_ORIGIN}/second.mp4"]`);
  await expect(second).toBeVisible();
  const secondBounds = await second.boundingBox();
  if (!secondBounds) throw new Error('Second video has no bounds');
  await page.mouse.click(
    secondBounds.x + secondBounds.width / 2,
    secondBounds.y + secondBounds.height / 2,
  );
  await expect(page).toHaveURL(/mediaIndex=1/);
  const selected = page.getByTestId('videos-screen').locator('video');
  await expect
    .poll(() => selected.evaluate((element: HTMLVideoElement) => element.currentSrc))
    .toBe(`${MEDIA_ORIGIN}/second.mp4`);
  const position = await selected.evaluate((element: HTMLVideoElement) => element.currentTime);
  await expect
    .poll(() => selected.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(position + 0.5);
  expect(candidate.scriptErrors).toEqual([]);
});

test('Back during a video handoff settles on a playable post', async ({ page, candidate }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await arrangeVideoPost(page, 'hls');
  await page.goto(`/p/${POST_ID}`);
  const first = await observeFrames(page);
  const bounds = await first.boundingBox();
  if (!bounds) throw new Error('Video has no bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page).toHaveURL(/mediaIndex=0/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/p/${POST_ID}$`));
  await expect(page.getByText('Video playback regression', { exact: true })).toBeVisible();
  const returned = page.locator('video').first();
  await expect
    .poll(() => returned.evaluate((element: HTMLVideoElement) => element.videoWidth))
    .toBe(90);
  const position = await returned.evaluate((element: HTMLVideoElement) => element.currentTime);
  await expect
    .poll(() => returned.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(position + 0.5);
  expect(candidate.scriptErrors).toEqual([]);
});
