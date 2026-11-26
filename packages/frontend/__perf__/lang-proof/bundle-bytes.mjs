#!/usr/bin/env node
/**
 * DEV ONLY: what a source module costs a web export, read from its source maps
 * (the Bloom language proof, README.md here).
 *
 *   node __perf__/lang-proof/bundle-bytes.mjs <export dir> <source path> [<source path> ...]
 *
 * The export must be made with `--source-maps external`. Every byte of every
 * minified JS chunk is attributed to the source its mapping segment names (a
 * segment runs to the next one on its line), so a module's bytes are exactly
 * the minified code it became. Its gzip and brotli sizes are those of its own
 * code compressed alone, which is an upper bound on what it adds to its chunk
 * (shared context compresses better), so the chunk's own sizes are given too,
 * with every JS file's total and the entry scripts `index.html` loads. Prints JSON.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { SourceMapConsumer } = require('source-map-js');

const [dir, ...targets] = process.argv.slice(2);
if (!dir || targets.length === 0) {
  console.error('usage: bundle-bytes.mjs <export dir> <source path> [...]');
  process.exit(2);
}

const sizes = (buffer) => ({
  minified: buffer.length,
  gzip: gzipSync(buffer, { level: 9 }).length,
  brotli: brotliCompressSync(buffer, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length,
});

function* files(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

const js = [...files(dir)].filter((path) => path.endsWith('.js'));
const total = { files: js.length, minified: 0, gzip: 0, brotli: 0 };
const found = Object.fromEntries(targets.map((target) => [target, { chunks: [] }]));

for (const path of js) {
  const code = readFileSync(path);
  const own = sizes(code);
  total.minified += own.minified;
  total.gzip += own.gzip;
  total.brotli += own.brotli;
  let map;
  try {
    map = JSON.parse(readFileSync(`${path}.map`, 'utf8'));
  } catch {
    continue;
  }
  // Metro writes indexed maps (`sections`); the consumer reads both kinds.
  const consumer = new SourceMapConsumer(map);
  if (!consumer.sources.some((source) => targets.some((target) => source.endsWith(target))))
    continue;

  const lines = code.toString('utf8').split('\n');
  const segments = [];
  consumer.eachMapping((m) => segments.push(m));
  // eachMapping is in generated order: a segment ends where the next one on its line starts.
  const slices = Object.fromEntries(targets.map((target) => [target, []]));
  for (let i = 0; i < segments.length; i += 1) {
    const m = segments[i];
    const target = m.source && targets.find((t) => m.source.endsWith(t));
    if (!target) continue;
    const next = segments[i + 1];
    const line = lines[m.generatedLine - 1] ?? '';
    const end = next && next.generatedLine === m.generatedLine ? next.generatedColumn : line.length;
    slices[target].push(line.slice(m.generatedColumn, end));
  }
  for (const target of targets) {
    if (slices[target].length === 0) continue;
    found[target].chunks.push({
      chunk: relative(dir, path),
      module: sizes(Buffer.from(slices[target].join(''), 'utf8')),
      chunkSizes: own,
    });
  }
}

// What the first page load fetches: the scripts `index.html` names.
const entry = { files: 0, minified: 0, gzip: 0, brotli: 0 };
const html = readFileSync(join(dir, 'index.html'), 'utf8');
for (const [, src] of html.matchAll(/<script[^>]*\ssrc="\/([^"]+\.js)"/g)) {
  const own = sizes(readFileSync(join(dir, src)));
  entry.files += 1;
  entry.minified += own.minified;
  entry.gzip += own.gzip;
  entry.brotli += own.brotli;
}

console.log(JSON.stringify({ dir, total, entry, modules: found }, null, 2));
