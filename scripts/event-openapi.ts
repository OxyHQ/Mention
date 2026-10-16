import { readFileSync, writeFileSync } from 'node:fs';
import { eventOpenApi } from '../packages/contracts/src/events';
const path = new URL('../packages/contracts/openapi.events.json', import.meta.url);
const expected = `${JSON.stringify(eventOpenApi(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== expected)
    throw new Error('Event OpenAPI is stale; run bun scripts/event-openapi.ts');
} else writeFileSync(path, expected);
