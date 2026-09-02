import { requestContext } from "./context.js";

const AUTH_REQUIRED_MESSAGE =
  "Authentication required. Connect your Mention account in the MCP client to authorize this action.";

export function getMcpToken(): string {
  return requestContext.getStore()?.userToken ?? "";
}

export function authRequiredResponse() {
  return {
    content: [{ type: "text" as const, text: AUTH_REQUIRED_MESSAGE }],
    isError: true as const,
  };
}

export function withAuthGuard<T extends unknown[]>(
  handler: (...args: T) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
) {
  return async (...args: T) => {
    const token = getMcpToken();
    if (!token) {
      return authRequiredResponse();
    }
    return handler(...args);
  };
}
