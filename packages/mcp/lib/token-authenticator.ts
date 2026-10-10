import { mcpDeploymentIdentity } from '@mention/shared-types/deployment';
import { oxyServiceClient } from './oxy-service-client.js';
import {
  introspectOxyMcpAccessToken,
  type McpAccessTokenClaims as OxyMcpAccessTokenClaims,
} from '@oxy.so/mcp';
import type { McpHttpConfig } from './config.js';
import type { AuthenticatedMcpToken } from './http-security.js';

type TokenAuthConfig = Pick<McpHttpConfig, 'oxyApiUrl' | 'publicUrl' | 'deploymentIdentity'>;

export type CentralTokenIntrospector = (token: string) => Promise<OxyMcpAccessTokenClaims | null>;

export function createCentralTokenIntrospector(
  config: Pick<McpHttpConfig, 'oxyApiUrl' | 'oxyServiceApiKey' | 'oxyServiceApiSecret'>,
): CentralTokenIntrospector {
  const oxy = oxyServiceClient(config);
  return (token) =>
    introspectOxyMcpAccessToken(token, {
      endpoint: `${config.oxyApiUrl}/auth/mcp/oauth/introspect`,
      getServiceToken: () => oxy.serviceToken(),
      invalidateServiceToken: () => oxy.invalidateServiceToken(),
    });
}

/**
 * The principal behind an MCP access token: an Oxy-issued (EdDSA) token,
 * introspected live. Mention-issued HS256 tokens were retired on 2026-10-02 and
 * are refused like any other unknown token.
 */
export async function authenticateMcpAccessToken(
  token: string,
  options: {
    config: TokenAuthConfig;
    introspectCentral: CentralTokenIntrospector;
  },
): Promise<AuthenticatedMcpToken | null> {
  if (jwtAlgorithm(token) !== 'EdDSA') return null;
  const claims = await options.introspectCentral(token);
  return claims ? centralPrincipal(claims, options.config) : null;
}

function centralPrincipal(
  claims: OxyMcpAccessTokenClaims,
  config: TokenAuthConfig,
): AuthenticatedMcpToken | null {
  const identity =
    config.deploymentIdentity ??
    mcpDeploymentIdentity({ MENTION_MCP_PUBLIC_URL: config.publicUrl });
  if (
    claims.iss !== config.oxyApiUrl ||
    claims.aud !== identity.audience ||
    claims.resource !== config.publicUrl
  ) {
    return null;
  }
  const scopes = scopeSet(claims.scope);
  if (scopes.size === 0) return null;
  return {
    sub: claims.sub,
    jti: claims.jti,
    client_id: claims.client_id,
    scope: [...scopes].sort().join(' '),
    scopes,
    accountId: claims.account_id,
    authMode: 'central',
  };
}

function scopeSet(value: string | string[]): ReadonlySet<string> {
  const values = Array.isArray(value) ? value : value.split(/\s+/);
  return new Set(values.map((scope) => scope.trim()).filter(Boolean));
}

function jwtAlgorithm(token: string): string | undefined {
  const encodedHeader = token.split('.', 1)[0];
  if (!encodedHeader) return undefined;
  try {
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as {
      alg?: unknown;
    };
    return typeof header.alg === 'string' ? header.alg : undefined;
  } catch {
    return undefined;
  }
}
