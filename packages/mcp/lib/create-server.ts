// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Shared MCP server factory used by the HTTP transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MENTION_TOOL_REGISTRY } from './mention-catalog.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'mention', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  MENTION_TOOL_REGISTRY.registerWithMcp(server);

  return server;
}
