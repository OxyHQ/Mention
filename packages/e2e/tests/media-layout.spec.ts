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
 *
 * WHICH `<img>` IS POST MEDIA is the whole difficulty, and getting it wrong is
 * what took this flow down for eleven hours on 2026-08-01.
 *
 * It first answered "one wider than 200px", which is not a property of post
 * media at all: a link-preview card image renders 278px wide in the feed column.
 * That matters because post media is deliberately lazy — `PostAttachmentMedia`
 * renders it through `<LazyImage threshold={300}>`, which paints a correctly
 * sized placeholder `<View>` and creates NO `<img>` until the cell comes within
 * 300px of the viewport, while link previews render eagerly. So a row can be
 * mounted, laid out, and carrying geometry, and still have no image element to
 * measure. Measured on the build that was blocked: twelve rows mounted, three of
 * them carrying media the DTO had dimensions for, all three past that threshold,
 * and zero of their media `<img>` in the DOM — leaving link previews and the
 * welcome-modal background to satisfy a wait that was supposed to mean "the post
 * images have loaded".
 *
 * It then tried to recover the real set by asking whether a rendered URL
 * CONTAINED a media id, which holds only for native uploads: a federated item's
 * id is its remote URL and its rendered URL is that URL percent-encoded into
 * `/media/proxy?url=…`, so the two never share a substring. Four of the fourteen
 * media entries on one production page were federated, and every one of them was
 * invisible to the gate.
 *
 * Both are gone. The feed states the URL it resolved for each media item, the
 * renderer puts exactly that string in `src` (`PostAttachmentsRow`'s
 * `resolveMediaSrc` prefers `thumbUrl`, then `url`), and so the join is that
 * string — precise for native and federated alike, and dependent on nothing but
 * the DTO's own contract.
 */

import { API_ORIGIN } from '../environment';
import { expect, test } from '../fixtures';

declare global {
  interface Window {
    /** Distinct rendered sizes per image src, in order, recorded from page load. */
    __mentionMediaLayouts?: Map<string, string[]>;
  }
}

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
  /** Rendered URLs the feed said it knew the dimensions of. */
  readonly withGeometry: Set<string>;
  /** Rendered URLs the feed served with no dimensions at all. */
  readonly withoutGeometry: Set<string>;
}

/** The fields of a feed media entry this flow reads. The DTO carries more. */
interface FeedMediaEntry {
  readonly type?: string;
  readonly width?: number;
  readonly height?: number;
  readonly aspectRatio?: number;
  readonly url?: string;
  readonly thumbUrl?: string;
  readonly fullUrl?: string;
}

/**
 * How long a post image is given to finish loading. Nothing sleeps for this —
 * it is the ceiling on a poll that resolves as soon as the images are done.
 */
const MEDIA_LOAD_TIMEOUT_MS = 30_000;

/**
 * How far down the feed the gate will look for a post image the DTO gave
 * dimensions for. Post media only becomes an `<img>` within `LazyImage`'s 300px
 * threshold of the viewport (see the header), so media further down the page
 * cannot be measured until it is scrolled towards, however many rows the list
 * has mounted.
 *
 * This is a bounded search for the subject, not a retry of the assertion: the
 * verdict below is passed over everything the sampler recorded along the way,
 * and running out of screens is a failure with its own message rather than a
 * quiet pass.
 */
const MAX_FEED_SCREENS = 8;

/**
 * Paces the scroll so the list can mount the rows it just scrolled over and
 * their media can cross the lazy threshold. It is not a wait on a condition —
 * the condition is re-checked at the top of every iteration and the loop leaves
 * the moment it holds; this only stops the loop from spending its whole budget
 * in one frame.
 */
const FEED_MOUNT_SETTLE_MS = 400;

/**
 * Feed media renders as an `<img>` only for these types. A video renders a
 * `<video>` plus a separate poster image, whose layout is the player's and not
 * this flow's subject.
 */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'gif']);

/**
 * Files the media entry down the geometry it was served with, under every URL
 * the renderer could put in `src` for it.
 */
