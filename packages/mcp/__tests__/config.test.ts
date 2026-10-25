import { describe, expect, test } from 'bun:test';
import { loadApiClientConfig, loadMcpHttpConfig } from '../lib/config.js';

describe('MCP configuration', () => {
  test('applies bounded defaults and normalizes URLs', () => {
    expect(
      loadApiClientConfig({
        MENTION_API_URL: 'https://api.mention.test/',
      }),
    ).toEqual({
      baseUrl: 'https://api.mention.test',
      requestTimeoutMs: 10_000,
    });

    const config = loadMcpHttpConfig({
      MENTION_MCP_PUBLIC_URL: 'https://mcp.mention.test/',
      OXY_API_URL: 'https://api.oxy.test/',
    });

    expect(config.port).toBe(3_100);
    expect(config.publicUrl).toBe('https://mcp.mention.test');
    expect(config.oxyApiUrl).toBe('https://api.oxy.test');
    expect(config.allowedOrigins.has('https://claude.ai')).toBe(true);
  });

  test('rejects invalid numeric configuration instead of silently falling back', () => {
    expect(() =>
      loadMcpHttpConfig({
        MCP_MAX_SESSIONS: 'unbounded',
      }),
    ).toThrow('MCP_MAX_SESSIONS');
  });

  test('rejects CORS entries that are not exact HTTP origins', () => {
    expect(() =>
      loadMcpHttpConfig({
        MCP_ALLOWED_ORIGINS: 'https://example.com/path',
      }),
    ).toThrow('expected an HTTP(S) origin without a path');
  });

  test('uses workload configuration and rejects a customer key fallback', () => {
    expect(loadMcpHttpConfig({}).oxyApiUrl).toBe('https://api.oxy.so');
    expect(() => loadMcpHttpConfig({ OXY_SERVICE_API_KEY: 'customer-key' })).toThrow(
      'workload role',
    );
    expect(() => loadMcpHttpConfig({ OXY_SERVICE_API_SECRET: 'customer-secret' })).toThrow(
      'workload role',
    );
  });
});

describe('managed MCP configuration', () => {
  test('derives API, resource and catalog audience from one deployment', async () => {
    const { default: example } = await import(
      '../../shared-types/__tests__/fixtures/managed-deployment.json'
    );
    const environment = {
      MENTION_DEPLOYMENT_CONFIG: JSON.stringify(example),
    };
    const http = loadMcpHttpConfig(environment);
    expect(loadApiClientConfig(environment).baseUrl).toBe(example.apiBaseUrl);
    expect(http.publicUrl).toBe(example.mcpBaseUrl);
    expect(http.deploymentIdentity?.audience).toBe(`mention-${example.tenantId}-api`);
    expect(() =>
      loadMcpHttpConfig({ ...environment, MENTION_MCP_PUBLIC_URL: 'https://mcp.mention.earth' }),
    ).toThrow('MENTION_MCP_PUBLIC_URL conflicts');
  });
});
