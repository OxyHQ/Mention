import mongoose from 'mongoose';
import { readdirSync } from 'node:fs';

const dir = new URL('../src/models/', import.meta.url).pathname;
const files = readdirSync('/home/nate/Oxy/Mention/.claude/worktrees/backfill-pg/packages/backend/src/models').filter((f) => f.endsWith('.ts'));
for (const f of files) {
  try {
    await import(`/home/nate/Oxy/Mention/.claude/worktrees/backfill-pg/packages/backend/src/models/${f}`);
  } catch (err) {
    console.error(`IMPORT FAIL ${f}: ${(err as Error).message}`);
  }
}
const out: string[] = [];
for (const name of mongoose.modelNames()) {
  const schema = mongoose.model(name).schema;
  const walk = (s: mongoose.Schema, prefix: string) => {
    s.eachPath((p, type) => {
      const full = prefix ? `${prefix}.${p}` : p;
      const ev = (type as unknown as { enumValues?: unknown[] }).enumValues;
      if (Array.isArray(ev) && ev.length) out.push(`${name}\t${full}\t[${ev.join(', ')}]`);
      const caster = (type as unknown as { caster?: { enumValues?: unknown[] } }).caster;
      if (caster && Array.isArray(caster.enumValues) && caster.enumValues.length)
        out.push(`${name}\t${full}[]\t[${caster.enumValues.join(', ')}]`);
      const sub = (type as unknown as { schema?: mongoose.Schema }).schema;
      if (sub) walk(sub, full);
    });
  };
  walk(schema, '');
}
out.sort();
console.log(out.join('\n'));
console.log(`\nMODELS ${mongoose.modelNames().length}  ENUM PATHS ${out.length}`);
