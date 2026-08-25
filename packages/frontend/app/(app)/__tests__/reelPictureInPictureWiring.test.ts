import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A control that is painted must be able to act.
 *
 * The reel's Picture-in-Picture button is shown when `showPipButton` says the
 * platform supports it, and pressing it calls
 * `videoViewRef.current?.startPictureInPicture()`. The optional chain is there
 * for a real case — the view can be unmounted — which means a ref that is NEVER
 * attached produces exactly the same nothing: the button paints, the press does
 * nothing, and there is no error and no log. That is how it regressed when the
 * media moved into a shared node and this screen stopped rendering a `VideoView`
 * of its own.
 *
 * So the invariant is a relation between two places, which is why it cannot live
 * in `useReelChrome`: the hook creates the ref and decides the button, but only
 * the screen can attach it, and the hook has no way to find out whether it did.
 *
 * This reads the SOURCE, which is a real limitation and worth stating: it is
 * satisfied by the text `ref={videoViewRef}` appearing anywhere in the file, so
 * it proves the ref is handed to something, not that the something is the video.
 * It fails on the regression it was written for, and a stronger version would
 * render the screen and press the button — worth doing if this ever passes while
 * PiP is still broken.
 */

const SCREEN = join(__dirname, '..', 'videos.tsx');

describe('the reel offers Picture-in-Picture only if it can start it', () => {
  const source = readFileSync(SCREEN, 'utf8');

  it('reads a screen that is really there', () => {
    // A vacuity floor: a renamed or moved file must fail here rather than make
    // every assertion below trivially true.
    expect(source.length).toBeGreaterThan(1_000);
    expect(source).toContain('useReelChrome');
  });

  it('attaches the ref its PiP handler acts on, whenever it paints the button', () => {
    const paintsButton = source.includes('showPipButton');
    if (!paintsButton) return; // nothing offered, nothing to honour

    expect(source).toMatch(/ref=\{videoViewRef\}/);
  });
});
