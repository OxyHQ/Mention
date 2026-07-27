import { describe, expect, test } from "bun:test";
import { loadApiClientConfig, loadMcpHttpConfig } from "../lib/config.js";

describe("MCP configuration", () => {
  test("applies bounded defaults and normalizes URLs", () => {
    expect(
      loadApiClientConfig({
        MENTION_API_URL: "https://api.mention.test/",
      }),
    ).toEqual({
      baseUrl: "https://api.mention.test",
      requestTimeoutMs: 10_000,
    });

    const config = loadMcpHttpConfig({
      MENTION_MCP_JWT_SECRET: "test-secret",
      MENTION_MCP_PUBLIC_URL: "https://mcp.mention.test/",
      MENTION_OAUTH_AS_URL: "https://api.mention.test/",
    });

    expect(config.port).toBe(3_100);
    expect(config.publicUrl).toBe("https://mcp.mention.test");
    expect(config.oauthAuthorizationServerUrl).toBe("https://api.mention.test");
    expect(config.allowedOrigins.has("https://claude.ai")).toBe(true);
  });

  test("rejects invalid numeric configuration instead of silently falling back", () => {
    expect(() =>
      loadMcpHttpConfig({
        MCP_MAX_SESSIONS: "unbounded",
        MENTION_MCP_JWT_SECRET: "test-secret",
      }),
    ).toThrow("MCP_MAX_SESSIONS");
  });

  test("rejects CORS entries that are not exact HTTP origins", () => {
    expect(() =>
      loadMcpHttpConfig({
        MCP_ALLOWED_ORIGINS: "https://example.com/path",
        MENTION_MCP_JWT_SECRET: "test-secret",
      }),
    ).toThrow("expected an HTTP(S) origin without a path");
  });

  test("requires the resource-server signing secret", () => {
    expect(() => loadMcpHttpConfig({})).toThrow("MENTION_MCP_JWT_SECRET");
  });
});
