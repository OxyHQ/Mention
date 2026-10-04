import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = path => JSON.parse(read(path));
const base = json('packages/backend/drizzle/meta/0057_snapshot.json');
const current = json('packages/backend/drizzle/meta/0058_snapshot.json');
assert.equal(current.prevId, base.id);
assert.notEqual(current.id, base.id);
assert.ok(Object.keys(base.tables).length > 100, 'Base table census cannot be empty');
for (const [name, table] of Object.entries(base.tables)) {
  assert.deepEqual(current.tables[name], table, `Existing table changed: ${name}`);
}
assert.deepEqual(Object.keys(current.tables).filter(name => !(name in base.tables)).sort(),
  ['public.post_evaluation_topics', 'public.post_evaluations']);
assert.ok(current.tables['public.actor_key_pairs'].columns.private_key_pem.notNull);
for (const key of Object.keys(base).filter(key => !['id', 'prevId', 'tables'].includes(key))) {
  assert.deepEqual(current[key], base[key], `Existing schema metadata changed: ${key}`);
}
const journal = json('packages/backend/drizzle/meta/_journal.json').entries;
const ownedEntries = journal.filter(entry => entry.idx === 58 || entry.tag === '0058_jev_shadow_ledger');
assert.equal(ownedEntries.length, 1, 'Owned migration must appear exactly once');
const owned = ownedEntries[0];
assert.equal(owned.tag, '0058_jev_shadow_ledger');
assert.equal(owned.idx, 58);
const previous = journal[journal.indexOf(owned) - 1];
assert.equal(previous?.idx, 57);
assert.ok(previous.tag.startsWith('0057_'));
assert.ok(owned.when > previous.when);
assert.deepEqual(readdirSync(new URL('../packages/backend/drizzle/', import.meta.url))
  .filter(name => /^0058_.*\.sql$/.test(name)), ['0058_jev_shadow_ledger.sql']);
const sql = read('packages/backend/drizzle/0058_jev_shadow_ledger.sql');
assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, 2);
assert.equal((sql.match(/ON DELETE cascade/g) ?? []).length, 2);
assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b|\$\d|private_key_pem/i);
assert.match(read('packages/backend/src/db/schema/federation.ts'), /privateKeyPem: text\(\)\.notNull\(\)/);
assert.match(read('packages/backend/src/db/schema/protectedColumns.ts'), /ACTOR_KEY_PAIRS_PROTECTED_COLUMNS = \['privateKeyPem'\]/);
const manifest = json('package.json');
const lock = read('bun.lock');
const packages = [
  ['contracts', '4.9.0', 'sha512-dDMZlTSCR1wOd0XlhM8fZ7frSzvUm7JxPsEVGXjb92OIsb3MTb7SKFGHD7/U61oI8IOxw6oVrzeIaZ5aOWh7nA=='],
  ['core', '4.2.0', 'sha512-FsSXwSTAPbkOVrwRXKFGYuylFcVwOlmlRMvmbgDV3RCnH2/rys/qv2SaXiZDXYaNNGI7yPQNYolgjdxUOZB0EQ=='],
];
for (const [name, version, hash] of packages) {
  assert.equal(manifest.workspaces.catalog[`@oxy.so/${name}`], version);
  const entry = lock.split('\n').find(line => line.includes(`"@oxy.so/${name}": ["@oxy.so/${name}@${version}"`));
  assert.ok(entry?.includes(hash), `Missing trusted published integrity for ${name}`);
}
assert.equal(manifest.overrides['@oxy.so/core'], '4.2.0');
const gate = read('packages/backend/src/services/contentClassification/jevShadow.ts');
for (const blocker of ['published_decisions_sdk', 'reviewed_exact_model_and_oxy_policy',
  'internal_provider_eligibility', 'privacy_and_zdr', 'federated_public_visibility_provenance',
  'semantic_revision_and_receipt_reconciliation']) assert.ok(gate.includes(`'${blocker}'`));
assert.match(gate, /return JEV_SHADOW_BLOCKERS.length === 0/);
assert.doesNotMatch(gate, /process\.env/);
console.log('Jev additive schema, private keys, migration chain, published hashes and dormant gate: PASS');
