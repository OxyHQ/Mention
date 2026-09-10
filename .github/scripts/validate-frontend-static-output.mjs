#!/usr/bin/env bun

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve(
  process.argv[2] || "packages/frontend/dist",
);
const failures = [];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const indexPath = resolve(outputDirectory, "index.html");
if (!(await exists(indexPath))) {
  failures.push("index.html is missing");
}

const headersPath = resolve(outputDirectory, "_headers");
if (!(await exists(headersPath))) {
  failures.push("_headers is missing");
} else {
  const headers = await readFile(headersPath, "utf8");
  // The two paths Expo writes content-hashed output to: JS chunks under
  // /_expo/static, and everything imported as an asset — Bloom's `.woff2` web
  // fonts among them — under /assets. `/fonts/*` used to be here because the
  // app served the fonts from `public/fonts/` with hand-copied hashes; Bloom
  // emits them itself now, so that directory no longer exists.
  for (const route of ["/_expo/static/*", "/assets/*"]) {
    const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const immutableRule = new RegExp(
      `^${escapedRoute}\\s*\\n(?:[ \\t]+[^\\n]*\\n)*?[ \\t]+Cache-Control:\\s*public,\\s*max-age=31536000,\\s*immutable\\s*$`,
      "im",
    );
    if (!immutableRule.test(headers)) {
      failures.push(
        `_headers has no one-year immutable cache rule for ${route}`,
      );
    }
  }
}

if (await exists(resolve(outputDirectory, "_routes.json"))) {
  failures.push(
    "_routes.json must not be published; it is a Cloudflare Pages Advanced Mode " +
      "file, and the shell Worker's routing is declared in packages/frontend/wrangler.toml",
  );
}

// SPA fallback has TWO providers because this build is deployed twice: the shell
// Worker gets it from `not_found_handling` in `wrangler.toml`, and the Cloudflare
// Pages preview the release gate browses gets it from `_redirects` and NOTHING
// else. Wrangler ignores this rule with an "infinite loop detected" warning, which
// reads exactly like dead weight — so deleting it looks like a cleanup and lands
// as a gate that serves 404s for every deep link.
if (!(await exists(resolve(outputDirectory, "_redirects")))) {
  failures.push(
    "_redirects is missing; the Cloudflare Pages preview the release gate runs " +
      "against has no other source of SPA fallback",
  );
}

if (failures.length > 0) {
  console.error(`Frontend static output validation failed for ${outputDirectory}:\n`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Frontend static output contains immutable asset headers and no Worker routes: ${outputDirectory}`,
);
