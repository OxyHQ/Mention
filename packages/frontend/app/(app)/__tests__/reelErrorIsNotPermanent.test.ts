import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A FAILED LOAD IS A MOMENT, NOT A VERDICT.
 *
 * The reel's row holds `videoError`, and it does two things: it unmounts the
 * decoder-bearing surface (`canRenderPlayer`) and paints "Video unavailable".
 * Nothing ever cleared it. The row stays mounted three slides behind the active
 * one, so a single failure — a `/media/proxy` 404 while the cache front was
 * inert, a busy decoder, a second without network — condemned that slide for as
 * long as the reader kept scrolling around it. Reported from the device as
 * "si voy arriba abajo arriba abajo … a veces los videos me pone Video
 * unavailable".
 *
 * Arriving on the slide again is the retry: a fresh intent to watch, a remounted
 * surface with a new player, and a bound the viewer sets themselves. A genuinely
 * dead video fails again immediately and says so again.
 *
 * This is asserted against the source because `VideoItem` is internal to the
 * screen and reaching it from jest means mounting the whole reel — the same
 * reason `reelLiveWindow.test.ts` reads the file. It is written so that deleting
 * the reset, or making it unconditional, fails.
 */

const SCREEN = join(__dirname, '..', '(tabs)', 'videos.tsx');
const screen = readFileSync(SCREEN, 'utf8');

/** The row's body: from its declaration to the surface it renders. */
function rowSource(): string {
  const start = screen.indexOf('const VideoItem = memo<VideoItemProps>');
  expect(start).toBeGreaterThan(-1);
  const end = screen.indexOf("ActiveVideoSurface.displayName", start);
  return screen.slice(start, end === -1 ? undefined : end);
}

describe('a reel slide that failed to load', () => {
  it('still has an error state that unmounts the player', () => {
    // The floor. Without this the assertions below are about nothing: an error
    // that no longer gates the player is a different design, and this test would
    // pass while saying something untrue.
    const row = rowSource();
    expect(row).toContain('const [videoError, setVideoError] = useState(false)');
    expect(row).toMatch(/canRenderPlayer\s*=\s*isNear\s*&&\s*!videoError/);
    expect(row).toContain('setVideoError(true)');
  });

  it('clears the error when the reader comes back to the slide', () => {
    const row = rowSource();
    const reset = row.match(/if\s*\(isActive\s*&&\s*videoError\)\s*\{\s*setVideoError\(false\);\s*\}/);
    expect(reset).not.toBeNull();
  });

  it('clears it on the activation EDGE, not on every render while active', () => {
    // An unconditional clear would erase the badge the moment it was raised, and
    // a clear on every active render would fight the error handler in a loop.
    // The reset belongs to the transition, tracked the way the poster reset is.
    const row = rowSource();
    const edge = row.indexOf('if (prevIsActive !== isActive)');
    expect(edge).toBeGreaterThan(-1);
    expect(row.indexOf('setVideoError(false)')).toBeGreaterThan(edge);
    expect(row).toContain('const [prevIsActive, setPrevIsActive] = useState(isActive)');
    expect(row).toContain('setPrevIsActive(isActive)');
  });
});
