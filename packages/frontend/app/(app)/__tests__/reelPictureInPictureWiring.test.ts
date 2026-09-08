import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** PiP follows app backgrounding; the reel no longer paints a duplicate control. */

const SCREEN = join(__dirname, '..', '(tabs)', 'videos.tsx');
const CHROME = join(__dirname, '..', '..', '..', 'hooks', 'useReelChrome.ts');

describe('the reel enters Picture-in-Picture automatically', () => {
  const source = readFileSync(SCREEN, 'utf8');
  const chrome = readFileSync(CHROME, 'utf8');

  it('reads a screen that is really there', () => {
    // A vacuity floor: a renamed or moved file must fail here rather than make
    // every assertion below trivially true.
    expect(source.length).toBeGreaterThan(1_000);
    expect(source).toContain('useReelChrome');
  });

  it('attaches the watched video and delegates automatic entry to expo-video', () => {
    expect(source).toMatch(/ref=\{videoViewRef\}/);
    expect(source).toContain('allowsPictureInPicture={isWatched}');
    expect(source).toContain('startsPictureInPictureAutomatically={isWatched}');
    expect(source).not.toContain('showPipButton');
    expect(source).not.toContain('startPictureInPicture()');
  });

  it('keeps PiP and volume controls off the video chrome', () => {
    expect(source).not.toContain('styles.pipButton');
    expect(source).not.toContain('styles.muteButton');
    expect(chrome).toContain('if (muted) {');
    expect(chrome).toContain('onMutedChange(false)');
  });
});
