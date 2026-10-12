import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const paths = [
  'scripts/validate-jev-additive.mjs',
  'packages/backend/drizzle/meta/0057_snapshot.json',
  'packages/backend/drizzle/meta/0058_snapshot.json',
  'packages/backend/drizzle/meta/_journal.json',
  'packages/backend/drizzle/0058_jev_shadow_ledger.sql',
  'packages/backend/drizzle/0059_search_engine_indexing_opt_out.sql',
  'packages/backend/src/services/contentClassification/jevShadow.ts',
];
function inspect(mutate = () => {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'jev-validator-'));
  const edit = (path, fn) =>
    writeFileSync(join(fixture, path), fn(readFileSync(join(fixture, path), 'utf8')));
  try {
    for (const path of paths) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      cpSync(join(repository, path), join(fixture, path));
    }
    mutate(edit, fixture);
    return spawnSync(process.execPath, [join(fixture, 'scripts/validate-jev-additive.mjs')], {
      encoding: 'utf8',
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}
const journalPath = 'packages/backend/drizzle/meta/_journal.json';
const editJournal = (change) => (edit) =>
  edit(journalPath, (text) => {
    const json = JSON.parse(text);
    change(json.entries);
    return JSON.stringify(json);
  });

test('the additive migration and dormant gate remain valid after unrelated migrations', () => {
  const result = inspect();
  assert.equal(result.status, 0, result.stderr);
});
test('rejects a changed migration identity', () => {
  assert.notEqual(
    inspect(
      editJournal((rows) => {
        rows.find((row) => row.idx === 58).tag = '0058_changed';
      }),
    ).status,
    0,
  );
});
test('rejects duplicate migration identity', () => {
  assert.notEqual(
    inspect(
      editJournal((rows) => {
        rows.push({ ...rows.find((row) => row.idx === 58) });
      }),
    ).status,
    0,
  );
});
test('rejects destructive changes to the owned migration', () => {
  assert.notEqual(
    inspect((edit) =>
      edit(
        'packages/backend/drizzle/0058_jev_shadow_ledger.sql',
        (text) => `${text}\nDROP TABLE posts;`,
      ),
    ).status,
    0,
  );
});
test('rejects mutation of an existing table in the additive snapshot', () => {
  assert.notEqual(
    inspect((edit) =>
      edit('packages/backend/drizzle/meta/0058_snapshot.json', (text) => {
        const json = JSON.parse(text);
        json.tables['public.actor_key_pairs'].columns.private_key_pem.notNull = false;
        return JSON.stringify(json);
      }),
    ).status,
    0,
  );
});
test('rejects removal of an approval blocker', () => {
  assert.notEqual(
    inspect((edit) =>
      edit('packages/backend/src/services/contentClassification/jevShadow.ts', (text) =>
        text.replace("  'privacy_and_zdr',\n", ''),
      ),
    ).status,
    0,
  );
});
test('rejects an environment activation bypass', () => {
  assert.notEqual(
    inspect((edit) =>
      edit('packages/backend/src/services/contentClassification/jevShadow.ts', (text) =>
        text.replace(
          'return JEV_SHADOW_BLOCKERS.length === 0;',
          'return process.env.JEV_ENABLED === "true";',
        ),
      ),
    ).status,
    0,
  );
});
test('rejects a third table added by the owned snapshot', () => {
  assert.notEqual(
    inspect((edit) =>
      edit('packages/backend/drizzle/meta/0058_snapshot.json', (text) => {
        const json = JSON.parse(text);
        json.tables['public.jev_extra'] = { name: 'jev_extra', columns: {} };
        return JSON.stringify(json);
      }),
    ).status,
    0,
  );
});
