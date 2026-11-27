/**
 * Writes Bloom's catalogs, `Resources/Localizable/<lang>.json`, from `locales/*.json`
 * (`lib/bloomCatalog.ts`). bloomc checks `String(localized:)` keys against them (B0840).
 * They are generated: edit `locales/`, then run `bun run bloom-catalogs`.
 * `--check` fails when a catalog is not what `locales/` gives (CI and the test).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toBloomCatalog } from '../lib/bloomCatalog';

const root = fileURLToPath(new URL('..', import.meta.url));
const locales = join(root, 'locales');
const out = join(root, 'Resources', 'Localizable');

/** Each catalog file's name and text, from `locales/`. */
export function catalogs(): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(locales)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const translation = JSON.parse(readFileSync(join(locales, name), 'utf8'));
    files.set(name, `${JSON.stringify(toBloomCatalog(translation), null, 2)}\n`);
  }
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const wanted = catalogs();
  if (process.argv.includes('--check')) {
    const have = new Set(readdirSync(out).filter((f) => f.endsWith('.json')));
    const stale = [...wanted].filter(([name, text]) => {
      have.delete(name);
      try {
        return readFileSync(join(out, name), 'utf8') !== text;
      } catch {
        return true;
      }
    });
    if (stale.length || have.size) {
      console.error(
        `Resources/Localizable is not what locales/ gives (${[...stale.map(([n]) => n), ...have].join(', ')}): run \`bun run bloom-catalogs\``,
      );
      process.exit(1);
    }
  } else {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const [name, text] of wanted) writeFileSync(join(out, name), text);
    console.log(`Resources/Localizable: ${wanted.size} catalogs`);
  }
}
