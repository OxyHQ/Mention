import { arrangeVideoPost, POST_ID, MEDIA_ORIGIN, POSTER } from '../fixtures/videoPlayback';
import type { Page } from '@playwright/test';
import { expect, contractTest as test } from '../fixtures';

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

test('a delayed ranked response keeps the requested video and its decoder selected', async ({
  page,
  candidate,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  let releaseRanked: () => void = () => {
    throw new Error('Ranked barrier is not initialized');
  };
  const rankedReady = new Promise<void>((resolve) => {
    releaseRanked = resolve;
  });
  await arrangeVideoPost(page, 'hls', { rankedReady, otherRankedPost: true });
  await page.goto(`/p/${POST_ID}`);
  const requested = await observeFrames(page);
  const bounds = await requested.boundingBox();
  if (!bounds) throw new Error('Video has no bounds');
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page).toHaveURL(/\/videos\?postId=/);
  await expect
    .poll(() => requested.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(0.5);
  const before = await requested.evaluate((video: HTMLVideoElement) => ({
    time: video.currentTime,
    src: video.currentSrc,
  }));
  const rankedResponse = page.waitForResponse((response) => response.url().includes('/feed/mtn?'));
  releaseRanked();
  await rankedResponse;
  await expect(page.getByText('Different ranked video', { exact: true })).toBeAttached();
  await expect
    .poll(() => requested.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(before.time + 1);
  expect(await requested.evaluate((video: HTMLVideoElement) => video.currentSrc)).toBe(before.src);
  expect(await requested.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(candidate.scriptErrors).toEqual([]);
});

test('an unavailable requested post never silently opens a different ranked video', async ({
  page,
  candidate,
}) => {
  let rankedRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/feed/mtn?')) rankedRequests++;
  });
  await arrangeVideoPost(page, 'mp4', { missingTarget: true, otherRankedPost: true });
  await page.goto(`/videos?postId=${POST_ID}&mediaIndex=0`);
  await expect(page.getByTestId('videos-status').getByRole('button')).toBeVisible();
  await expect(page.getByText('Different ranked video', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('videos-screen').locator('video')).toHaveCount(0);
  expect(rankedRequests).toBe(0);
  expect(candidate.scriptErrors).toEqual([]);
});

test('immediate ranking and an explicit repeated navigation keep the requested media selected', async ({
  page,
  candidate,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  // An immediate ranked page also exercises restoration while content grows;
  // the delayed-page case alone could miss this timing.
  await arrangeVideoPost(page, 'mp4', { otherRankedPost: true });
  await page.goto(`/p/${POST_ID}`);
  const openFirstAttachment = async () => {
    const first = page.locator(`video[src="${MEDIA_ORIGIN}/clip.mp4"]`).first();
    await expect(first).toBeVisible();
    const bounds = await first.boundingBox();
    if (!bounds) throw new Error('Requested video has no bounds');
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await expect(page).toHaveURL(new RegExp(`/videos\\?postId=${POST_ID}&mediaIndex=0`));
  };
  await openFirstAttachment();
  const screen = page.getByTestId('videos-screen');
  const ranked = screen.locator(`video[src="${MEDIA_ORIGIN}/second.mp4"]`);
  await expect(ranked).toBeAttached();
  const original = screen.locator(`video[src="${MEDIA_ORIGIN}/clip.mp4"]`);
  await expect
    .poll(() => original.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(0.5);
  await expect.poll(() => original.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  await ranked.scrollIntoViewIfNeeded();
  await expect.poll(() => ranked.evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  const before = await ranked.evaluate((video: HTMLVideoElement) => video.currentTime);
  await expect
    .poll(() => ranked.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(before + 0.5);
  // An explicit repeat from the post is a new intent, even with identical params.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/p/${POST_ID}$`));
  await openFirstAttachment();
  const requested = screen.locator(`video[src="${MEDIA_ORIGIN}/clip.mp4"]`);
  await expect
    .poll(() => requested.evaluate((video: HTMLVideoElement) => video.paused))
    .toBe(false);
  const position = await requested.evaluate((video: HTMLVideoElement) => video.currentTime);
  await expect
    .poll(() => requested.evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeGreaterThan(position + 0.5);
  expect(candidate.scriptErrors).toEqual([]);
});

test('video replies follow their host across desktop, mobile and Deck without replacing the active third decoder', async ({
  page,
  candidate,
}) => {
  await arrangeVideoPost(page, 'mp4', { thirdMedia: true, replyCount: 40 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/videos?postId=${POST_ID}&mediaIndex=2`);
  const screen = page.getByTestId('videos-screen');
  await expect(screen.getByRole('tab', { name: 'For You', exact: true })).toBeVisible();
  await expect(screen.getByRole('tab', { name: 'Following', exact: true })).toBeVisible();
  const video = screen.locator('video').filter({ visible: true }).first();
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.currentSrc))
    .toContain('third.mp4');
  await video.evaluate((node) => {
    node.dataset.retainedVideo = 'true';
  });
  const retained = page.locator('video[data-retained-video="true"]');
  const replies = page.getByTestId('video-replies-screen');
  await expect(replies).toBeVisible();
  // Signed-out readers can browse replies; publication stays behind the account boundary.
  await expect(replies.getByRole('textbox')).toHaveCount(0);
  const replyViewport = replies.locator('[data-bloom-screen-viewport="element"]');
  await replyViewport.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => replyViewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(retained).toHaveCount(1);
  await expect(page.locator('[data-bloom-resize-handle]')).toHaveCount(0);
  await screen.getByRole('button', { name: 'Reply', exact: true }).last().click();
  await expect(replies).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('video-replies-screen')).toHaveCount(1);
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(retained).toHaveCount(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(replies).toBeVisible();
  await page.getByRole('button', { name: 'Deck mode', exact: true }).click();
  await expect(replies).toBeHidden();
  await screen.getByRole('button', { name: 'Reply', exact: true }).last().click();
  await expect(dialog.getByTestId('video-replies-screen')).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(retained).toHaveCount(1);
  expect(await retained.evaluate((node: HTMLVideoElement) => node.currentSrc)).toContain(
    'third.mp4',
  );
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Deck mode', exact: true }).click();
  await expect(replies).toBeVisible();
  await expect(replies.getByRole('textbox')).toHaveCount(0);
  const time = await retained.evaluate((node: HTMLVideoElement) => node.currentTime);
  await expect
    .poll(() => retained.evaluate((node: HTMLVideoElement) => node.currentTime))
    .not.toBe(time);
  expect(candidate.scriptErrors).toEqual([]);
});

test('Videos reserves its replies column before delayed feed data arrives', async ({
  page,
  candidate,
}) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await arrangeVideoPost(page, 'mp4', { rankedReady: ready });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/videos');
  const primary = page.getByTestId('mention-shell-panels-main-content');
  await expect(page.getByTestId('video-replies-pending')).toBeVisible();
  await expect.poll(async () => (await primary.boundingBox())?.width ?? 0).toBeCloseTo(620, 0);
  await primary.evaluate((node) => {
    node.dataset.retainedPendingVideo = 'true';
  });
  const before = await primary.boundingBox();
  release();
  await expect(page.getByTestId('video-replies-screen')).toBeVisible();
  await expect(primary).toHaveAttribute('data-retained-pending-video', 'true');
  await expect
    .poll(async () => (await primary.boundingBox())?.width ?? 0)
    .toBeCloseTo(before?.width ?? 0, 0);
  await expect(page.getByTestId('videos-screen').locator('video').first()).toBeVisible();
  expect(candidate.scriptErrors).toEqual([]);
});

test('manual pause stays with the previous video and the next video autoplays', async ({
  page,
  candidate,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await arrangeVideoPost(page, 'mp4', { otherRankedPost: true });
  await page.goto(`/videos?postId=${POST_ID}&mediaIndex=0`);
  const screen = page.getByTestId('videos-screen');
  const first = screen.locator(`video[src="${MEDIA_ORIGIN}/clip.mp4"]`);
  const next = screen.locator(`video[src="${MEDIA_ORIGIN}/second.mp4"]`);
  await expect.poll(() => first.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  const bounds = await first.boundingBox();
  if (!bounds) throw Error('no first video');
  const tap = () => page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await tap();
  await page.waitForTimeout(350);
  await tap();
  await expect.poll(() => first.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await next.scrollIntoViewIfNeeded();
  await expect.poll(() => next.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  const position = await next.evaluate((v: HTMLVideoElement) => v.currentTime);
  await expect
    .poll(() => next.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThan(position + 0.3);
  await first.scrollIntoViewIfNeeded();
  await expect.poll(() => first.evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  expect(candidate.scriptErrors).toEqual([]);
});
