import { describe, expect, test } from "bun:test";
import { extractBearerToken } from "@oxyhq/mcp";
import jwt from "jsonwebtoken";
import {
  fingerprintMcpPrincipal,
  mcpPrincipalMatchesFingerprint,
  verifyLegacyMcpAccessToken,
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
    const principal = {
      sub: "user-1",
      accountId: "account-1",
      client_id: "client-1",
      jti: "bundle-token-1",
    };
    const fingerprint = fingerprintMcpPrincipal(principal);
    expect(fingerprint).not.toContain("user-1");
    expect(mcpPrincipalMatchesFingerprint(principal, fingerprint)).toBe(true);
    expect(
      mcpPrincipalMatchesFingerprint(
        { ...principal, sub: "user-2" },
        fingerprint,
      ),
    ).toBe(false);
    expect(
      mcpPrincipalMatchesFingerprint(
        { ...principal, jti: "bundle-token-2" },
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

    const claims = verifyLegacyMcpAccessToken(token, {
      secret,
      issuer: "https://api.mention.test",
      audience: "https://mcp.mention.test",
      cutoffMs: Date.parse("2030-01-01T00:00:00.000Z"),
      nowMs: Date.parse("2026-09-02T00:00:00.000Z"),
    });
    expect(claims.sub).toBe("user-1");

    expect(() =>
      verifyLegacyMcpAccessToken(token, {
        secret,
        issuer: "https://api.mention.test",
        audience: "https://another-resource.test",
        cutoffMs: Date.parse("2030-01-01T00:00:00.000Z"),
        nowMs: Date.parse("2026-09-02T00:00:00.000Z"),
      }),
    ).toThrow();
  });

  test("rejects every legacy token at the fixed migration cutoff", () => {
    const secret = "test-secret-with-sufficient-entropy";
    const token = jwt.sign(
      { client_id: "client-1", scope: "mcp:read" },
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
    expect(() => verifyLegacyMcpAccessToken(token, {
      secret,
      issuer: "https://api.mention.test",
      audience: "https://mcp.mention.test",
      cutoffMs: 100,
      nowMs: 100,
    })).toThrow("migration window has ended");
  });
});
