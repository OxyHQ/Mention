import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FRONTEND = join(__dirname, '..', '..', '..');

// Production source only. Tests are excluded because a check that names the
// identifier it forbids would otherwise match itself — and because a test is
// allowed to talk about code that no longer exists.
const SKIPPED_DIRS = new Set(['node_modules', '.expo', 'dist', '__tests__', '__mocks__']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const SOURCE_FILES = walk(join(FRONTEND, 'components')).concat(
  walk(join(FRONTEND, 'app')),
  walk(join(FRONTEND, 'hooks')),
);

function read(...segments: string[]): string {
  return readFileSync(join(FRONTEND, ...segments), 'utf8');
}

/**
 * Source with comments removed.
 *
 * A grep for a removed identifier has to distinguish USING it from RECORDING
 * that it is gone — the docstrings that explain why `minimalistMode` was
 * deleted name it, and a check that cannot tell those apart either fires on
 * every honest explanation or forces the explanations out of the code.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * A channel's page and a person's page are two SCREENS, not one screen with
 * conditions. These assertions pin the parts of that separation that a future
 * edit could quietly undo — each one names a defect that was reported, so a
 * failure here says which symptom is coming back.
 */
describe('channel and person profiles are separate screens', () => {
  // Vacuity floor: a broken walk would make every "does not contain" assertion
  // below pass by scanning nothing.
  it('scanned a plausible number of source files', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(300);
  });

  /**
   * DEFECT: the poke button appeared on a channel.
   *
   * A poke is addressed to a person, and `isActAsEligibleKind` refuses
   * `channel`, so nobody is ever signed in as one to receive it. The fix is
   * structural: the channel's header components do not render a poke, so there
   * is no flag to get wrong and no `isChannel` prop threaded through a shared
   * component to forget at a call site.
   */
  it('never reaches the poke from the channel screen', () => {
    const channelSources = [
      read('components', 'ChannelScreen.tsx'),
      read('components', 'Profile', 'ChannelHeader.tsx'),
    ];
    for (const source of channelSources) {
      expect(code(source)).not.toMatch(/\busePoke\b/);
    }
  });

  it('keeps the poke on the person header, so the check above is not vacuous', () => {
    // Without this, deleting the poke everywhere would satisfy the assertion
    // above while removing the feature.
    expect(read('components', 'Profile', 'ProfileHeader.tsx')).toMatch(/usePoke/);
  });

  it('imports usePoke from exactly one component', () => {
    const importers = SOURCE_FILES.filter((file) =>
      /from '\.\/hooks\/usePoke'|from '@\/components\/Profile\/hooks\/usePoke'/.test(
        readFileSync(file, 'utf8'),
      ),
    ).map((f) => f.slice(FRONTEND.length + 1));

    expect(importers).toEqual([join('components', 'Profile', 'ProfileHeader.tsx')]);
  });

  /**
   * The canonicalization between `/@` and `/c/` is the ONE piece that cannot be
   * duplicated: two screens each deciding where to redirect can build a bounce
   * loop between them. Both screens must reach it through the shared helper.
   */
  it('routes both screens through the one canonicalization', () => {
    for (const screen of ['ProfileScreen.tsx', 'ChannelScreen.tsx']) {
      const source = code(read('components', screen));
      expect(source).toMatch(/useProfileAccount\(/);
      expect(source).toMatch(/canonicalHref/);
      // A screen that builds its own redirect target has left the shared rule.
      expect(source).not.toMatch(/<Redirect href={`/);
    }
  });

  /**
   * `design.minimalistMode` was a LAYOUT name for an account fact — it was
   * defined as `kind === 'channel'` — and selecting the header off it is what
   * made the two screens one. It is gone; nothing should reintroduce it.
   */
  it('has no minimalistMode flag left anywhere', () => {
    const offenders = SOURCE_FILES.filter((file) =>
      /\bminimalistMode\b/.test(code(readFileSync(file, 'utf8'))),
    ).map((f) => f.slice(FRONTEND.length + 1));

    expect(offenders).toEqual([]);
  });

  /**
   * DEFECT: rows on a channel page opened person-shaped URLs.
   *
   * The shared rows (joined date, follower/following counts) must not build a
   * URL family of their own — they are rendered by both screens and cannot know
   * which one they are on. Each takes an explicit href instead.
   */
  it('keeps the URL family out of the shared meta and stats rows', () => {
    for (const row of ['ProfileMeta.tsx', 'ProfileStats.tsx']) {
      const source = code(read('components', 'Profile', row));
      expect(source).not.toMatch(/`\/@\$\{/);
      expect(source).not.toMatch(/`\/c\/\$\{/);
    }
  });
});
