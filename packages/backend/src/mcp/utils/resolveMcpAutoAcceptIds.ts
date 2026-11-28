// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { Request } from 'express';
import type { OxyAuthRequestWithMcp } from '../middleware/mcpAuth';

/**
 * The invited collaborators an MCP connection may accept for: those of them it
 * can already act as. Oxy says which accounts approved this connection — the
 * same set `/mcp/bundles/active` switches between — so inviting one of them from
 * another is one person arranging their own accounts, not an invitation that
 * waits on somebody else.
 */
export function resolveMcpAutoAcceptIds(
  req: Request,
  invitedIds: string[] | undefined,
): string[] | undefined {
  if (!invitedIds || invitedIds.length === 0) return undefined;
  const accounts = (req as OxyAuthRequestWithMcp).mcp?.connection?.accounts;
  if (!accounts) return undefined;
  const members = new Set(accounts.map((account) => account.accountId));
  const accepted = invitedIds.filter((id) => members.has(id));
  return accepted.length > 0 ? accepted : undefined;
}
