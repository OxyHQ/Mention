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
      OXY_API_URL: "https://api.oxy.test/",
      OXY_SERVICE_API_KEY: "service-key",
      OXY_SERVICE_API_SECRET: "service-secret",
      MENTION_LEGACY_OAUTH_ISSUER: "https://api.mention.test/",
    });

    expect(config.port).toBe(3_100);
    expect(config.publicUrl).toBe("https://mcp.mention.test");
    expect(config.oxyApiUrl).toBe("https://api.oxy.test");
    expect(config.legacyOauthIssuer).toBe("https://api.mention.test");
    expect(config.allowedOrigins.has("https://claude.ai")).toBe(true);
  });

  test("rejects invalid numeric configuration instead of silently falling back", () => {
    expect(() =>
      loadMcpHttpConfig({
        MCP_MAX_SESSIONS: "unbounded",
        MENTION_MCP_JWT_SECRET: "test-secret",
        OXY_SERVICE_API_KEY: "service-key",
        OXY_SERVICE_API_SECRET: "service-secret",
      }),
    ).toThrow("MCP_MAX_SESSIONS");
  });

  test("rejects CORS entries that are not exact HTTP origins", () => {
    expect(() =>
      loadMcpHttpConfig({
        MCP_ALLOWED_ORIGINS: "https://example.com/path",
        MENTION_MCP_JWT_SECRET: "test-secret",
        OXY_SERVICE_API_KEY: "service-key",
        OXY_SERVICE_API_SECRET: "service-secret",
      }),
    ).toThrow("expected an HTTP(S) origin without a path");
  });

  test("requires the transitional legacy secret, and no longer a service credential", () => {
    /**
     * The pair used to be required. A deployed task proves what it is by
     * attesting its ECS task role and gets the same service token with no
     * secret anywhere (oxy ADR 0026), so requiring it would make a task that
     * authenticates perfectly well refuse to boot — which is the whole point of
     * removing the two variables from the task definition.
     */
    expect(() => loadMcpHttpConfig({})).toThrow("MENTION_MCP_JWT_SECRET");
    const withoutCredential = loadMcpHttpConfig({ MENTION_MCP_JWT_SECRET: "test-secret" });
    expect(withoutCredential.oxyServiceApiKey).toBeUndefined();
    expect(withoutCredential.oxyServiceApiSecret).toBeUndefined();

    // And where a pair IS given — a laptop, which can attest nothing — it is
    // still read and still used.
    const withCredential = loadMcpHttpConfig({
      MENTION_MCP_JWT_SECRET: "test-secret",
      OXY_SERVICE_API_KEY: "service-key",
      OXY_SERVICE_API_SECRET: "service-secret",
    });
    expect(withCredential.oxyServiceApiKey).toBe("service-key");
  });
});

describe('managed MCP configuration', () => {
  test('derives API, resource and catalog audience from one deployment without a legacy secret', async () => {
    const { default: example } = await import('../../shared-types/__tests__/fixtures/managed-deployment.json');
    const environment = {
      MENTION_DEPLOYMENT_CONFIG: JSON.stringify(example),
      OXY_SERVICE_API_KEY: 'tenant-service-key', OXY_SERVICE_API_SECRET: 'tenant-service-secret',
    };
    const http = loadMcpHttpConfig(environment);
    expect(loadApiClientConfig(environment).baseUrl).toBe(example.apiBaseUrl);
    expect(http.publicUrl).toBe(example.mcpBaseUrl);
    expect(http.deploymentIdentity?.audience).toBe(`mention-${example.tenantId}-api`);
    expect(http.deploymentIdentity?.allowLegacyTokens).toBe(false);
    expect(() => loadMcpHttpConfig({ ...environment, MENTION_MCP_PUBLIC_URL: 'https://mcp.mention.earth' }))
      .toThrow('MENTION_MCP_PUBLIC_URL conflicts');
  });
});
