import { createHash, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";

type HttpHeaders = Record<string, string | string[] | undefined>;

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

export interface VerifyMcpAccessTokenOptions {
  secret: string | undefined;
  audience: string;
  issuer: string;
}

/**
 * Parse a single RFC 6750 Bearer credential. The auth scheme is
 * case-insensitive; malformed, empty and duplicate headers are rejected.
 */
export function extractBearerToken(headers: HttpHeaders): string | undefined {
  const authHeader = headers.authorization;
  if (Array.isArray(authHeader)) {
    if (authHeader.length !== 1) return undefined;
    return parseBearerValue(authHeader[0]);
  }
  return parseBearerValue(authHeader);
}

/**
 * Bind a session to the token family (`jti`), subject and OAuth client. A token
 * refresh rotates `jti`, so the client must initialize a fresh transport; this
 * prevents a new/relinked bundle owned by the same subject and client from
 * taking over a leaked session id.
 */
export function fingerprintMcpPrincipal(
  claims: Pick<McpAccessTokenClaims, "sub" | "client_id" | "jti">,
): string {
  return createHash("sha256")
    .update(`${claims.jti}\0${claims.sub}\0${claims.client_id}`, "utf8")
    .digest("hex");
}

/** Constant-time comparison prevents a session from being reused with another token. */
export function mcpPrincipalMatchesFingerprint(
  claims: Pick<McpAccessTokenClaims, "sub" | "client_id" | "jti">,
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
export function verifyMcpAccessToken(
  token: string,
  options: VerifyMcpAccessTokenOptions,
): McpAccessTokenClaims {
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

  return decoded as unknown as McpAccessTokenClaims;
}

function parseBearerValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer[ \t]+([^ \t,]+)[ \t]*$/i.exec(value);
  return match?.[1] || undefined;
}
