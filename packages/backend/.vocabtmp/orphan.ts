import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import * as schema from '../src/db/schema';

const used = new Set<string>();
for (const value of Object.values(schema)) {
  if (!is(value, PgTable)) continue;
  for (const col of getTableConfig(value as PgTable).columns) {
    const ev = (col as unknown as { enumValues?: readonly string[] }).enumValues;
    if (Array.isArray(ev) && ev.length) used.add(ev.join(' '));
  }
}
for (const [name, value] of Object.entries(schema)) {
  if (!Array.isArray(value)) continue;
  if (!/^[A-Z0-9_]+$/.test(name)) continue;
  const key = value.join(' ');
  if (!used.has(key)) console.log(`ORPHAN  ${name}\t[${value.join(', ')}]`);
}
