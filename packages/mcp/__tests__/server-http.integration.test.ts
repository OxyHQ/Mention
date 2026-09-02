import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

async function readListeningPort(
  stdout: ReadableStream<Uint8Array>,
): Promise<number> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      delay(remaining).then(() => {
        throw new Error(`MCP server did not start. Output: ${output}`);
      }),
    ]);
    if (result.done) {
      throw new Error(`MCP server exited before listening. Output: ${output}`);
    }
    output += decoder.decode(result.value, { stream: true });
    const match = /Listening on :(\d+)/.exec(output);
    if (match) return Number(match[1]);
  }

  throw new Error(`MCP server did not report a listening port. Output: ${output}`);
}

async function waitForExit(
  child: Bun.Subprocess<"ignore" | "pipe", "ignore" | "pipe", "inherit">,
): Promise<number> {
  return Promise.race([
    child.exited,
    delay(10_000).then(() => {
      child.kill("SIGKILL");
      throw new Error("MCP server did not terminate after SIGTERM");
    }),
  ]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
