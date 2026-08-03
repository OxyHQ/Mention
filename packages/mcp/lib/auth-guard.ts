import { requestContext } from "./context.js";

const AUTH_REQUIRED_MESSAGE =
  "Authentication required. Connect your Mention account in the MCP client to authorize this action.";

type McpScope = "mcp:read" | "mcp:write";

export function getMcpToken(): string {
  return requestContext.getStore()?.userToken ?? "";
}

export function authRequiredResponse() {
  return {
    content: [{ type: "text" as const, text: AUTH_REQUIRED_MESSAGE }],
    isError: true as const,
  };
}

function insufficientScopeResponse(requiredScope: McpScope) {
  return {
    content: [{ type: "text" as const, text: `This tool requires the ${requiredScope} OAuth scope.` }],
    isError: true as const,
  };
}

function tokenScopes(token: string): Set<string> {
  try {
    const payload = token.split(".")[1];
    if (!payload) return new Set();
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { scope?: unknown };
    if (typeof decoded.scope !== "string") return new Set();
    return new Set(decoded.scope.split(/\s+/).map((scope) => scope.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function withAuthGuard<T extends unknown[]>(
  handler: (...args: T) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
  options: { requiredScope?: McpScope } = {},
) {
  return async (...args: T) => {
    const token = getMcpToken();
    if (!token) {
      return authRequiredResponse();
    }
    if (options.requiredScope && !tokenScopes(token).has(options.requiredScope)) {
      return insufficientScopeResponse(options.requiredScope);
    }
    return handler(...args);
  };
}
