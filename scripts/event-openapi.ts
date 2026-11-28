// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { readFileSync, writeFileSync } from 'node:fs';
import { eventOpenApi } from '../packages/contracts/src/events';
const path = new URL('../packages/contracts/openapi.events.json', import.meta.url);
const expected = `${JSON.stringify(eventOpenApi(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== expected)
    throw new Error('Event OpenAPI is stale; run bun scripts/event-openapi.ts');
} else writeFileSync(path, expected);
