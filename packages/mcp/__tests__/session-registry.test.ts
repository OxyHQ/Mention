import { describe, expect, test } from "bun:test";
import { fingerprintMcpPrincipal, type AuthenticatedMcpToken } from "../lib/http-security.js";
import {
  McpSessionRegistry,
  type McpHttpTransport,
} from "../lib/session-registry.js";

const claims = {
  sub: "user-1",
  accountId: "account-1",
  client_id: "client-1",
  jti: "token-family-1",
  scope: "social.read",
  scopes: new Set(["social.read"]),
  authMode: "central",
} as AuthenticatedMcpToken;

describe("MCP session registry", () => {
  test("keeps transport, activity and principal state in sync", () => {
    const registry = new McpSessionRegistry();
    const transport = fakeTransport();

    registry.register(
      "session-1",
      transport.value,
      fingerprintMcpPrincipal(claims),
      1_000,
    );

    expect(registry.size).toBe(1);
    expect(registry.get("session-1")).toBe(transport.value);
    expect(registry.isAuthorized("session-1", claims)).toBe(true);
    expect(
      registry.isAuthorized("session-1", {
        ...claims,
        sub: "another-user",
      }),
    ).toBe(false);

    registry.delete("session-1");
    expect(registry.size).toBe(0);
    expect(registry.isAuthorized("session-1", claims)).toBe(false);
  });

  test("closes only idle streamable sessions", async () => {
    const registry = new McpSessionRegistry();
    const stale = fakeTransport();
    const active = fakeTransport();

    registry.register(
      "stale",
      stale.value,
      fingerprintMcpPrincipal(claims),
      1_000,
    );
    registry.register(
      "active",
      active.value,
      fingerprintMcpPrincipal(claims),
      1_900,
    );

    expect(registry.cleanupIdle(2_000, 500)).toBe(1);
    await Promise.resolve();

    expect(stale.closed()).toBe(1);
    expect(active.closed()).toBe(0);
    expect(registry.has("stale")).toBe(false);
    expect(registry.has("active")).toBe(true);
  });

  test("drains every registered transport during shutdown", async () => {
    const registry = new McpSessionRegistry();
    const first = fakeTransport();
    const second = fakeTransport();
    const fingerprint = fingerprintMcpPrincipal(claims);

    registry.register("first", first.value, fingerprint);
    registry.register("second", second.value, fingerprint);
    await registry.closeAll();

    expect(registry.size).toBe(0);
    expect(first.closed()).toBe(1);
    expect(second.closed()).toBe(1);
  });
});

function fakeTransport(): {
  value: McpHttpTransport;
  closed: () => number;
} {
  let closeCalls = 0;
  return {
    value: {
      close: async () => {
        closeCalls++;
      },
    } as McpHttpTransport,
    closed: () => closeCalls,
  };
}
