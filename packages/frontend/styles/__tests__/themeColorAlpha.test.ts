import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Bloom theme tokens must never carry a hex-alpha suffix in inline style.
 *
 * Bloom derives every accent and neutral role through its tonal colour engine
 * and hands them out as CSS `rgb(r g b)` STRINGS — `theme.colors.primary` is
 * `'rgb(0 98 157)'`, not `'#00629d'`. Appending two hex digits to one of those
 * (`` `${theme.colors.primary}30` ``, `theme.colors.primary + '1A'`) therefore
 * does not produce an 8-digit hex colour; it produces `'rgb(0 98 157)30'`, which
 * react-native-web parses back as the FULLY OPAQUE base colour. The control is
 * then painted at 100% of a colour that was meant to be a 10–20% wash, and when
 * its own label uses the same token — the common `bg-primary` + `text-primary`
 * pairing — the result is primary text on solid primary: contrast ratio 1.00, an
 * invisible control. Nothing errors, tsc is happy, and a jest assertion that the
 * label rendered still passes, which is precisely why this needs a source gate.
 *
 * The ONE family this does not apply to is `STATUS_COLORS` (`error`, `success`,
 * `warning`, `info`), which Bloom keeps as plain `#rrggbb` literals — there the
 * suffix really does yield a valid 8-digit hex and the alpha applies. Local
 * hard-coded hex palettes (e.g. `SEVERITY_COLORS` in `LabelBadge`) are correct
 * for the same reason, so this scanner keys on `colors.<role>` rather than on
 * "a template literal followed by two hex digits".
 *
 * The fix is the NativeWind opacity class (`bg-primary/10`, `border-primary/25`),
 * which composites through the CSS pipeline instead of string-appending.
 */

const FRONTEND_ROOT = path.resolve(__dirname, '../..');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIPPED_DIRECTORIES = new Set([
  '__tests__',
  'coverage',
  'node_modules',
  '.expo',
  'android',
  'ios',
  'dist',
]);

/** Roles Bloom keeps as plain hex, where a hex-alpha suffix is legitimate. */
const STATUS_ROLES = new Set(['error', 'success', 'warning', 'info']);

/**
 * `colors.<role>` — via any receiver (`theme.colors.x`, a destructured
 * `colors.x`) — immediately followed by a two-hex-digit alpha, in either the
 * template-literal or the string-concatenation spelling.
 */
const TOKEN_ALPHA_PATTERN =
  /(?:\$\{[^}]*\bcolors\.([A-Za-z][A-Za-z0-9]*)\}|\bcolors\.([A-Za-z][A-Za-z0-9]*)\s*\+\s*['"])[0-9A-Fa-f]{2}\b/g;

/** Enough of the file to prove which token is being suffixed, in the report. */
const REPORT_EXCERPT_LENGTH = 160;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(absolutePath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files;
}

/**
 * Comments are stripped before scanning: several call sites carry a note
 * spelling out the wrong form so the next reader knows what NOT to write, and a
 * gate that flagged its own documentation would push people to delete it.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Every offending line of one source, reported in full so the token is visible. */
export function findTokenAlphaOffenders(source: string): string[] {
  const offenders: string[] = [];
  for (const line of withoutComments(source).split('\n')) {
    TOKEN_ALPHA_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(TOKEN_ALPHA_PATTERN)) {
      const role = match[1] ?? match[2];
      if (role !== undefined && STATUS_ROLES.has(role)) continue;
      offenders.push(line.trim().slice(0, REPORT_EXCERPT_LENGTH));
    }
  }
  return offenders;
}

describe('Bloom theme colour tokens are never hex-alpha composited', () => {
  const files = sourceFiles(FRONTEND_ROOT);

  it('scans the whole frontend source tree', () => {
    // Vacuity floor: a broken traversal must fail loudly rather than report a
    // clean sweep over nothing.
    expect(files.length).toBeGreaterThan(400);
  });

  it('flags an accent token with a hex-alpha suffix, in both spellings', () => {
    // The detector's own mutation test. Break it and these fail, so a scan that
    // reports zero offenders below is reporting a real property of the tree.
    expect(
      findTokenAlphaOffenders('backgroundColor: `${theme.colors.primary}30`'),
    ).toHaveLength(1);
    expect(findTokenAlphaOffenders("const bg = theme.colors.primary + '1A';")).toHaveLength(1);
    expect(findTokenAlphaOffenders('color: `${theme.colors.border}33`')).toHaveLength(1);
  });

  it('leaves STATUS_COLORS and local hex palettes alone', () => {
    expect(findTokenAlphaOffenders("backgroundColor: theme.colors.error + '15'")).toEqual([]);
    expect(findTokenAlphaOffenders('backgroundColor: `${theme.colors.info}14`')).toEqual([]);
    // `SEVERITY_COLORS` and friends are real `#rrggbb` literals.
    expect(findTokenAlphaOffenders('backgroundColor: `${color}12`')).toEqual([]);
  });

  it('has no occurrence in the frontend source tree', () => {
    const offenders = files.flatMap((file) => {
      const lines = findTokenAlphaOffenders(fs.readFileSync(file, 'utf8'));
      return lines.map((line) => `${path.relative(FRONTEND_ROOT, file)}: ${line}`);
    });

    expect(offenders).toEqual([]);
  });
});
