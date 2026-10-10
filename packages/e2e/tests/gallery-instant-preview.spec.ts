import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';

const POST_ID = 'c186e8a0-e9a5-4e84-9c97-15b285a79999';
const IMAGE_ORIGIN = 'https://media.mention.earth/gallery-preview-regression';
const media = ['red', 'blue'].map((color, index) => ({
  id: `gallery-preview-${index}`,
  type: 'image',
  width: 800,
  height: 400,
  alt: `Progressive gallery image ${index + 1}`,
  url: `${IMAGE_ORIGIN}/${color}-full.svg`,
  fullUrl: `${IMAGE_ORIGIN}/${color}-full.svg`,
  thumbUrl: `${IMAGE_ORIGIN}/${color}-thumb.svg`,
}));

async function centerPixel(page: Page): Promise<number[]> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('gallery test needs a viewport');
  const screenshot = await page.screenshot({
    clip: { x: viewport.width / 2, y: viewport.height / 2, width: 1, height: 1 },
  });
  return page.evaluate(
    async (dataUrl) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas pixel reader unavailable');
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    },
    `data:image/png;base64,${screenshot.toString('base64')}`,
  );
}

function svg(color: string, width: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width / 2}"><rect width="100%" height="100%" fill="${color}"/></svg>`;
}

for (const outcome of ['loaded', 'failed'] as const) {
  test(`gallery paints the cached thumbnail immediately and keeps the correct image when the full image ${outcome}`, async ({
    page,
    candidate,
  }, testInfo) => {
    let releaseFull: () => void = () => {};
    const fullGate = new Promise<void>((resolve) => {
      releaseFull = resolve;
    });
    await page.route(`${IMAGE_ORIGIN}/**`, async (route) => {
      const url = route.request().url();
      const color = url.includes('/red-') ? 'red' : 'blue';
      if (url.includes('-full.')) {
        await fullGate;
        if (outcome === 'failed') {
          await route.fulfill({ status: 503, body: 'Full-size image unavailable' });
          return;
        }
      }
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: svg(
          url.includes('-thumb.') ? (color === 'red' ? '#800000' : '#000080') : color,
          url.includes('-thumb.') ? 80 : 800,
        ),
      });
    });
    await page.route(`**/feed/item/${POST_ID}`, (route) =>
      route.fulfill({
        json: {
          id: POST_ID,
          type: 'post',
          user: {
            id: 'gallery-fixture-user',
            username: 'gallery-fixture',
            name: { displayName: 'Gallery Fixture' },
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
          content: { text: 'Instant gallery preview regression', media },
          metadata: {
            visibility: 'public',
            status: 'published',
            createdAt: '2026-01-01T00:00:00Z',
          },
          engagement: { likes: 0, downvotes: 0, replies: 0, boosts: 0, views: 0 },
        },
      }),
    );
    await page.route(`**/feed/replies/${POST_ID}**`, (route) =>
      route.fulfill({ json: { items: [], hasMore: false, totalCount: 0 } }),
    );
    await page.route(`**/statistics/post/${POST_ID}/view`, (route) =>
      route.fulfill({ json: { viewsCount: 1 } }),
    );

    try {
      await page.goto(`/p/${POST_ID}`);
      const thumbnail = page.locator(`img[alt="${media[0].alt}"]`).first();
      await expect(thumbnail).toBeVisible();
      await expect
        .poll(() =>
          thumbnail.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
        )
        .toBe(true);
      await page.evaluate((url) => {
        const state: { frames: boolean[] } = { frames: [] };
        Object.assign(window, { galleryPreviewFrames: state });
        const sample = () => {
          if (document.querySelector('[aria-label="Close media viewer"]')) {
            const image = document.querySelectorAll<HTMLImageElement>(`img[src="${url}"]`)[1];
            const box = image?.getBoundingClientRect();
            let opacity = 1;
            let visible = true;
            for (let node: Element | null = image ?? null; node; node = node.parentElement) {
              const style = getComputedStyle(node);
              opacity *= Number(style.opacity);
              if (style.visibility === 'hidden' || style.display === 'none') visible = false;
            }
            state.frames.push(
              Boolean(
                image?.complete &&
                  image.naturalWidth > 0 &&
                  box?.width &&
                  box.height &&
                  visible &&
                  opacity > 0.01,
              ),
            );
          }
          if (state.frames.length < 40) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, media[0].thumbUrl);
      await thumbnail.click();
      await expect(
        page.getByRole('button', { name: 'Close media viewer', exact: true }),
      ).toBeVisible();
      // The full response stays blocked until all preview assertions finish.
      // The feed thumbnail alone cannot satisfy this: a second decoded image
      // must exist in the overlay, including after its opening animation.
      const preview = page.locator(`img[src="${media[0].thumbUrl}"]`).nth(1);
      await expect(preview).toBeVisible({ timeout: 1_000 });
      await expect
        .poll(
          () =>
            preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
          { timeout: 1_000 },
        )
        .toBe(true);
      // Record from BEFORE the click, including the first overlay frame and
      // the opening-animation/pager handoff, while full bytes remain blocked.
      const sampledFrames = () =>
        page.evaluate(
          () =>
            (window as typeof window & { galleryPreviewFrames: { frames: boolean[] } })
              .galleryPreviewFrames.frames,
        );
      await expect.poll(async () => (await sampledFrames()).length).toBe(40);
      expect(
        await sampledFrames(),
        'every painted overlay frame must have the decoded thumbnail',
      ).not.toContain(false);
      await expect(page.getByRole('button', { name: 'Next item', exact: true })).toBeVisible();
      await expect(preview).toBeVisible();
      expect(await centerPixel(page), 'the overlay must actually paint the red thumbnail').toEqual([
        128, 0, 0,
      ]);

      await page.getByRole('button', { name: 'Next item', exact: true }).click();
      const secondPreview = page.locator(`img[src="${media[1].thumbUrl}"]`).nth(1);
      await expect(secondPreview).toBeInViewport();
      await expect
        .poll(() =>
          secondPreview.evaluate(
            (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
          ),
        )
        .toBe(true);
      // Once paging settles, the previous image is not left over the new page.
      await expect(preview).not.toBeInViewport();
      expect(
        await centerPixel(page),
        'paging paints the second thumbnail, not the previous image',
      ).toEqual([0, 0, 128]);

      const fullResponse = page.waitForResponse((response) => response.url() === media[1].fullUrl);
      releaseFull();
      await fullResponse;
      if (outcome === 'loaded') {
        const fullImage = page.locator(`img[src="${media[1].fullUrl}"]`).last();
        await expect(fullImage).toBeInViewport();
        await expect
          .poll(() =>
            fullImage.evaluate(
              (image: HTMLImageElement) => image.complete && image.naturalWidth === 800,
            ),
          )
          .toBe(true);
        await expect
          .poll(() => centerPixel(page), {
            message: 'the full-quality image must replace the thumbnail on screen',
          })
          .toEqual([0, 0, 255]);
      } else {
        await expect(secondPreview).toBeInViewport();
        expect(await centerPixel(page), 'failed full image keeps the thumbnail painted').toEqual([
          0, 0, 128,
        ]);
        await expect
          .poll(() =>
            secondPreview.evaluate(
              (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
            ),
          )
          .toBe(true);
      }
      expect(candidate.scriptErrors).toEqual([]);
    } catch (error) {
      await testInfo.attach('gallery-before-releasing-full-image', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      throw error;
    } finally {
      releaseFull();
    }
  });
}
