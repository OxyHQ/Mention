#!/usr/bin/env node

/**
 * Mutation-tests `web-font-preload.mjs` against a synthetic export.
 *
 * The first case is the positive control: the unmutated fixture must inject and
 * then pass `--check`. Every later case breaks one thing the preload depends on
 * and requires the script to go red and say why, because a preload that points
 * at the wrong URL fails silently in production: the browser downloads the font
 * twice and logs a warning nobody reads.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(packageRoot, "scripts", "web-font-preload.mjs");

const HASH = "260c81a4759baf163c025001c4f27872";
const FONT_DIR = "assets/__node_modules/@oxy.so/bloom/lib/module/fonts/assets";
const INTER = `/${FONT_DIR}/InterVariable.${HASH}.woff2`;
const BLOMUS = `/${FONT_DIR}/BlomusModernus-Regular.c8e4c906b137ccc90f9aa1fbccbe85b2.woff2`;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Mention</title>
  </head>
  <body>
    <div id="root"></div>
  <script src="/_expo/static/js/web/__common-abc.js" defer></script><script src="/_expo/static/js/web/entry-def.js" defer></script>
</body>
</html>
`;

const COMMON_JS =
  `__d(function(g,r,i,a,m,e,d){m.exports="${INTER}"},3249,[]);` +
  `__d(function(g,r,i,a,m,e,d){m.exports="${BLOMUS}"},3250,[]);`;

function writeFixture(root, overrides = {}) {
  const files = {
    "index.html": INDEX_HTML,
    "_expo/static/js/web/__common-abc.js": COMMON_JS,
    "_expo/static/js/web/entry-def.js": "__r(0);",
    [INTER.slice(1)]: "wOF2",
    [BLOMUS.slice(1)]: "wOF2",
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
    const stdout = execFileSync(process.execPath, [script, root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const failures = [];
function expectCase(name, result, ok, message = "") {
  if (result.ok !== ok || (message && !result.output.includes(message))) {
    failures.push(
      `${name}: expected ${ok ? "success" : "failure"}${message ? ` mentioning "${message}"` : ""}, ` +
        `got ${result.ok ? "success" : "failure"}:\n${result.output}`,
    );
  } else {
    console.log(`ok - ${name}`);
  }
}

function withFixture(name, overrides, body) {
  const root = mkdtempSync(join(tmpdir(), "mention-font-preload-"));
  try {
    writeFixture(root, overrides);
    body(root, name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Positive control: inject, then check; twice to prove the write is idempotent.
withFixture("positive control", {}, (root, name) => {
  expectCase(`${name}: inject`, run(root), true, INTER);
  expectCase(`${name}: re-inject`, run(root), true, INTER);
  expectCase(`${name}: check`, run(root, "--check"), true);
  const html = readFileSync(join(root, "index.html"), "utf8");
  const tags = html.match(/<link rel="preload"[^>]*>/g) ?? [];
  const expected =
    `<link rel="preload" href="${INTER}" as="font" type="font/woff2" crossorigin data-first-paint-font>`;
  if (tags.length !== 1 || tags[0] !== expected) {
    failures.push(`${name}: expected exactly one Inter preload, got ${JSON.stringify(tags)}`);
  } else if (html.indexOf(expected) > html.indexOf("<title>")) {
    failures.push(`${name}: the preload must come before every other head resource`);
  } else {
    console.log(`ok - ${name}: one crossorigin Inter preload, first in <head>`);
  }
  if (html.includes(`href="${BLOMUS}"`)) {
    failures.push(`${name}: preloaded a font the first paint does not use`);
  }
});

withFixture("export without the preload", {}, (root, name) => {
  expectCase(name, run(root, "--check"), false, "does not preload");
});

withFixture("font file missing from the export", { [INTER.slice(1)]: null }, (root, name) => {
  expectCase(name, run(root), false, "is not in the export");
});

withFixture(
  "startup JavaScript no longer references the font",
  { "_expo/static/js/web/__common-abc.js": `__d(function(){m.exports="${BLOMUS}"});` },
  (root, name) => {
    expectCase(name, run(root), false, "found 0");
  },
);

withFixture(
  "two different Inter URLs in the startup JavaScript",
  {
    "_expo/static/js/web/entry-def.js": `m.exports="/${FONT_DIR}/InterVariable.${"f".repeat(32)}.woff2"`,
  },
  (root, name) => {
    expectCase(name, run(root), false, "found 2");
  },
);

withFixture("stale preload from an earlier build", {}, (root, name) => {
  const stale = `/${FONT_DIR}/InterVariable.${"0".repeat(32)}.woff2`;
  const html = INDEX_HTML.replace(
    '<meta charset="utf-8" />\n',
    `<meta charset="utf-8" />\n    <link rel="preload" href="${stale}" as="font" type="font/woff2" crossorigin data-first-paint-font>\n`,
  );
  writeFileSync(join(root, "index.html"), html);
  expectCase(`${name}: check`, run(root, "--check"), false, "does not use");
  expectCase(`${name}: re-inject replaces it`, run(root), true);
  expectCase(`${name}: check after re-inject`, run(root, "--check"), true);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} web-font-preload self-test case(s) failed:\n`);
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}
console.log("\nweb-font-preload self-test passed");
