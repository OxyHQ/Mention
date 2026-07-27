import { describe, expect, test } from "bun:test";
import jwt from "jsonwebtoken";
import {
  extractBearerToken,
  fingerprintMcpPrincipal,
  mcpPrincipalMatchesFingerprint,
  verifyMcpAccessToken,
} from "../lib/http-security.js";

describe("MCP HTTP authentication", () => {
  test("accepts a case-insensitive Bearer scheme", () => {
    expect(extractBearerToken({ authorization: "bearer token-value" })).toBe("token-value");
  });

  test("rejects empty, malformed and duplicate credentials", () => {
    expect(extractBearerToken({ authorization: "Bearer" })).toBeUndefined();
    expect(extractBearerToken({ authorization: "Bearer one two" })).toBeUndefined();
    expect(extractBearerToken({ authorization: ["Bearer one", "Bearer two"] })).toBeUndefined();
  });

  test("binds sessions to a non-reversible token family, user and client", () => {
    const principal = { sub: "user-1", client_id: "client-1", jti: "bundle-token-1" };
    const fingerprint = fingerprintMcpPrincipal(principal);
    expect(fingerprint).not.toContain("user-1");
    expect(mcpPrincipalMatchesFingerprint(principal, fingerprint)).toBe(true);
    expect(
      mcpPrincipalMatchesFingerprint(
        { sub: "user-2", client_id: "client-1", jti: "bundle-token-1" },
        fingerprint,
      ),
    ).toBe(false);
    expect(
      mcpPrincipalMatchesFingerprint(
        { sub: "user-1", client_id: "client-1", jti: "bundle-token-2" },
        fingerprint,
      ),
    ).toBe(false);
  });

  test("verifies signature, issuer, audience and resource scope", () => {
    const secret = "test-secret-with-sufficient-entropy";
    const token = jwt.sign(
      {
        client_id: "client-1",
        scope: "mcp:read",
      },
      secret,
      {
        algorithm: "HS256",
        subject: "user-1",
        jwtid: "connection-1",
        issuer: "https://api.mention.test",
        audience: "https://mcp.mention.test",
        expiresIn: "5m",
      },
    );

    const claims = verifyMcpAccessToken(token, {
      secret,
      issuer: "https://api.mention.test",
      audience: "https://mcp.mention.test",
    });
    expect(claims.sub).toBe("user-1");

    expect(() =>
      verifyMcpAccessToken(token, {
        secret,
        issuer: "https://api.mention.test",
        audience: "https://another-resource.test",
      }),
    ).toThrow();
  });
});