function indexMediaEntry(entry: FeedMediaEntry, into: FeedMediaGeometry): void {
  // Mirrors the renderer, which treats a missing type as an image.
  if (!IMAGE_MEDIA_TYPES.has(entry.type ?? 'image')) return;
  const known = Boolean(entry.width && entry.height) || Boolean(entry.aspectRatio);
  const bucket = known ? into.withGeometry : into.withoutGeometry;
  for (const source of [entry.thumbUrl, entry.url, entry.fullUrl]) {
    if (source) bucket.add(source);
  }
}

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
    if (url.origin !== API_ORIGIN || !url.pathname.startsWith('/feed/')) return;
    void response
      .json()
      .then((payload: unknown) => {
        const items = (payload as { data?: { items?: unknown[] } })?.data?.items ?? [];
        for (const item of items) {
          const post = item as {
            content?: { media?: FeedMediaEntry[] };
            attachments?: { media?: FeedMediaEntry[] };
          };
          const media = [...(post.content?.media ?? []), ...(post.attachments?.media ?? [])];
          for (const entry of media) indexMediaEntry(entry, geometry);
        }
      })
      // A body that cannot be read (aborted, redirected, not JSON) simply
      // contributes nothing; it must never fail the test on its own.
      .catch(() => undefined);
  });

  await page.goto('/');
  await expect(page.locator('[data-post-uri]').first()).toBeVisible();

  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error('the browser gate needs a viewport to scroll the feed by; none was configured');
  }

  /**
   * The images currently on screen that this flow can hold to the one-layout
   * rule: the ones the feed resolved a URL for AND told us the dimensions of.
   * Read live from the DOM rather than from the sampler, because whether an
   * image has finished loading is the thing being waited on.
   */
  const measurableImages = () =>
    page.evaluate(
      (sources: string[]) => {
        const known = new Set(sources);
        return Array.from(document.querySelectorAll('img'))
          .map((image) => ({ source: image.currentSrc || image.src, complete: image.complete }))
          .filter((image) => known.has(image.source));
      },
      [...geometry.withGeometry],
    );

  // Bring one within the lazy threshold. Until then the media cell is a
  // correctly sized placeholder `<View>` and there is no image element at all.
  let onScreen = await measurableImages();
  for (let screen = 0; screen < MAX_FEED_SCREENS && onScreen.length === 0; screen += 1) {
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.wheel(0, viewport.height);
    await page.waitForTimeout(FEED_MOUNT_SETTLE_MS);
    onScreen = await measurableImages();
  }

  // Floor, and it comes FIRST so that it — not a bare poll timeout — is what
  // speaks when there is nothing to measure. Zero measurable images means either
  // the feed sent no dimensions at all (the original regression) or it sent them
  // and the page painted none of that media; the two are different bugs owned by
  // different people, so they get different sentences.
  expect(
    onScreen.length,
    geometry.withGeometry.size === 0
      ? `no feed media carried width/height, so nothing here can be measured. The feed described ` +
          `${geometry.withoutGeometry.size} media item(s), none of them with dimensions: the DTO ` +
          `has stopped sending them again.`
      : `the feed described ${geometry.withGeometry.size} media URL(s) with geometry and ` +
        `${geometry.withoutGeometry.size} without, but none of them rendered within ` +
        `${MAX_FEED_SCREENS} screens of feed. The DTO is intact, so this is the page not ` +
        `painting the media it was given.`,
  ).toBeGreaterThan(0);

  // The jump is driven by the image finishing its load — that is the moment the
  // browser learns the real dimensions and replaces the fallback box. So the
  // settle condition is "every measurable post image has loaded", which is a
  // real event rather than a duration. The floor above guarantees there is one
  // to wait for, so this can only expire on media that genuinely never loads.
  await expect
    .poll(
      async () => {
        const loading = await measurableImages();
        return loading.length > 0 && loading.every((image) => image.complete);
      },
      {
        message: 'a post image the feed sent dimensions for never finished loading',
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

  const sampled = await page.evaluate(() => {
    const layouts = window.__mentionMediaLayouts;
    if (!layouts) return [];
    return [...layouts.entries()].map(([source, sizes]) => ({ source, sizes }));
  });
  // Everything the sampler saw over the whole run, not just what is on screen
  // now — a row scrolled past was still measured while it was mounted.
  const measured = sampled.filter((media) => geometry.withGeometry.has(media.source));

  // Second floor, on the sampler rather than the DOM. The floor above proves a
  // subject was on screen; this proves the sampler actually recorded it, so that
  // a sampler that silently stopped running cannot make the verdict below pass
  // by having nothing left to judge.
  expect(
    measured.length,
    `${onScreen.length} post image(s) the feed sent dimensions for were on screen, but the ` +
      `layout sampler recorded none of them — it is the sampler that has stopped working, not ` +
      `the page.`,
  ).toBeGreaterThan(0);

  // Named by the whole URL. A federated item's is the remote one percent-encoded
  // into a proxy query, so there is no last path segment worth shortening to.
  const jumped = measured
    .filter((media) => media.sizes.length > 1)
    .map((media) => `${media.source}: ${media.sizes.join(' -> ')}`);

  expect(
    jumped,
    'a post image whose dimensions the feed KNEW must settle on a single layout; a ' +
      'second entry is the fallback box being replaced by the real aspect ratio once ' +
      'the bytes arrive, which is the space that should have been reserved up front',
  ).toEqual([]);

  expect(candidate.scriptErrors).toEqual([]);
});
