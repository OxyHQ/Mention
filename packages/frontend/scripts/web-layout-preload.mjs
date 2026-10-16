#!/usr/bin/env node

/**
 * Preloads the route LAYOUT chunks every page loads, from the export itself.
 *
 *   node scripts/web-layout-preload.mjs dist          # write the preloads into dist/index.html
 *   node scripts/web-layout-preload.mjs dist --check  # verify them, change nothing
 *
 * WHY: `asyncRoutes: { web: 'production' }` (app.config.js) splits every route
 * file into its own chunk, the `_layout` files included, and expo-router
 * requires EVERY layout while it builds the route tree, before anything
 * renders. The startup JavaScript is the only thing that names those chunks, so
 * without a hint the browser asks for them only once `__common` and `entry`
 * have downloaded and run: on a cold load of mention.earth that was a second
 * round trip at ~2.3 s, after the whole common chunk. A `<link rel="preload">`
 * per layout chunk lets the preload scanner fetch them beside the scripts.
 * Measured on a local production export (4x CPU, 150 ms RTT, ~9 Mbit/s, median
 * of 5–7 interleaved cold loads): LCP −280 ms on `/`, −500 ms on a post, −250 ms
 * on a profile.
 *
 * WHY ALL OF THEM: they are not per-page. All eight were requested on `/`,
 * `/@user` and `/p/<id>` alike, because the route tree is built from every
 * layout before the URL picks a branch. A page chunk (`index`, `[id]`, …) IS
 * per-URL, and this static shell serves every path, so those are left alone.
 *
 * WHERE THE URLS COME FROM: the startup JavaScript's own chunk map (the
 * `"/_expo/static/js/web/_layout-<32-hex>.js"` string literals `entry` hands to
 * the async loader), each one checked against the export, so a preload is the
 * byte-for-byte URL the loader requests and the browser reuses it. The count
 * must equal the number of directories under `app/` that hold a `_layout`: a
 * naming change in Metro or expo-router that hid a layout from this scan fails
 * the build instead of silently preloading part of the set.
 *
 * NO `crossorigin`: the loader injects a plain same-origin `<script src>`
 * (`expo/src/async-require/fetchThenEval.web.ts`), so the preload must be a
 * no-cors request too or the browser downloads the chunk twice.
 */

import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupScripts } from './web-font-preload.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Marker so a second run neither duplicates nor silently keeps a stale tag. */
const MARKER = 'data-route-layout';

const LAYOUT_CHUNK = /["'](\/_expo\/static\/js\/web\/_layout-[0-9a-f]{32}\.js)["']/g;
const LAYOUT_FILE = /^_layout(\.web)?\.(tsx|ts|jsx|js)$/;

/** Distinct layout chunk URLs named by the startup JavaScript. */
export function layoutChunkUrls(sources) {
  const urls = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(LAYOUT_CHUNK)) urls.add(match[1]);
  }
  return [...urls].sort();
}

/** Directories under `appDirectory` holding a `_layout` route file. */
export async function countLayoutDirectories(appDirectory) {
  let count = 0;
  const entries = await readdir(appDirectory, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && LAYOUT_FILE.test(entry.name))) count += 1;
  for (const entry of entries) {
    if (entry.isDirectory()) count += await countLayoutDirectories(join(appDirectory, entry.name));
  }
  return count;
}

export function preloadTag(href) {
  return `<link rel="preload" href="${href}" as="script" ${MARKER}>`;
}

/** Existing layout preload hrefs in `html`. */
export function preloadHrefs(html) {
  const tags = html.match(new RegExp(`<link\\b[^>]*\\b${MARKER}\\b[^>]*>`, 'g')) ?? [];
  return tags.map((tag) => tag.match(/\bhref="([^"]+)"/)?.[1]).filter(Boolean);
}

/**
 * Put exactly `hrefs` as layout preloads at the end of the `<head>`, replacing
 * any earlier ones. The font preload and the stylesheet stay ahead of them.
 */
