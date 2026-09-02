import { OxyServices } from "@oxyhq/core";
import {
  introspectOxyMcpAccessToken,
  type McpAccessTokenClaims as OxyMcpAccessTokenClaims,
} from "@oxyhq/mcp";
import {
  MENTION_CAPABILITY_AUDIENCE,
  MENTION_LEGACY_MCP_AUTH_CUTOFF_MS,
} from "@mention/shared-types/mcpCapabilities";
import type { McpHttpConfig } from "./config.js";
import {
  type AuthenticatedMcpToken,
  verifyLegacyMcpAccessToken,
} from "./http-security.js";

type TokenAuthConfig = Pick<
  McpHttpConfig,
  "jwtSecret" | "legacyOauthIssuer" | "oxyApiUrl" | "publicUrl"
>;

export type CentralTokenIntrospector = (
  token: string,
) => Promise<OxyMcpAccessTokenClaims | null>;

export function createCentralTokenIntrospector(
  config: Pick<
    McpHttpConfig,
    "oxyApiUrl" | "oxyServiceApiKey" | "oxyServiceApiSecret"
  >,
): CentralTokenIntrospector {
  const oxy = new OxyServices({ baseURL: config.oxyApiUrl });
  oxy.configureServiceAuth(
    config.oxyServiceApiKey,
    config.oxyServiceApiSecret,
  );
  return (token) =>
    introspectOxyMcpAccessToken(token, {
      endpoint: `${config.oxyApiUrl}/auth/mcp/oauth/introspect`,
      getServiceToken: () => oxy.getServiceToken(),
      invalidateServiceToken: () => oxy.invalidateServiceToken(),
    });
}

export async function authenticateMcpAccessToken(
  token: string,
  options: {
    config: TokenAuthConfig;
    introspectCentral: CentralTokenIntrospector;
    nowMs?: number;
  },
): Promise<AuthenticatedMcpToken | null> {
  const algorithm = jwtAlgorithm(token);
  if (algorithm === "EdDSA") {
    const claims = await options.introspectCentral(token);
    return claims ? centralPrincipal(claims, options.config) : null;
  }
  if (algorithm !== "HS256") return null;

  try {
    return verifyLegacyMcpAccessToken(token, {
      secret: options.config.jwtSecret,
      audience: options.config.publicUrl,
      issuer: options.config.legacyOauthIssuer,
      cutoffMs: MENTION_LEGACY_MCP_AUTH_CUTOFF_MS,
      nowMs: options.nowMs,
    });
  } catch {
    return null;
  }
}

function centralPrincipal(
  claims: OxyMcpAccessTokenClaims,
  config: TokenAuthConfig,
): AuthenticatedMcpToken | null {
  if (
    claims.iss !== config.oxyApiUrl ||
    claims.aud !== MENTION_CAPABILITY_AUDIENCE ||
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
    scope: [...scopes].sort().join(" "),
    scopes,
    accountId: claims.account_id,
    authMode: "central",
  };
}

function scopeSet(value: string | string[]): ReadonlySet<string> {
  const values = Array.isArray(value) ? value : value.split(/\s+/);
  return new Set(values.map((scope) => scope.trim()).filter(Boolean));
}

function jwtAlgorithm(token: string): string | undefined {
  const encodedHeader = token.split(".", 1)[0];
  if (!encodedHeader) return undefined;
  try {
    const header = JSON.parse(
      Buffer.from(encodedHeader, "base64url").toString("utf8"),
    ) as { alg?: unknown };
    return typeof header.alg === "string" ? header.alg : undefined;
  } catch {
    return undefined;
  }
}
