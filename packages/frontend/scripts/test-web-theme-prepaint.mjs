#!/usr/bin/env node

/**
 * Self-test of `web-theme-prepaint.mjs` against a synthetic export.
 *
 * Positive control: the prepaint is written right after `<meta charset>` (before
 * every stylesheet), passes `--check`, and is idempotent. Then the guards: a
 * document without `<meta charset>` is refused, a stale prepaint fails
 * `--check`, and the configuration matches the app's `THEME_PREPAINT`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(packageRoot, 'scripts', 'web-theme-prepaint.mjs');

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Mention</title>
    <link rel="stylesheet" href="/_expo/static/css/global-abc.css">
  </head>
  <body><div id="root"></div></body>
</html>
`;

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

function run(dir, ...args) {
  try {
    execFileSync(process.execPath, [script, dir, ...args], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'theme-prepaint-'));
try {
  const file = join(dir, 'index.html');
  writeFileSync(file, INDEX_HTML);
  check('writes the prepaint', run(dir));
  const written = readFileSync(file, 'utf8');
  const styleAt = written.indexOf('<style data-bloom-theme-bootstrap>');
  check('the prepaint follows <meta charset>', styleAt > written.indexOf('<meta charset'));
  check('the prepaint precedes every stylesheet', styleAt < written.indexOf('rel="stylesheet"'));
  check(
    'paints the document background',
    written.includes('html,body{background-color:var(--background)'),
  );
  check('selects dark by the OS preference', written.includes('prefers-color-scheme:dark'));
  check('reads the saved theme', written.includes('"persist":"mention.bloom.theme"'));
  check('passes --check', run(dir, '--check'));
  check('is idempotent', run(dir) && readFileSync(file, 'utf8') === written);

  writeFileSync(file, written.replace('prefers-color-scheme:dark', 'prefers-color-scheme:stale'));
  check('a stale prepaint fails --check', !run(dir, '--check'));

  writeFileSync(file, INDEX_HTML.replace('<meta charset="utf-8" />', ''));
  check('a document without <meta charset> is refused', !run(dir));

  const layout = readFileSync(join(packageRoot, 'lib', 'themePersistence.ts'), 'utf8');
  const colors = readFileSync(join(packageRoot, 'lib', 'colorEntitlement.ts'), 'utf8');
  const source = readFileSync(script, 'utf8');
  check(
    "the persist key is the app's",
    layout.includes("createBloomThemeStorage('mention.bloom.theme'") &&
      source.includes("persistKey: 'mention.bloom.theme'"),
  );
  check(
    "the default preset is the app's",
    /APP_DEFAULT_COLOR_PRESET: AppColorName = 'blue'/.test(colors) &&
      source.includes("defaultColorPreset: 'blue'"),
  );
  check(
    "the default mode is the app's",
    layout.includes("defaultMode: 'system'") && source.includes("defaultMode: 'system'"),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
