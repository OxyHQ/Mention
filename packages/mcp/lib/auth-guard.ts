import { requestContext } from "./context.js";
import { AUTH_REQUIRED_MESSAGE } from "./tool-auth.js";

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
    if (!getMcpToken()) {
      return authRequiredResponse();
    }
    return handler(...args);
  };
}
