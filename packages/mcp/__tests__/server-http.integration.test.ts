import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readListeningPort, waitForExit } from "./support/spawn-server.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("MCP HTTP resource server", () => {
  test(
    "challenges unauthenticated clients, rejects invalid tokens and drains on SIGTERM",
    async () => {
      const child = Bun.spawn({
        cmd: [process.execPath, "server-http.ts"],
        cwd: packageRoot,
        env: {
          ...process.env,
          MCP_PORT: "0",
          MENTION_MCP_JWT_SECRET: "integration-test-secret",
          MENTION_MCP_PUBLIC_URL: "http://127.0.0.1",
          OXY_API_URL: "https://api.oxy.test",
          OXY_SERVICE_API_KEY: "service-key",
          OXY_SERVICE_API_SECRET: "service-secret",
          MENTION_LEGACY_OAUTH_ISSUER: "https://api.mention.test",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        const port = await readListeningPort(child.stdout);
        const baseUrl = `http://127.0.0.1:${port}`;

        const health = await fetch(`${baseUrl}/health`);
        expect(health.status).toBe(200);

        const metadata = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
        expect(await metadata.json()).toMatchObject({
          resource: "http://127.0.0.1",
          authorization_servers: ["https://api.oxy.test"],
          scopes_supported: expect.arrayContaining([
            "social.read",
            "social.posts.publish",
          ]),
        });

        // The dedicated lane is mounted before the general body parser and
        // cannot quietly use external OAuth when its binding is absent.
        const internalDisabled = await fetch(`${baseUrl}/_oxy/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{not-json",
        });
        expect(internalDisabled.status).toBe(503);
        expect(JSON.stringify(await internalDisabled.json())).toContain("not configured");

        const challenge = await fetch(`${baseUrl}/`);
        expect(challenge.status).toBe(401);
        expect(challenge.headers.get("www-authenticate")).toContain(
          'resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"',
        );

        const invalidToken = await fetch(`${baseUrl}/`, {
          method: "POST",
          headers: {
            Authorization: "Bearer not-a-valid-jwt",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {},
          }),
        });
        expect(invalidToken.status).toBe(401);

        // A session id never substitutes for a token, whichever task it names.
        const invalidTokenWithSession = await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: {
            Authorization: "Bearer not-a-valid-jwt",
            "Content-Type": "application/json",
            "Mcp-Session-Id": "session-from-another-task",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        });
        expect(invalidTokenWithSession.status).toBe(401);
        expect(invalidTokenWithSession.headers.get("www-authenticate")).toContain("Bearer");

        for (const method of ["GET", "DELETE"]) {
          const unauthenticated = await fetch(`${baseUrl}/mcp`, {
            method,
            headers: { Authorization: "Bearer not-a-valid-jwt" },
          });
          expect(unauthenticated.status).toBe(401);
        }

        const legacySse = await fetch(`${baseUrl}/sse`, {
          headers: { Authorization: "Bearer not-a-valid-jwt" },
        });
        expect(legacySse.status).toBe(401);

        child.kill("SIGTERM");
        expect(await waitForExit(child)).toBe(0);
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
      }
    },
    20_000,
  );
});

describe("MCP HTTP resource server when Oxy cannot be reached", () => {
  test(
    "answers 503 with Retry-After, never 401, for a token it cannot check",
    async () => {
      // Port 9 on loopback refuses at once, offline, with no DNS lookup a CI
      // runner could leave hanging. The Oxy client still retries (three 5s
      // attempts), so each request takes ~15s to give up — hence the timeout.
      const child = Bun.spawn({
        cmd: [process.execPath, "server-http.ts"],
        cwd: packageRoot,
        env: {
          ...process.env,
          MCP_PORT: "0",
          MENTION_MCP_JWT_SECRET: "integration-test-secret",
          MENTION_MCP_PUBLIC_URL: "http://127.0.0.1",
          OXY_API_URL: "http://127.0.0.1:9",
          OXY_SERVICE_API_KEY: "service-key",
          OXY_SERVICE_API_SECRET: "service-secret",
          MENTION_LEGACY_OAUTH_ISSUER: "https://api.mention.test",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        const port = await readListeningPort(child.stdout);
        const baseUrl = `http://127.0.0.1:${port}`;
        const centralToken = [
          Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url"),
          Buffer.from("{}").toString("base64url"),
          "signature",
        ].join(".");

        // Concurrent, since each one waits out the Oxy client's retries.
        const [unavailable, unavailableInSession, unavailableSse] = await Promise.all([
          fetch(`${baseUrl}/`, {
            method: "POST",
            headers: { Authorization: `Bearer ${centralToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
          }),
          // A call inside a session issued by another task: still 503, never
          // 401 (re-authorize) and never 404 (session lost).
          fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${centralToken}`,
              "Content-Type": "application/json",
              "Mcp-Session-Id": "session-from-another-task",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
          }),
          fetch(`${baseUrl}/sse`, {
            headers: { Authorization: `Bearer ${centralToken}` },
          }),
        ]);
        for (const response of [unavailable, unavailableInSession]) {
          expect(response.status).toBe(503);
          expect(response.headers.get("retry-after")).toBe("30");
          expect(response.headers.get("www-authenticate")).toBeNull();
        }
        expect(unavailableSse.status).toBe(503);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    },
    60_000,
  );
});
