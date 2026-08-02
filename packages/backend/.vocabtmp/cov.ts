import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import * as schema from '../src/db/schema';
import { COLLECTION_PLANS } from '../src/db/backfill/collectionMap';

const enumCols: { table: string; column: string; values: readonly string[] }[] = [];
for (const value of Object.values(schema)) {
  if (!is(value, PgTable)) continue;
  const cfg = getTableConfig(value as PgTable);
  for (const col of cfg.columns) {
    const ev = (col as unknown as { enumValues?: readonly string[] }).enumValues;
    if (Array.isArray(ev) && ev.length) enumCols.push({ table: cfg.name, column: col.name, values: ev });
  }
}
const audited = new Set<string>();
const auditPaths = new Map<string, string>();
for (const plan of COLLECTION_PLANS) {
  for (const a of plan.enumAudits ?? []) {
    const t = getTableConfig((a.column as unknown as { table: PgTable }).table);
    const key = `${t.name}.${a.column.name}`;
    audited.add(key);
    auditPaths.set(key, `${plan.collection}:${a.path}`);
  }
}
enumCols.sort((a, b) => (a.table + a.column).localeCompare(b.table + b.column));
let covered = 0;
for (const c of enumCols) {
  const key = `${c.table}.${c.column}`;
  const hit = audited.has(key);
  if (hit) covered++;
  console.log(`${hit ? 'AUDITED ' : 'NO-AUDIT'} ${key}\t${hit ? auditPaths.get(key) : ''}\t[${c.values.join(', ')}]`);
}
console.log(`\nENUM COLUMNS ${enumCols.length}  AUDITED ${covered}  UNAUDITED ${enumCols.length - covered}`);
