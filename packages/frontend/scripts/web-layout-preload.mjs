#!/usr/bin/env node

/**
 * Preloads the route LAYOUT chunks every page loads, from the export itself.
 *
 *   node scripts/web-layout-preload.mjs dist          # write the preloads into dist/index.html
 *   node scripts/web-layout-preload.mjs dist --check  # verify them, change nothing
 *
 * WHY: `asyncRoutes: { web: 'production' }` (app.config.js) splits every route
 * file into its own chunk, the `_layout` files included. The startup JavaScript
 * is the only thing that names those chunks, so without a hint the browser asks
 * for the layouts only once `__common` and `entry` have downloaded and run: on
 * a cold load of mention.earth that was a second round trip at ~2.3 s, after
 * the whole common chunk. A `<link rel="preload">` per layout chunk lets the
 * preload scanner fetch them beside the scripts. Measured on a local production
 * export (4x CPU, 150 ms RTT, ~9 Mbit/s, median of 5-7 interleaved cold loads):
 * LCP -280 ms on `/`, -500 ms on a post, -250 ms on a profile.
 *
 * WHY ONLY THREE: a layout is requested only when the URL's route branch
 * contains it. Measured on https://mention.earth with the preloads stripped:
 * the root layout, `(app)/_layout` and `(app)/(tabs)/_layout` load on every
 * path (`/`, `/explore`, `/@user`, `/p/<id>`, `/login`, `/settings`, ...); the
 * other five (`(auth)`, `[username]`, `[username]/lane`, `explore`,
 * `live-rooms`) load only on their own branches. This static shell serves every
 * path, so preloading those five on `/` fetched chunks nothing used and Chrome
 * warned "preloaded but not used within a few seconds" for each (once per
 * resource, repeated across loads). Like page chunks, they are per-URL and left
 * alone.
 *
 * WHERE THE URLS COME FROM: the startup JavaScript's own route context, which
 * maps each route file (`./(app)/_layout.tsx`) to its chunk through the
 * module's dependency map, each one checked against the export, so a preload is
 * the byte-for-byte URL the loader requests and the browser reuses it. If a
 * Metro or expo-router change hides one of the three from this scan the build
 * fails instead of silently preloading part of the set.
 *
 * NO `crossorigin`: the loader injects a plain same-origin `<script src>`
 * (`expo/src/async-require/fetchThenEval.web.ts`), so the preload must be a
 * no-cors request too or the browser downloads the chunk twice.
 */

import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupScripts } from './web-font-preload.mjs';

/** Marker so a second run neither duplicates nor silently keeps a stale tag. */
const MARKER = 'data-route-layout';

/** Route files (as keyed in the route context) whose layout loads on every URL. */
export const ALWAYS_LOADED_LAYOUTS = [
  './_layout.tsx',
  './(app)/_layout.tsx',
  './(app)/(tabs)/_layout.tsx',
];

/** `{"0":749,...,"paths":{"749":"/_expo/static/js/web/_layout-<hash>.js",...}}` */
const DEPENDENCY_MAP = /\{"0":\d+(?:,"\d+":\d+)*,"paths":\{[^}]*\}\}/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The chunk URL of each always-loaded layout, found in the startup JavaScript's
 * route context. Returns `{ urls, missing }`: sorted distinct URLs and the route
 * files that could not be resolved.
 */
export function layoutChunkUrls(sources) {
  const urls = new Set();
  const missing = [];
  for (const file of ALWAYS_LOADED_LAYOUTS) {
    const entry = new RegExp(`"${escapeRegExp(file)}":\\{[^}]*?\\(d\\[(\\d+)\\],d\\.paths\\)`);
    let url;
    for (const source of sources) {
      const map = source.match(DEPENDENCY_MAP);
      const match = source.match(entry);
      if (!map || !match) continue;
      const dependencies = JSON.parse(map[0]);
      url = dependencies.paths[dependencies[match[1]]];
      if (url) break;
    }
    if (url) urls.add(url);
    else missing.push(file);
  }
  return { urls: [...urls].sort(), missing };
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
export async function resolveLayoutHrefs(outputDirectory) {
  const indexPath = resolve(outputDirectory, 'index.html');
  if (!(await exists(indexPath))) return { hrefs: [], failures: ['index.html is missing'] };
  const scripts = startupScripts(await readFile(indexPath, 'utf8'));
  if (scripts.length === 0) {
    return { hrefs: [], failures: ['index.html loads no same-origin <script src>'] };
  }
  const sources = await Promise.all(
    scripts.map((src) => readFile(resolve(outputDirectory, `.${decodeURI(src)}`), 'utf8')),
  );
  const { urls: hrefs, missing } = layoutChunkUrls(sources);
  const failures = missing.map(
    (file) => `the startup JavaScript's route context does not resolve ${file} to a chunk`,
  );
  for (const href of hrefs) {
    if (!(await exists(resolve(outputDirectory, `.${decodeURI(href)}`)))) {
      failures.push(`${href} is named by the startup JavaScript but is not in the export`);
    }
  }
  return { hrefs, failures };
}

/** Verify `index.html` preloads exactly the layout chunks. Returns failures. */
export async function checkLayoutPreloads(outputDirectory) {
  const { hrefs, failures } = await resolveLayoutHrefs(outputDirectory);
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
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const outputDirectory = resolve(positional[0] ?? 'dist');

  if (check) {
    const failures = await checkLayoutPreloads(outputDirectory);
    if (failures.length > 0) {
      console.error(`Layout preload check failed for ${outputDirectory}:`);
      for (const failure of failures) console.error(`- ${failure}`);
      process.exit(1);
    }
    console.log(`index.html preloads the layout chunks every route loads: ${outputDirectory}`);
    return;
  }

  const { hrefs, failures } = await resolveLayoutHrefs(outputDirectory);
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