export function injectPreloads(html, hrefs) {
  const withoutOld = html.replace(
    new RegExp(`[ \\t]*<link\\b[^>]*\\b${MARKER}\\b[^>]*>\\n?`, 'g'),
    '',
  );
  const headEnd = withoutOld.indexOf('</head>');
  if (headEnd === -1) throw new Error('index.html has no </head> to put the layout preloads in');
  const tags = hrefs.map((href) => `${preloadTag(href)}\n`).join('');
  const lineBreak = tags && withoutOld[headEnd - 1] !== '\n' ? '\n' : '';
  return `${withoutOld.slice(0, headEnd)}${lineBreak}${tags}${withoutOld.slice(headEnd)}`;
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
 * Resolve the layout chunk hrefs from an export directory.
 * Returns `{ hrefs, failures }`; any failure means no preload can be trusted.
 */
export async function resolveLayoutHrefs(outputDirectory, appDirectory = join(packageRoot, 'app')) {
  const indexPath = resolve(outputDirectory, 'index.html');
  if (!(await exists(indexPath))) return { hrefs: [], failures: ['index.html is missing'] };
  const scripts = startupScripts(await readFile(indexPath, 'utf8'));
  if (scripts.length === 0) {
    return { hrefs: [], failures: ['index.html loads no same-origin <script src>'] };
  }
  const sources = await Promise.all(
    scripts.map((src) => readFile(resolve(outputDirectory, `.${decodeURI(src)}`), 'utf8')),
  );
  const hrefs = layoutChunkUrls(sources);
  const failures = [];
  const expected = await countLayoutDirectories(appDirectory);
  if (hrefs.length !== expected) {
    failures.push(
      `expected the startup JavaScript to name ${expected} _layout chunk(s), one per layout ` +
        `in ${appDirectory}, found ${hrefs.length}${hrefs.length ? `: ${hrefs.join(', ')}` : ''}`,
    );
  }
  for (const href of hrefs) {
    if (!(await exists(resolve(outputDirectory, `.${decodeURI(href)}`)))) {
      failures.push(`${href} is named by the startup JavaScript but is not in the export`);
    }
  }
  return { hrefs, failures };
}

/** Verify `index.html` preloads exactly the layout chunks. Returns failures. */
export async function checkLayoutPreloads(outputDirectory, appDirectory) {
  const { hrefs, failures } = await resolveLayoutHrefs(outputDirectory, appDirectory);
  if (failures.length > 0) return failures;
  const present = preloadHrefs(await readFile(resolve(outputDirectory, 'index.html'), 'utf8'));
  for (const href of hrefs.filter((href) => !present.includes(href))) {
    failures.push(
      `index.html does not preload ${href} (run scripts/web-layout-preload.mjs after expo export)`,
    );
  }
  for (const href of present.filter((href) => !hrefs.includes(href))) {
    failures.push(`index.html preloads ${href}, which the startup JavaScript does not name`);
  }
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const appIndex = args.indexOf('--app-dir');
  const appDirectory = appIndex === -1 ? undefined : resolve(args[appIndex + 1]);
  const appValue = appIndex === -1 ? -1 : appIndex + 1;
  const positional = args.filter((arg, index) => !arg.startsWith('--') && index !== appValue);
  const outputDirectory = resolve(positional[0] ?? 'dist');

  if (check) {
    const failures = await checkLayoutPreloads(outputDirectory, appDirectory);
    if (failures.length > 0) {
      console.error(`Layout preload check failed for ${outputDirectory}:`);
      for (const failure of failures) console.error(`- ${failure}`);
      process.exit(1);
    }
    console.log(`index.html preloads every route layout chunk: ${outputDirectory}`);
    return;
  }

  const { hrefs, failures } = await resolveLayoutHrefs(outputDirectory, appDirectory);
  if (failures.length > 0) {
    console.error(`Cannot preload the route layout chunks for ${outputDirectory}:`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  const indexPath = resolve(outputDirectory, 'index.html');
  await writeFile(indexPath, injectPreloads(await readFile(indexPath, 'utf8'), hrefs));
  for (const href of hrefs) console.log(`Preloading ${href}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
