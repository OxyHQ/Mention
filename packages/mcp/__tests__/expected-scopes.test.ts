// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { MENTION_MCP_CAPABILITIES } from '@mention/shared-types/mcpCapabilities';

/**
 * The post-deploy smoke gate (`.github/scripts/smoke-mcp.sh`) checks the
 * deployed resource's `scopes_supported` against
 * `.github/scripts/mcp-expected-scopes.json`. That list is what the server
 * advertises — `MENTION_MCP_CAPABILITIES` — so the two must be equal, or a
 * capability added here passes CI and then fails the production smoke, which
 * rolls the deploy back. That happened to #1192 (`social.mutes.*`).
 */
describe('post-deploy smoke expected scopes', () => {
  test('equal the capabilities the server advertises', () => {
    const expected = JSON.parse(
      readFileSync(
        new URL('../../../.github/scripts/mcp-expected-scopes.json', import.meta.url),
        'utf8',
      ),
    ) as string[];

    expect([...expected].sort()).toEqual([...MENTION_MCP_CAPABILITIES].sort());
  });
});
