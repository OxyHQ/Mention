#!/usr/bin/env node

/**
 * Mutation-tests `web-layout-preload.mjs` against a synthetic export.
 *
 * The first case is the positive control: the unmutated fixture must inject and
 * then pass `--check`. Every later case breaks one thing the preloads depend on
 * and requires the script to go red and say why. A wrong preload fails silently
 * in production: the browser downloads a chunk twice, or the layouts go back to
 * waiting for the whole common chunk, and nothing else breaks.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(packageRoot, 'scripts', 'web-layout-preload.mjs');

const WEB = '/_expo/static/js/web';
const ROOT_LAYOUT = `${WEB}/_layout-${'a'.repeat(32)}.js`;
const GROUP_LAYOUT = `${WEB}/_layout-${'b'.repeat(32)}.js`;
const TABS_LAYOUT = `${WEB}/_layout-${'d'.repeat(32)}.js`;
const BRANCH_LAYOUT = `${WEB}/_layout-${'e'.repeat(32)}.js`;
const PAGE = `${WEB}/index-${'c'.repeat(32)}.js`;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Mention</title>
  <link rel="stylesheet" href="/_expo/static/css/global-abc.css"></head>
  <body>
    <div id="root"></div>
  <script src="${WEB}/__common-abc.js" defer></script><script src="${WEB}/entry-def.js" defer></script>
</body>
</html>
`;

/** The route context and dependency map as Metro writes them (tabs eager, the rest lazy). */
function entryJs({ withTabs = true } = {}) {
  const tabs = withTabs
    ? `"./(app)/(tabs)/_layout.tsx":{enumerable:!0,get(){var t;return t=r(d[1])(d[0],d.paths),r(d[1]),t}},`
    : '';
  return (
    `__d(function(g,r,i,a,m,e,d){var t={${tabs}` +
    `"./(app)/_layout.tsx":{enumerable:!0,get:()=>r(d[1])(d[2],d.paths)},` +
    `"./(app)/explore/_layout.tsx":{enumerable:!0,get:()=>r(d[1])(d[3],d.paths)},` +
    `"./(app)/index.tsx":{enumerable:!0,get:()=>r(d[1])(d[4],d.paths)},` +
    `"./_layout.tsx":{enumerable:!0,get:()=>r(d[1])(d[5],d.paths)}};},8,` +
    `{"0":10,"1":9,"2":11,"3":13,"4":12,"5":14,"paths":{"10":"${TABS_LAYOUT}",` +
    `"11":"${GROUP_LAYOUT}","12":"${PAGE}","13":"${BRANCH_LAYOUT}","14":"${ROOT_LAYOUT}"}});`
  );
}

/** The export is written to `<root>/dist`. */
function writeFixture(root, overrides = {}) {
  const files = {
    'dist/index.html': INDEX_HTML,
    [`dist${WEB}/__common-abc.js`]: '__d(function(){},1,[]);',
    [`dist${WEB}/entry-def.js`]: entryJs(),
    [`dist${ROOT_LAYOUT}`]: '__d(function(){},14,[]);',
    [`dist${GROUP_LAYOUT}`]: '__d(function(){},11,[]);',
    [`dist${TABS_LAYOUT}`]: '__d(function(){},10,[]);',
    [`dist${BRANCH_LAYOUT}`]: '__d(function(){},13,[]);',
    [`dist${PAGE}`]: '__d(function(){},12,[]);',
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function run(root, ...args) {
  try {
    const stdout = execFileSync(process.execPath, [script, join(root, 'dist'), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const failures = [];
function expectCase(name, result, ok, message = '') {
  if (result.ok !== ok || (message && !result.output.includes(message))) {
    failures.push(
      `${name}: expected ${ok ? 'success' : 'failure'}${message ? ` mentioning "${message}"` : ''}, ` +
        `got ${result.ok ? 'success' : 'failure'}:\n${result.output}`,
    );
  } else {
    console.log(`ok - ${name}`);
  }
}

function withFixture(name, overrides, body) {
  const root = mkdtempSync(join(tmpdir(), 'mention-layout-preload-'));
  try {
    writeFixture(root, overrides);
    body(root, name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Positive control: inject, then check; twice to prove the write is idempotent.
withFixture('positive control', {}, (root, name) => {
  expectCase(`${name}: inject`, run(root), true, ROOT_LAYOUT);
  expectCase(`${name}: re-inject`, run(root), true, GROUP_LAYOUT);
  expectCase(`${name}: check`, run(root, '--check'), true);
  const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
  const tags = html.match(/<link rel="preload"[^>]*>/g) ?? [];
  const expected = [ROOT_LAYOUT, GROUP_LAYOUT, TABS_LAYOUT].map(
    (href) => `<link rel="preload" href="${href}" as="script" data-route-layout>`,
  );
  if (JSON.stringify(tags) !== JSON.stringify(expected)) {
    failures.push(
      `${name}: expected exactly the three always-loaded layout preloads, got ${JSON.stringify(tags)}`,
    );
  } else if (html.indexOf(expected[0]) > html.indexOf('</head>')) {
    failures.push(`${name}: the preloads must be in the <head>`);
  } else {
    console.log(`ok - ${name}: one no-cors script preload per layout, in <head>`);
  }
  if (html.includes(`href="${PAGE}"`)) {
    failures.push(`${name}: preloaded a page chunk, which is per-URL`);
  }
  if (html.includes(`href="${BRANCH_LAYOUT}"`)) {
    failures.push(`${name}: preloaded a branch-only layout, which most URLs never request`);
  }
});

withFixture('export without the preloads', {}, (root, name) => {
  expectCase(name, run(root, '--check'), false, 'does not preload');
});

withFixture(
  'layout chunk missing from the export',
  { [`dist${ROOT_LAYOUT}`]: null },
  (root, name) => {
    expectCase(name, run(root), false, 'is not in the export');
  },
);

withFixture(
  'an always-loaded layout the startup JavaScript does not name',
  { [`dist${WEB}/entry-def.js`]: entryJs({ withTabs: false }) },
  (root, name) => {
    expectCase(name, run(root), false, './(app)/(tabs)/_layout.tsx');
  },
);

withFixture(
  'startup JavaScript names no layout chunks',
  { [`dist${WEB}/entry-def.js`]: `__d(function(){},0,{"paths":{"12":"${PAGE}"}});` },
  (root, name) => {
    expectCase(name, run(root), false, './_layout.tsx');
  },
);

withFixture('stale preload from an earlier build', {}, (root, name) => {
  const stale = `${WEB}/_layout-${'0'.repeat(32)}.js`;
  writeFileSync(
    join(root, 'dist', 'index.html'),
    INDEX_HTML.replace(
      '</head>',
      `\n<link rel="preload" href="${stale}" as="script" data-route-layout>\n</head>`,
    ),
  );
  expectCase(`${name}: check`, run(root, '--check'), false, 'does not name');
  expectCase(`${name}: re-inject replaces it`, run(root), true);
  expectCase(`${name}: check after re-inject`, run(root, '--check'), true);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} web-layout-preload self-test case(s) failed:\n`);
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}
console.log('\nweb-layout-preload self-test passed');
