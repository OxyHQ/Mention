/**
 * Attribute every Unicode property escape in a REAL app bundle.
 *
 * The unit gate (`__tests__/textEntities.test.ts`) walks the scanner's built
 * dependency closure and proves this package ships none. It deliberately stops
 * there, because "zero escapes in the bundle" is not an assertion anyone can
 * hold: third-party dependencies ship them legitimately, and we do not control
 * that. What CAN be held is that none of the escapes in a shipped bundle are
 * ours — which needs attribution, not a count, and needs a real bundle, which is
 * far too slow to build inside a test.
 *
 * So this is a script, run on demand, and it prints the evidence rather than
 * asserting a number that would drift the moment a dependency is upgraded.
 *
 * Why it matters at all: Hermes has property escapes compiled OUT and throws
 * `SyntaxError: Invalid RegExp: Invalid property name` at RUNTIME on every one.
 * An escape inside a MODULE-LOAD-time regex literal is therefore a crash at
 * boot. An escape sitting in a string constant that is only compiled later (the
 * shape zod uses) is a latent failure on the code path that compiles it, not a
 * boot crash — so the distinction this prints is the one that decides severity.
 *
 * Usage:
 *   cd packages/frontend
 *   bunx expo export --platform android --output-dir /tmp/bundle-android
 *   bun run --cwd ../shared-types check:bundle-escapes /tmp/bundle-android
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: checkBundleEscapes.mjs <expo-export-output-dir>');
  process.exit(2);
}

/** Every emitted JS/Hermes-bytecode artefact under the export directory. */
function bundleFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...bundleFiles(path));
    else if (/\.(js|hbc)$/.test(entry)) found.push(path);
  }
  return found;
}

const PROPERTY_ESCAPE = /\\[pP]\{/g;
/** Printable context around a hit, so the owner of an escape is identifiable. */
const CONTEXT = 90;

const files = bundleFiles(root);
if (files.length === 0) {
  console.error(`no .js/.hbc artefacts under ${root} — wrong directory?`);
  process.exit(2);
}

let total = 0;
for (const path of files) {
  const data = readFileSync(path);
  const text = data.toString('latin1');
  const hits = [...text.matchAll(PROPERTY_ESCAPE)];
  if (hits.length === 0) continue;

  console.log(`\n${path}  (${data.length} bytes, ${hits.length} occurrence(s))`);
  for (const hit of hits) {
    const at = hit.index ?? 0;
    const around = text.slice(Math.max(0, at - CONTEXT), at + CONTEXT);
    // Printable runs only: a hit inside compressed/binary data is noise, and
    // showing the raw bytes is what makes that obvious rather than alarming.
    const readable = around.replace(/[^\x20-\x7E]+/g, '·');
    console.log(`  @${at}  ${readable}`);
  }
  total += hits.length;
}

console.log(
  `\n${total} property-escape occurrence(s) across ${files.length} artefact(s).`,
);
console.log(
  'Judge each by OWNER and by SHAPE: an escape in a module-load regex literal ' +
    'from our own packages is a boot crash and must be fixed; one inside a ' +
    "dependency's lazily-compiled string constant is a latent failure on that " +
    'path; one inside a run of unprintable bytes is noise from compressed data.',
);
