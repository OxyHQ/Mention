import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * BEHIND IS A MEMORY; AHEAD IS A GUESS.
 *
 * A slide that leaves the live-player window loses its surface, and losing the
 * surface destroys the decoder AND the playhead — so coming back to a video
 * serves a rebuild: black, buffer, restart from zero. Reported from the device
 * as "vuelvo al video anterior y lo vuelve a cargar y tarda", and measured: two
 * swipes forward and one back remounted two surfaces that had been torn down
 * seconds earlier.
 *
 * The two directions are not symmetric. Ahead, the reader may never arrive, and
 * the only thing at stake is buffering lead. Behind, they have already watched
 * it and coming back is deliberate, so the video is expected to be where they
 * left it. A symmetric radius cannot express that, which is why this asserts the
 * ASYMMETRY rather than either number: whoever tunes the radii next should be
 * made to think about which side they are tuning.
 *
 * The ceiling matters as much as the floor. Every retained slide holds a
 * hardware decoder and Android exhausts them silently — later videos simply
 * refuse to load, with no error to catch. So the retained side is bounded here
 * too, and the real answer to "keep more" is to retain the PLAYER without its
 * surface via `stores/videoPlayerRegistry`, not to widen this.
 */

const SCREEN = join(__dirname, '..', '(tabs)', 'videos.tsx');
const screen = readFileSync(SCREEN, 'utf8');

function constant(name: string): number {
  const match = screen.match(new RegExp(`const ${name} = ([^;]+);`));
  if (!match) throw new Error(`${name} is not declared in videos.tsx`);
  // Either a literal or an expression over the other radius.
  const expression = match[1].replace(/ACTIVE_WINDOW_RADIUS/g, String(ahead ?? 0));
  const value = Number(eval(expression));
  if (!Number.isFinite(value)) throw new Error(`${name} did not evaluate to a number`);
  return value;
}

const ahead = Number(screen.match(/const ACTIVE_WINDOW_RADIUS = (\d+);/)?.[1]);

describe('the reel’s live-player window', () => {
  it('declares both directions', () => {
    // The floor: a file with neither constant would make every assertion below
    // vacuous, and the regex would happily match nothing.
    expect(Number.isFinite(ahead)).toBe(true);
    expect(screen).toContain('RETAINED_BEHIND_RADIUS');
  });

  it('keeps a video alive FURTHER BEHIND the reader than ahead', () => {
    expect(constant('RETAINED_BEHIND_RADIUS')).toBeGreaterThan(ahead);
  });

  it('bounds both sides — a decoder is a scarce, silently exhaustible resource', () => {
    const behind = constant('RETAINED_BEHIND_RADIUS');
    // 1 current + ahead + behind is the count of slides that may hold a decoder.
    expect(1 + ahead + behind).toBeLessThanOrEqual(8);
  });

  it('states the rule ONCE, and both lists ask it', () => {
    // The reel has two lists — the native `FlatList` and the web
    // document-scroll map — and they had each written the rule out inline. That
    // is how they drifted: the asymmetry landed on one and left the other
    // symmetric, on the platform it was reported from. Every call site must be
    // the shared function, so a change to the rule cannot reach one list only.
    expect(screen).toMatch(/function isSlideNear\(/);
    const callSites = screen.match(/isNear=\{[^}]*\}/g) ?? [];
    expect(callSites).toHaveLength(2);
    for (const site of callSites) {
      expect(site).toContain('isSlideNear(index, currentVisibleIndex,');
    }
  });

  it('keeps the PiP owner OUT of the distance test', () => {
    // A slide with a Picture-in-Picture window open holds its player however far
    // the reader has scrolled — releasing it would take away the very player the
    // OS window is showing. Written as an early return rather than OR'd into the
    // ternary, where `a ? b : c || d` groups as `a ? b : (c || d)` and would
    // have applied it to slides ahead of the reader only.
    const body = screen.slice(screen.indexOf('function isSlideNear('));
    expect(body.slice(0, 220)).toMatch(/if \(isPipOwner\) return true;/);
  });
});
