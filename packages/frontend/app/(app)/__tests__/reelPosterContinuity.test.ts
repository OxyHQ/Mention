import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE POSTER MUST NOT CHANGE WHEN A ROW CROSSES INTO THE LIVE-PLAYER WINDOW.
 *
 * A reel row draws a poster on both sides of that window: the slide draws it
 * while the row holds no decoder, and the surface draws it until the video's
 * first frame lands. Crossing the boundary swaps which of the two is mounted —
 * mid-scroll, on the frame the reader is watching.
 *
 * They were two separate copies of the markup, and they had drifted: the
 * in-window copy carried `transition={150}`. So entering the window unmounted a
 * poster that was already painted and faded its replacement in from nothing,
 * over 150ms, against the muted background — with nothing to reveal, because it
 * is the same URL out of the same memory cache. That is a flash on every row on
 * every scroll, which is how it was reported ("los vídeos parpadean según hago
 * scroll") and it is invisible to every other check: both copies render, both
 * load, and no test compares them to each other.
 *
 * So this compares them to each other. It reads the SOURCE and asserts the two
 * call sites pass the SAME prop names to the same component — the drift itself,
 * rather than any one copy being right. It cannot prove the pixels match; the
 * behavioural half is a device capture, and this is what can run in CI.
 */

const SCREEN = join(__dirname, '..', '(tabs)', 'videos.tsx');
const CHROME = join(__dirname, '..', '..', '..', 'hooks', 'useReelChrome.ts');

const screen = readFileSync(SCREEN, 'utf8');
const chrome = readFileSync(CHROME, 'utf8');

/** Every `<ReelPoster … />` call site, as its set of prop names. */
function posterCallSites(source: string): string[][] {
  return [...source.matchAll(/<ReelPoster\b([^>]*?)\/>/gs)].map((match) =>
    [...match[1].matchAll(/(\w+)=/g)].map((prop) => prop[1]).sort(),
  );
}

describe('the reel’s poster, across the live-player window', () => {
  it('is drawn by ONE component, from both sides', () => {
    const definitions = screen.match(/const ReelPoster\s*=/g) ?? [];
    expect(definitions).toHaveLength(1);

    // The vacuity floor: two call sites, or this suite is asserting nothing.
    // One would mean a branch stopped drawing a poster at all.
    expect(posterCallSites(screen)).toHaveLength(2);
  });

  it('is given the same props by both, so crossing the window changes nothing', () => {
    const sites = posterCallSites(screen);
    // Its own floor, not the previous test's: with no call sites at all this
    // would compare `undefined` to `undefined` and pass while the poster was
    // written out twice by hand — which is the state it exists to reject.
    expect(sites).toHaveLength(2);
    const [inWindow, outOfWindow] = sites;
    expect(inWindow).toEqual(outOfWindow);
  });

  it('never animates itself in — the pixels it replaces are already the same', () => {
    // Scoped to the poster component, not the file: other images in the reel
    // may legitimately transition.
    const definition = screen.slice(screen.indexOf('const ReelPoster'));
    const body = definition.slice(0, definition.indexOf('ReelPoster.displayName'));
    expect(body).toContain('cachePolicy="memory-disk"');
    expect(body).not.toMatch(/transition=/);
  });

  it('keeps the poster’s failure in ONE place, and it is not the surface', () => {
    // The row outlives the surface and draws the same poster after it is gone,
    // so an answer learned in the surface was thrown away on every scroll — and
    // held twice, the two copies could disagree about one image.
    expect(chrome).not.toMatch(/posterFailed/);
    expect(screen.match(/useState\(false\);?\s*$/gm)?.length ?? 0).toBeGreaterThan(0);
    expect(screen.match(/const \[posterFailed/g) ?? []).toHaveLength(1);
  });
});
