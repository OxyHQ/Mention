#!/usr/bin/env node

/**
 * Preloads the web font the first paint uses, from the export itself.
 *
 *   node scripts/web-font-preload.mjs dist          # write the preload into dist/index.html
 *   node scripts/web-font-preload.mjs dist --check  # verify it, change nothing
 *
 * WHY: Bloom registers its `@font-face` rules from JavaScript (`applyFontFaces`),
 * so without a hint the browser cannot discover `InterVariable.woff2` until the
 * common chunk has downloaded and run and the first text has been laid out. On
 * a cold load of mention.earth that put the font request at ~2.67 s, after the
 * whole 1.7 s common chunk. A `<link rel="preload">` in the static HTML lets
 * the preload scanner start it with the scripts.
 *
 * WHY HERE: the URL is content-hashed by Metro (`/assets/__node_modules/@oxy.so/
 * bloom/.../InterVariable.<md5>.woff2`), so it only exists once `expo export`
 * has run, and `public/index.html` is a template that cannot name it. The
 * served HTML is always `dist/index.html`: the shell Worker serves it, and the
 * backend (`apexFrontendProxy`, `webShell.routes`) fetches that same file and
 * only adds tags before `</head>`. Writing the hint into it at build time
 * reaches every path with no runtime scanning.
 *
 * WHERE THE URL COMES FROM: not from a directory listing. The export can carry
 * font files the app never requests, and a preload for a URL nothing uses is a
 * wasted download plus a console warning. So the href is the exact string
 * literal the startup JavaScript (the `<script src>` tags in `index.html`)
 * hands to `@font-face`, and it must name a file that exists in the export. The
 * preload and the `@font-face` request are then byte-for-byte the same URL, and
 * `crossorigin` (anonymous) matches the CORS mode every font fetch uses, so the
 * browser reuses the preloaded response instead of downloading it twice.
 *
 * WHICH FONTS: only the ones the first paint renders. Measured on a local
 * production export at `/`, `/explore` and `/@oxy`: `document.fonts` loads
 * Inter and nothing else; BlomusModernus (display) and JetBrains Mono are
 * registered but unused there. Preloading them would spend ~195 KB of early
 * bandwidth competing with the common chunk for fonts no first screen shows.
 */

import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Font files (Bloom asset basenames, before Metro's hash) the first paint uses. */
export const FIRST_PAINT_FONTS = ['InterVariable'];

/** Marker so a second run neither duplicates nor silently keeps a stale tag. */
const MARKER = 'data-first-paint-font';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Same-origin script paths `index.html` loads at startup, in document order. */
export function startupScripts(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc="(\/[^"]+\.js)"/g)].map((match) => match[1]);
}

/**
 * The URLs the startup JavaScript uses for `fontName`: string literals of the
 * form `"/assets/…/<fontName>.<32-hex>.woff2"`. Returns the distinct set.
 */
export function fontUrlsInSources(sources, fontName) {
  const literal = new RegExp(
    `["'](/assets/[^"'\\s]*/${escapeRegExp(fontName)}\\.[0-9a-f]{32}\\.woff2)["']`,
    'g',
  );
  const urls = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(literal)) urls.add(match[1]);
  }
  return [...urls];
}

export function preloadTag(href) {
  return `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin ${MARKER}>`;
}

/** Existing first-paint font preload hrefs in `html`. */
export function preloadHrefs(html) {
  const tags = html.match(new RegExp(`<link\\b[^>]*\\b${MARKER}\\b[^>]*>`, 'g')) ?? [];
  return tags.map((tag) => tag.match(/\bhref="([^"]+)"/)?.[1]).filter(Boolean);
}

/**
 * Put exactly `hrefs` as first-paint preloads in the `<head>`, replacing any
 * earlier ones. Placed right after `<meta charset>`, ahead of every other
 * resource, so the preload scanner queues the font with the first requests.
 */
export function injectPreloads(html, hrefs) {
  const withoutOld = html.replace(
    new RegExp(`[ \\t]*<link\\b[^>]*\\b${MARKER}\\b[^>]*>\\n?`, 'g'),
    '',
  );
  const tags = hrefs.map((href) => `    ${preloadTag(href)}\n`).join('');
  const charset = /<meta\s+charset=[^>]*>\n?/i;
  if (!charset.test(withoutOld)) {
    throw new Error('index.html has no <meta charset> to anchor the font preload after');
  }
  return withoutOld.replace(
    charset,
    (meta) => `${meta.endsWith('\n') ? meta : `${meta}\n`}${tags}`,
  );
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the href for each first-paint font from an export directory.
 * Returns `{ hrefs, failures }`; any failure means no preload can be trusted.
 */
export async function resolveFontHrefs(outputDirectory, fonts = FIRST_PAINT_FONTS) {
  const failures = [];
  const indexPath = resolve(outputDirectory, 'index.html');
  if (!(await exists(indexPath))) {
    return { hrefs: [], failures: ['index.html is missing'] };
  }
  const html = await readFile(indexPath, 'utf8');
  const scripts = startupScripts(html);
  if (scripts.length === 0) {
    return { hrefs: [], failures: ['index.html loads no same-origin <script src>'] };
  }
  const sources = await Promise.all(
    scripts.map((src) => readFile(resolve(outputDirectory, `.${decodeURI(src)}`), 'utf8')),
  );
  const hrefs = [];
  for (const font of fonts) {
    const urls = fontUrlsInSources(sources, font);
    if (urls.length !== 1) {
      failures.push(
        `expected the startup JavaScript to reference exactly one ${font}.<hash>.woff2, ` +
          `found ${urls.length}${urls.length ? `: ${urls.join(', ')}` : ''}`,
      );
      continue;
    }
    const [href] = urls;
    if (!(await exists(resolve(outputDirectory, `.${decodeURI(href)}`)))) {
      failures.push(`${href} is referenced by the startup JavaScript but is not in the export`);
      continue;
    }
    hrefs.push(href);
  }
  return { hrefs, failures };
}

/** Verify `index.html` preloads exactly the first-paint fonts. Returns failures. */
export async function checkFontPreloads(outputDirectory, fonts = FIRST_PAINT_FONTS) {
  const { hrefs, failures } = await resolveFontHrefs(outputDirectory, fonts);
  if (failures.length > 0) return failures;
  const html = await readFile(resolve(outputDirectory, 'index.html'), 'utf8');
  const present = preloadHrefs(html);
  const missing = hrefs.filter((href) => !present.includes(href));
  const extra = present.filter((href) => !hrefs.includes(href));
  for (const href of missing) {
    failures.push(
      `index.html does not preload ${href} (run scripts/web-font-preload.mjs after expo export)`,
    );
  }
  for (const href of extra) {
    failures.push(`index.html preloads ${href}, which the startup JavaScript does not use`);
  }
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const outputDirectory = resolve(args.find((arg) => !arg.startsWith('--')) ?? 'dist');

  if (check) {
    const failures = await checkFontPreloads(outputDirectory);
    if (failures.length > 0) {
      console.error(`Font preload check failed for ${outputDirectory}:`);
      for (const failure of failures) console.error(`- ${failure}`);
      process.exit(1);
    }
    console.log(`index.html preloads the first-paint fonts: ${outputDirectory}`);
    return;
  }

  const { hrefs, failures } = await resolveFontHrefs(outputDirectory);
  if (failures.length > 0) {
    console.error(`Cannot preload the first-paint fonts for ${outputDirectory}:`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  const indexPath = resolve(outputDirectory, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, injectPreloads(html, hrefs));
  for (const href of hrefs) console.log(`Preloading ${href}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
