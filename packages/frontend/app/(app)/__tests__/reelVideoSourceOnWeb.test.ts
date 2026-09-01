import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A source the browser cannot decode must never reach the element.
 *
 * The reel prefers the server's adaptive `hlsUrl` when there is one. A browser
 * can only play that if it decodes the playlist itself (Safari) or if something
 * feeds it to hls.js — and this screen does neither, it assigns the URL to the
 * element. What that produces is not an error: the element sits in
 * `networkState` LOADING with `readyState` 0, no `error`, and `paused === false`
 * for as long as anyone watches. Measured on the deployed build, 29 seconds with
 * `currentTime` at zero.
 *
 * That silence is the reason this is worth a gate. `useReelChrome` swaps to
 * `fallbackVideoUrl` when the player reports `status === 'error'`, so a source
 * that never errors is never replaced; and every rule we own that asks whether
 * the video is playing asks `paused`, which says yes. The defect is invisible to
 * the app and to its checks, and it reached production.
 *
 * It reads the SOURCE, and the limitation is worth stating: it proves the guard
 * is written, not that it runs. The behavioural half is
 * `packages/e2e/perf/reel-open.mjs source`, which enters the reel with no flight
 * and judges the POSITION rather than `paused` — it cannot run in CI, and this
 * can.
 */

const SCREEN = join(__dirname, '..', 'videos.tsx');
const CHROME = join(__dirname, '..', '..', '..', 'hooks', 'useReelChrome.ts');
/** The screen that DOES decode HLS in JS — the positive control for the detector below. */
const DECODES = join(__dirname, '..', '..', '..', 'components', 'common', 'VideoPlayer.tsx');

/**
 * Does this file hand its source to hls.js? An IMPORT, not a mention: the first
 * version of this asked whether the text `useHlsPlayback` appeared anywhere, and
 * the comment explaining the guard says the words — so the detector answered
 * yes, the check excused itself, and it passed with the guard deleted.
 */
const decodesHlsInJs = (file: string): boolean => /import[^;]*\buseHlsPlayback\b[^;]*from/.test(file);

describe('the reel only prefers a source it can play', () => {
  const screen = readFileSync(SCREEN, 'utf8');
  const chrome = readFileSync(CHROME, 'utf8');

  it('reads the files that decide it, and can tell a decoder from a mention of one', () => {
    // A vacuity floor: a renamed or moved file must fail here rather than make
    // every assertion below trivially true.
    expect(screen.length).toBeGreaterThan(1_000);
    expect(screen).toContain('resolveVideoUrl');
    expect(chrome).toContain('replaceAsync');
    // And the escape hatch below must be able to fire at all: the one screen
    // that really does decode HLS in JS has to read as such.
    expect(decodesHlsInJs(readFileSync(DECODES, 'utf8'))).toBe(true);
  });

  it('prefers the HLS stream only where something can decode it', () => {
    const prefers = screen.match(/if\s*\(([^)]*)\)\s*return\s+ref\??\.hlsUrl/);
    if (!prefers) return; // the preference is gone entirely — nothing to guard

    // If the reel ever routes its source through the JS decoder the way
    // `components/common/VideoPlayer.tsx` does, the preference becomes
    // honourable on web and this guard should go with it.
    if (decodesHlsInJs(screen) || decodesHlsInJs(chrome)) return;

    expect(prefers[1]).toMatch(/Platform\.OS !== 'web'/);
  });
});
