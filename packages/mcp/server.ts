/**
 * Mention MCP Server — stdio transport
 *
 * Usage:
 *   MENTION_API_URL=https://api.mention.earth bun server.ts
 *
 * Environment variables:
 *   MENTION_API_URL — Base URL of the Mention API (default: https://api.mention.earth)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./lib/create-server.js";
import { sanitizeLogValue } from "./lib/logger.js";

function formatStdioLog(args: unknown[]): string {
  try {
    return JSON.stringify(sanitizeLogValue(args));
  } catch {
    return JSON.stringify(["[Unserializable]"]);
  }
}

function redirectConsoleToStderr(): void {
  const write = (level: string, args: unknown[]): void => {
    process.stderr.write(
      `[mention-mcp] ${level} ${formatStdioLog(args)}\n`,
    );
  };

  // stdout is reserved exclusively for MCP protocol frames. Keep these
  // redirects installed for the entire process lifetime: connect() resolves
  // once the transport is attached, not when the stdio session ends.
  console.log = (...args: unknown[]) => write("INFO", args);
  console.info = (...args: unknown[]) => write("INFO", args);
  console.debug = (...args: unknown[]) => write("DEBUG", args);
  console.warn = (...args: unknown[]) => write("WARN", args);
  console.error = (...args: unknown[]) => write("ERROR", args);
}

async function main() {
  redirectConsoleToStderr();

  const server = createMcpServer();

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("[mention-mcp] MCP server running on stdio.\n");
}

main().catch((error) => {
  process.stderr.write(
    `[mention-mcp] Fatal error: ${formatStdioLog([error])}\n`,
  );
  process.exit(1);
});
