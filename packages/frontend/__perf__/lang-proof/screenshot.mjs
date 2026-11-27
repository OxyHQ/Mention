#!/usr/bin/env node
/**
 * DEV ONLY: captures and compares the proof app's pixels (README.md here).
 *
 *   node __perf__/lang-proof/screenshot.mjs capture <export dir> <out dir> [screen=original]
 *     Serves a `BLOOM_LANG_PROOF=1` web export, opens `/?screen=<screen>&state=<branch>`
 *     for every branch in Chrome (light scheme, reduced motion, 1x and 2x) and writes
 *     `<out dir>/<screen>-<branch>@<scale>x.png`: the screen's frame only.
 *   node __perf__/lang-proof/screenshot.mjs capture-rows <export dir> <out dir> <form>
 *     The same for PostItem's rows: every state of `rows/states.json` in one form
 *     (`ts` or `bloom`), written `<out dir>/<form>-<row>-<state>@<scale>x.png`.
 *   node __perf__/lang-proof/screenshot.mjs capture-posts <export dir> <out dir> <form>
 *     The same for PostItem itself: every feed fixture kind (`postitem/posts.tsx`) in one
 *     form, written `<out dir>/<form>-post-<kind>@<scale>x.png`. Requests off the export's
 *     origin are refused, so image loads cannot race the capture.
 *   node __perf__/lang-proof/screenshot.mjs diff <a.png> <b.png> [<diff.png>]
 *     Exact comparison: prints the differing pixel count and writes the
 *     differing pixels in red over a faded `a` to `<diff.png>`. Exits 1 on any difference.
 *
 * Chrome is `CHROME_PATH` (a Chrome for Testing binary, e.g. under
 * `~/.cache/puppeteer/chrome/`), driven with the repository's playwright-core.
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const BRANCHES = ['loaded', 'signedOut', 'pending', 'loading'];
const SCALES = [1, 2];
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function serve(root) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let path = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!path.startsWith(root)) path = join(root, 'index.html');
    if (!existsSync(path) || statSync(path).isDirectory()) {
      const html = `${path.replace(/\/$/, '')}.html`;
      path = existsSync(html) ? html : join(root, 'index.html');
    }
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** The pages `capture` opens: a name for the file and the query that draws it. */
function screenPages(screen) {
  return BRANCHES.map((branch) => ({
    name: `${screen}-${branch}`,
    query: `screen=${screen}&state=${branch}`,
  }));
}

function rowPages(form) {
  const { states } = JSON.parse(
    readFileSync(new URL('./rows/states.json', import.meta.url), 'utf8'),
  );
  return states.map(({ row, state }) => ({
    name: `${form}-${row}-${state}`,
    query: `row=${row}&state=${state}&form=${form}`,
  }));
}

const POST_KINDS = [
  'text',
  'textAvatar',
  'image',
  'multiImage',
  'video',
  'linkPreview',
  'quote',
  'repost',
  'poll',
  'communityNote',
];

function postPages(form) {
  return POST_KINDS.map((kind) => ({
    name: `${form}-post-${kind}`,
    query: `post=${kind}&form=${form}`,
  }));
}

async function capture(exportDir, outDir, pages, { offline = false } = {}) {
  const { chromium } = require('playwright-core');
  const executablePath = process.env.CHROME_PATH;
  if (!executablePath) throw new Error('Set CHROME_PATH to a Chrome binary');
  mkdirSync(outDir, { recursive: true });
  const server = await serve(normalize(exportDir));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, args: ['--font-render-hinting=none'] });
  const errors = [];
  try {
    for (const scale of SCALES) {
      const context = await browser.newContext({
        viewport: { width: 640, height: 1600 },
        deviceScaleFactor: scale,
        colorScheme: 'light',
        reducedMotion: 'reduce',
        locale: 'en-US',
        timezoneId: 'UTC',
      });
      // PostItem's fixtures name images on an unreachable host: refused at once, so every
      // capture draws the same failed-load state instead of racing the network.
      if (offline)
        await context.route(
          (url) => url.origin !== origin,
          (route) => route.abort(),
        );
      for (const { name, query } of pages) {
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(`${name}@${scale}x: ${error.message}`));
        await page.goto(`${origin}/?${query}`);
        const frame = page.getByTestId('proof-frame');
        try {
          await frame.waitFor({ state: 'visible', timeout: 60_000 });
        } catch (error) {
          // One page that never draws its frame does not stop the others.
          errors.push(`${name}@${scale}x: ${error.message.split('\n')[0]}`);
          await page.close();
          continue;
        }
        await page.evaluate(async () => {
          await document.fonts.ready;
          // Two frames, then the layout is what was committed.
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        });
        // A post's avatar fades its placeholder in: wait until every image transition ends,
        // and until every image is decoded (a late decode rasterises the avatar differently).
        await page.waitForTimeout(offline ? 3000 : 500);
        if (offline) {
          await page.evaluate(async () => {
            await Promise.all(
              [...document.images].map((image) => image.decode().catch(() => undefined)),
            );
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          });
        }
        const file = join(outDir, `${name}@${scale}x.png`);
        await frame.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
        console.log(file);
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  }
}

function diff(aPath, bPath, outPath) {
  const a = PNG.sync.read(readFileSync(aPath));
  const b = PNG.sync.read(readFileSync(bPath));
  if (a.width !== b.width || a.height !== b.height) {
    console.log(`size differs: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
    process.exitCode = 1;
    return;
  }
  const out = new PNG({ width: a.width, height: a.height });
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const same =
      a.data[i] === b.data[i] &&
      a.data[i + 1] === b.data[i + 1] &&
      a.data[i + 2] === b.data[i + 2] &&
      a.data[i + 3] === b.data[i + 3];
    if (!same) differing += 1;
    const faded = 255 - Math.round((255 - (a.data[i] + a.data[i + 1] + a.data[i + 2]) / 3) * 0.2);
    out.data[i] = same ? faded : 255;
    out.data[i + 1] = same ? faded : 0;
    out.data[i + 2] = same ? faded : 0;
    out.data[i + 3] = 255;
  }
  if (outPath) writeFileSync(outPath, PNG.sync.write(out));
  console.log(`${differing} of ${a.width * a.height} pixels differ`);
  if (differing > 0) process.exitCode = 1;
}

const [command, ...args] = process.argv.slice(2);
if (command === 'capture') await capture(args[0], args[1], screenPages(args[2] ?? 'original'));
else if (command === 'capture-rows') await capture(args[0], args[1], rowPages(args[2] ?? 'ts'));
else if (command === 'capture-posts')
  await capture(args[0], args[1], postPages(args[2] ?? 'ts'), { offline: true });
else if (command === 'diff') diff(args[0], args[1], args[2]);
else {
  console.error(
    'usage: screenshot.mjs capture <export dir> <out dir> [screen] | capture-rows <export dir> <out dir> <form> | capture-posts <export dir> <out dir> <form> | diff <a> <b> [out]',
  );
  process.exit(2);
}
