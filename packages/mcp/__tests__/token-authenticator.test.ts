import { describe, expect, test } from "bun:test";
import jwt from "jsonwebtoken";
import type { McpAccessTokenClaims } from "@oxyhq/mcp";
import {
  authenticateMcpAccessToken,
  type CentralTokenIntrospector,
} from "../lib/token-authenticator.js";

const config = {
  jwtSecret: "legacy-secret-with-sufficient-entropy",
  legacyOauthIssuer: "https://api.mention.test",
  oxyApiUrl: "https://api.oxy.test",
  publicUrl: "https://mcp.mention.earth",
};

const centralClaims: McpAccessTokenClaims = {
  iss: "https://api.oxy.test",
  sub: "owner-1",
  aud: "mention-api",
  resource: "https://mcp.mention.earth",
  client_id: "client-1",
  scope: "social.read social.posts.publish",
  jti: "access-1",
  iat: 1_787_000_000,
  nbf: 1_787_000_000,
  exp: 1_787_000_900,
  account_id: "account-1",
};

function unsignedRoutingToken(algorithm: "EdDSA" | "none"): string {
  return [
    Buffer.from(JSON.stringify({ alg: algorithm })).toString("base64url"),
    Buffer.from("{}").toString("base64url"),
    "signature",
  ].join(".");
}

describe("Mention MCP token authority", () => {
  test("accepts a live central token only with exact issuer, audience and resource", async () => {
    const introspect: CentralTokenIntrospector = async () => centralClaims;
    const principal = await authenticateMcpAccessToken(
      unsignedRoutingToken("EdDSA"),
      { config, introspectCentral: introspect },
    );

    expect(principal).toMatchObject({
      authMode: "central",
      sub: "owner-1",
      accountId: "account-1",
      client_id: "client-1",
    });
    expect(principal?.scopes).toEqual(
      new Set(["social.read", "social.posts.publish"]),
    );

    const wrongResource: CentralTokenIntrospector = async () => ({
      ...centralClaims,
      resource: "https://mcp.other.oxy.so",
    });
    await expect(authenticateMcpAccessToken(
      unsignedRoutingToken("EdDSA"),
      { config, introspectCentral: wrongResource },
    )).resolves.toBeNull();
  });

  test("never treats an unknown algorithm as a legacy fallback", async () => {
    const introspect: CentralTokenIntrospector = async () => centralClaims;
    await expect(authenticateMcpAccessToken(
      unsignedRoutingToken("none"),
      { config, introspectCentral: introspect },
    )).resolves.toBeNull();
  });

  test("keeps existing HS256 tokens only inside the fixed migration window", async () => {
    const token = jwt.sign(
      { client_id: "legacy-client", scope: "mcp:read" },
      config.jwtSecret,
      {
        algorithm: "HS256",
        subject: "legacy-user",
        jwtid: "legacy-jti",
        issuer: config.legacyOauthIssuer,
        audience: config.publicUrl,
        expiresIn: "5m",
      },
    );
    const neverIntrospect: CentralTokenIntrospector = async () => {
      throw new Error("central introspection must not run for a legacy JWT");
    };
    const principal = await authenticateMcpAccessToken(token, {
      config,
      introspectCentral: neverIntrospect,
      nowMs: Date.parse("2026-09-02T00:00:00.000Z"),
    });
    expect(principal).toMatchObject({
      authMode: "legacy",
      accountId: "legacy-user",
    });
  });
});
