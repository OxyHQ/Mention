#!/usr/bin/env node

/**
 * Paints the reader's theme before any JavaScript runs, from Bloom itself.
 *
 *   node scripts/web-theme-prepaint.mjs dist          # write it into dist/index.html
 *   node scripts/web-theme-prepaint.mjs dist --check  # verify it, change nothing
 *
 * WHY: until the 1.5 MB common chunk has run (~12 s on Lighthouse's mobile
 * profile), the document showed `global.css`'s fixed `#0b0b0f`, and then the
 * app's own palette: a dark-to-light flash for every reader in light mode.
 *
 * WHAT: Bloom's `getThemeBootstrap` (the `BloomThemeHead` resources, docs
 * `provider.mdx`), written at the top of `<head>`:
 *  - a `<style>` with the app's default preset (`blue`) in light and dark,
 *    selected by `prefers-color-scheme` and by `data-bloom-theme-mode`;
 *  - a ~1.5 KB synchronous `<script>` that reads the persisted theme
 *    (`mention.bloom.theme`, the same key the provider writes) and sets
 *    `data-bloom-theme-mode` before the body paints.
 * `app/_layout.tsx` passes the SAME configuration as `prepaintTheme`, so the
 * provider adopts the document's paint instead of fighting it. A saved colour
 * preset other than the default is drawn once the app runs: the CSS carries one
 * preset (42 KB raw), not all of them (180 KB).
 *
 * CSP: the page's `script-src` has no `'unsafe-inline'`. The backend serves this
 * document and authorizes exactly this script by its SHA-256, read from the
 * document itself (`webShellDocument.ts`, `themePrepaintScriptHash`). If the
 * hash were ever missing the script would be refused and the CSS alone would
 * still follow the OS preference.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire, register } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Mirrors `app/_layout.tsx` `THEME_PREPAINT` (checked by its test). */
export const THEME_PREPAINT = {
  defaultMode: 'system',
  defaultColorPreset: 'blue',
  persistKey: 'mention.bloom.theme',
};

const MARKER = 'data-bloom-theme-bootstrap';

/**
 * Bloom's prepaint modules are platform-neutral except for one `Platform.OS`
 * read; under Node `react-native` itself cannot load (Flow syntax). Resolve it
 * to a web stub, and resolve Bloom's extensionless relative imports.
 */
const LOADER = `
const RN = 'data:text/javascript,' + encodeURIComponent('export const Platform={OS:"web",select:(o)=>("web" in o?o.web:o.default)};export default {Platform};');
export async function resolve(specifier, context, next) {
  if (specifier === 'react-native') return { url: RN, shortCircuit: true };
  try { return await next(specifier, context); } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') throw error;
    for (const suffix of ['.js', '/index.js']) { try { return await next(specifier + suffix, context); } catch {} }
    throw error;
  }
}`;

let registered = false;

/** Bloom's prepaint modules, loadable under Node. */
async function bloomTheme(file) {
  if (!registered) {
    register(`data:text/javascript,${encodeURIComponent(LOADER)}`);
    registered = true;
  }
  const require = createRequire(import.meta.url);
  const bloomRoot = require.resolve('@oxy.so/bloom/package.json').replace(/package\.json$/, '');
  return import(`${bloomRoot}lib/module/theme/${file}`);
}

/**
 * The tokens a profile's first frame paints with (`backend/.../prerenderProfile.ts`),
 * per Bloom preset and mode: the web shell paints a profile in its owner's
 * colour from these, before the app runs.
 */
export const PROFILE_PALETTE_TOKENS = [
  '--background',
  '--foreground',
  '--card',
  '--muted',
  '--muted-foreground',
  '--border',
  '--primary-text',
  '--surface',
];

/** `{ preset: { light: tokens, dark: tokens } }` for every Bloom preset. */
export async function profilePalettes() {
  const { getPrepaintPalette } = await bloomTheme('prepaint-palettes.js');
  const { APP_COLOR_NAMES } = await bloomTheme('color-presets.js');
  const pick = (vars) =>
    Object.fromEntries(
      PROFILE_PALETTE_TOKENS.map((name) => [name, vars[name]]).filter(([, v]) => v),
    );
  return Object.fromEntries(
    APP_COLOR_NAMES.map((name) => [
      name,
      {
        light: pick(getPrepaintPalette(name, 'light').vars),
        dark: pick(getPrepaintPalette(name, 'dark').vars),
      },
    ]),
  );
}

/** The `<style>` + `<script>` to put at the top of the document head. */
export async function themePrepaintHtml() {
  const { getThemeBootstrap } = await bloomTheme('prepaint.js');
  // The CSS for the default preset only; the script still reads the saved mode.
  const { css } = getThemeBootstrap({ ...THEME_PREPAINT, persistKey: undefined });
  const { script } = getThemeBootstrap(THEME_PREPAINT);
  if (css.includes('</style') || script.includes('</script')) {
    throw new Error('theme prepaint: a resource would close its own element');
  }
  return `<style ${MARKER}>${css}</style><script ${MARKER}>${script}</script>`;
}

/** Insert (or replace) the prepaint right after `<meta charset>`, before every stylesheet. */
export function withThemePrepaint(html, prepaint) {
  const cleaned = html.replace(
    new RegExp(`<style ${MARKER}>[\\s\\S]*?</style><script ${MARKER}>[\\s\\S]*?</script>`),
    '',
  );
  const charset = /<meta charset="utf-8"\s*\/?>/i;
  if (!charset.test(cleaned)) throw new Error('theme prepaint: no <meta charset> in index.html');
  return cleaned.replace(charset, (tag) => `${tag}${prepaint}`);
}

async function main() {
  const [dir, flag] = process.argv.slice(2);
  if (!dir) throw new Error('usage: web-theme-prepaint.mjs <dist> [--check]');
  const file = resolve(dir, 'index.html');
  const html = await readFile(file, 'utf8');
  const next = withThemePrepaint(html, await themePrepaintHtml());
  if (flag === '--check') {
    if (next !== html) {
      console.error(`${file}: theme prepaint is missing or stale`);
      process.exit(1);
    }
    console.log(`${file}: theme prepaint present`);
    return;
  }
  await writeFile(file, next);
  console.log(`${file}: theme prepaint written (${next.length - html.length} bytes added)`);
  const palettes = resolve(dir, 'profile-palettes.json');
  await writeFile(palettes, JSON.stringify(await profilePalettes()));
  console.log(`${palettes}: written`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
