/**
 * Flow 5 — an image post settles on one layout.
 *
 * `resolveMediaItems` rebuilt each media item from a field whitelist and dropped
 * `width`/`height`/`aspectRatio` one function before serialization, so the client
 * received no geometry and had nothing to reserve space with. The visible result
 * is that an image renders TWICE: a 280x180 fallback box first, then a jump to
 * the real aspect ratio once the bytes arrive and the browser knows the
 * dimensions. Measured on production before the fix:
 *
 *   280x180 @4380ms -> 335x180 @5148ms
 *   280x180 @4380ms -> 270x180 @5181ms
 *
 * With the geometry restored the first box is already correct, so the image
 * settles on ONE layout and never jumps.
 *
 * This deliberately does not name any post. An earlier plan pinned five
 * production ids — one per media shape — which would have coupled a release gate
 * to five rows surviving in the feed, and could only assert that a bounding box
 * matched a number someone wrote down. Counting layouts works on whatever image
 * the feed happens to serve, survives content churn entirely, and asserts the
 * defect a reader actually sees: the pop.
 *
 * It doubles as the lock on the geometry ever being dropped from the DTO again,
 * which is the regression that produced this in the first place.
 */

import { expect, test } from '../fixtures';

declare global {
  interface Window {
    /** Distinct rendered sizes per image src, in order, recorded from page load. */
    __mentionMediaLayouts?: Map<string, string[]>;
  }
}

/**
 * Above every avatar (36px) and below nothing that matters. Avatars and
 * link-preview thumbnails have fixed geometry and never jumped even before the
 * fix, so including them would only dilute the signal.
 */
const POST_MEDIA_MIN_WIDTH = 200;

/**
 * Only media the DTO actually carried geometry for is held to the
 * one-layout rule, and that distinction is load-bearing rather than a
 * convenience. Persisted geometry covers roughly 64% of recent posts, so an
 * older item that was never enriched has no dimensions to send and legitimately
 * renders a fallback and then jumps. Asserting over every image would make this
 * gate fail on the age of the content it happened to be served, which is not a
 * property of any candidate build.
 *
 * The pair still closes both ways. Geometry disappearing from the DTO again —
 * the original regression — empties this set and trips the floor below.
 * Geometry present but still jumping fails the assertion. And the set widens on
 * its own as backfill coverage grows, without the test being touched.
 */
interface FeedMediaGeometry {
  /** File ids the feed said it knew the dimensions of. */
  readonly withGeometry: Set<string>;
  /** File ids the feed served with no dimensions at all. */
  readonly withoutGeometry: Set<string>;
}

/**
 * How long a post image is given to finish loading. Nothing sleeps for this —
 * it is the ceiling on a poll that resolves as soon as the images are done.
 */
const MEDIA_LOAD_TIMEOUT_MS = 30_000;

test('an image post renders one layout, never a fallback then a jump', async ({
  page,
  candidate,
}) => {
  // Must be installed before navigation. The fallback is painted as soon as the
  // row mounts, so a sampler started from the test body would begin measuring
  // after the very thing it exists to catch.
  await page.addInitScript(() => {
    const layouts = new Map<string, string[]>();
    window.__mentionMediaLayouts = layouts;
    const sample = () => {
      for (const image of Array.from(document.querySelectorAll('img'))) {
        const key = image.currentSrc || image.src;
        if (!key) continue;
        const box = image.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        const size = `${Math.round(box.width)}x${Math.round(box.height)}`;
        const seen = layouts.get(key) ?? [];
        if (seen[seen.length - 1] !== size) seen.push(size);
        layouts.set(key, seen);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  // Read the geometry straight off the feed responses the page is already
  // making. Nothing extra is requested, and it is the DTO the renderer itself
  // consumed rather than a second opinion fetched separately.
  const geometry: FeedMediaGeometry = {
    withGeometry: new Set<string>(),
    withoutGeometry: new Set<string>(),
  };
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin !== 'https://api.mention.earth' || !url.pathname.startsWith('/feed/')) return;
    void response
      .json()
      .then((payload: unknown) => {
        const items = (payload as { data?: { items?: unknown[] } })?.data?.items ?? [];
        for (const item of items) {
          const post = item as {
            content?: { media?: unknown[] };
            attachments?: { media?: unknown[] };
          };
          const media = [...(post.content?.media ?? []), ...(post.attachments?.media ?? [])];
          for (const entry of media) {
            const value = entry as {
              id?: string;
              width?: number;
              height?: number;
              aspectRatio?: number;
            };
            if (!value.id) continue;
            const known = Boolean(value.width && value.height) || Boolean(value.aspectRatio);
            (known ? geometry.withGeometry : geometry.withoutGeometry).add(value.id);
          }
        }
      })
      // A body that cannot be read (aborted, redirected, not JSON) simply
      // contributes nothing; it must never fail the test on its own.
      .catch(() => undefined);
  });

  await page.goto('/');
  await expect(page.locator('[data-post-uri]').first()).toBeVisible();

  const postMedia = () =>
    page.evaluate((minWidth: number) => {
      const layouts = window.__mentionMediaLayouts;
      if (!layouts) return [];
      return [...layouts.entries()]
        .filter(([, sizes]) =>
          sizes.some((size) => Number.parseInt(size, 10) >= minWidth),
        )
        .map(([source, sizes]) => ({ source, sizes }));
    }, POST_MEDIA_MIN_WIDTH);

  // The jump is driven by the image finishing its load — that is the moment the
  // browser learns the real dimensions and replaces the fallback box. So the
  // settle condition is "every post image has loaded", which is a real event
  // rather than a duration, and it doubles as the vacuity floor: a feed that
  // served no post media never satisfies it and cannot read as a pass.
  await expect
    .poll(
      () =>
        page.evaluate((minWidth: number) => {
          const images = Array.from(document.querySelectorAll('img')).filter(
            (image) => image.getBoundingClientRect().width >= minWidth,
          );
          return images.length > 0 && images.every((image) => image.complete);
        }, POST_MEDIA_MIN_WIDTH),
      {
        message: 'the feed must render at least one post image and finish loading it',
        timeout: MEDIA_LOAD_TIMEOUT_MS,
      },
    )
    .toBe(true);

  // Two frames after the last load: the first lets the resulting relayout
  // happen, the second lets the sampler record it. Without this the assertion
  // could read the layout list one frame before the jump it exists to catch.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  const sampled = await postMedia();
  const measured = sampled.filter((media) =>
    [...geometry.withGeometry].some((id) => media.source.includes(id)),
  );

  // Floor. Zero measurable images means the feed sent no dimensions at all —
  // which is the original regression, not a quiet pass.
  expect(
    measured.length,
    `no feed media carried width/height, so nothing here can be measured. ` +
      `The feed described ${geometry.withGeometry.size} item(s) with geometry and ` +
      `${geometry.withoutGeometry.size} without; if that first number is zero the DTO ` +
      `has stopped sending dimensions again.`,
  ).toBeGreaterThan(0);

  const jumped = measured
    .filter((media) => media.sizes.length > 1)
    .map((media) => `${media.source.split('/').pop()}: ${media.sizes.join(' -> ')}`);

  expect(
    jumped,
    'a post image whose dimensions the feed KNEW must settle on a single layout; a ' +
      'second entry is the fallback box being replaced by the real aspect ratio once ' +
      'the bytes arrive, which is the space that should have been reserved up front',
  ).toEqual([]);

  expect(candidate.scriptErrors).toEqual([]);
});
