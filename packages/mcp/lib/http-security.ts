import { createHash, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";

export interface McpAccessTokenClaims {
  sub: string;
  jti: string;
  client_id: string;
  scope: string;
  aud: string | string[];
  iss: string;
  iat: number;
  exp: number;
}

export interface AuthenticatedMcpToken {
  sub: string;
  jti: string;
  client_id: string;
  scope: string;
  scopes: ReadonlySet<string>;
  accountId: string;
  authMode: "central" | "legacy";
}

export interface VerifyMcpAccessTokenOptions {
  secret: string | undefined;
  audience: string;
  issuer: string;
}

export interface VerifyLegacyMcpAccessTokenOptions
  extends VerifyMcpAccessTokenOptions {
  cutoffMs: number;
  nowMs?: number;
}

/**
 * Bind a session to the token family (`jti`), subject and OAuth client. A token
 * refresh rotates `jti`, so the client must initialize a fresh transport; this
 * prevents a new/relinked bundle owned by the same subject and client from
 * taking over a leaked session id.
 */
export function fingerprintMcpPrincipal(
  claims: Pick<AuthenticatedMcpToken, "sub" | "client_id" | "jti" | "accountId">,
): string {
  return createHash("sha256")
    .update(
      `${claims.jti}\0${claims.sub}\0${claims.client_id}\0${claims.accountId}`,
      "utf8",
    )
    .digest("hex");
}

/** Constant-time comparison prevents a session from being reused with another token. */
export function mcpPrincipalMatchesFingerprint(
  claims: Pick<AuthenticatedMcpToken, "sub" | "client_id" | "jti" | "accountId">,
  expectedFingerprint: string | undefined,
): boolean {
  if (!expectedFingerprint) return false;

  const actual = Buffer.from(fingerprintMcpPrincipal(claims), "hex");
  const expected = Buffer.from(expectedFingerprint, "hex");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

/**
 * Verify the resource server's HS256 access token before allocating or
 * resuming a transport. Backend API middleware remains responsible for the
 * connection revocation lookup.
 */
export function verifyLegacyMcpAccessToken(
  token: string,
  options: VerifyLegacyMcpAccessTokenOptions,
): AuthenticatedMcpToken {
  if ((options.nowMs ?? Date.now()) >= options.cutoffMs) {
    throw new jwt.JsonWebTokenError("Legacy MCP token migration window has ended");
  }
  if (!options.secret) {
    throw new Error("MENTION_MCP_JWT_SECRET is not configured");
  }

  const decoded = jwt.verify(token, options.secret, {
    algorithms: ["HS256"],
    audience: options.audience,
    issuer: options.issuer,
  });
  if (
    typeof decoded === "string" ||
    typeof decoded.sub !== "string" ||
    typeof decoded.jti !== "string" ||
    typeof decoded.client_id !== "string" ||
    typeof decoded.scope !== "string"
  ) {
    throw new jwt.JsonWebTokenError("Malformed MCP access token payload");
  }

  const scopes = new Set(decoded.scope.split(/\s+/).filter(Boolean));
  if (!scopes.has("mcp:read") && !scopes.has("mcp:write")) {
    throw new jwt.JsonWebTokenError("MCP access token has no resource scope");
  }

  const claims = decoded as unknown as McpAccessTokenClaims;
  return {
    sub: claims.sub,
    jti: claims.jti,
    client_id: claims.client_id,
    scope: claims.scope,
    scopes,
    accountId: claims.sub,
    authMode: "legacy",
  };
}
