// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, test } from 'bun:test';
import { extractBearerToken } from '@oxy.so/mcp';
import { fingerprintMcpPrincipal, mcpPrincipalMatchesFingerprint } from '../lib/http-security.js';

describe('MCP HTTP authentication', () => {
  test('accepts a case-insensitive Bearer scheme', () => {
    expect(extractBearerToken({ authorization: 'bearer token-value' })).toBe('token-value');
  });

  test('rejects empty, malformed and duplicate credentials', () => {
    expect(extractBearerToken({ authorization: 'Bearer' })).toBeUndefined();
    expect(extractBearerToken({ authorization: 'Bearer one two' })).toBeUndefined();
    expect(extractBearerToken({ authorization: ['Bearer one', 'Bearer two'] })).toBeUndefined();
  });

  test('binds sessions to a non-reversible token family, user and client', () => {
    const principal = {
      sub: 'user-1',
      accountId: 'account-1',
      client_id: 'client-1',
      jti: 'bundle-token-1',
    };
    const fingerprint = fingerprintMcpPrincipal(principal);
    expect(fingerprint).not.toContain('user-1');
    expect(mcpPrincipalMatchesFingerprint(principal, fingerprint)).toBe(true);
    expect(mcpPrincipalMatchesFingerprint({ ...principal, sub: 'user-2' }, fingerprint)).toBe(
      false,
    );
    expect(
      mcpPrincipalMatchesFingerprint({ ...principal, jti: 'bundle-token-2' }, fingerprint),
    ).toBe(false);
  });
});
