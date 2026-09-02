import { afterEach, describe, expect, test } from "bun:test";
import { API_REQUEST_TIMEOUT_MS, api, formatApiError } from "../lib/api-client.js";
import { requestContext } from "../lib/context.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Mention API client resilience", () => {
  test("uses a 10 second per-attempt timeout", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input, init) => {
      signal = init?.signal;
      return Response.json({ ok: true });
    }) as typeof fetch;

    await api.get("/health");

    expect(API_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("retries a GET once after a transient upstream response", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return Response.json({ message: "temporarily unavailable" }, { status: 503 });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    await expect(api.get<{ ok: boolean }>("/feed")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("retries a GET once after a network error", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("connection reset");
      return Response.json({ ok: true });
    }) as typeof fetch;

    await expect(api.get<{ ok: boolean }>("/feed")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("never retries a mutating request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ message: "temporarily unavailable" }, { status: 503 });
    }) as typeof fetch;

    await expect(api.post("/posts", { text: "hello" })).rejects.toMatchObject({
      status: 503,
      message: "temporarily unavailable",
    });
    expect(calls).toBe(1);
  });

  test("binds authenticated writes to the current MCP tool invocation", async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return Response.json({ ok: true });
    }) as typeof fetch;

    await requestContext.run({
      userToken: "opaque-token",
      authMode: "central",
      tokenId: "token-1",
      clientId: "client-1",
      accountId: "account-1",
      scopes: new Set(["social.posts.publish"]),
      idempotencyKey: `mcp:${"a".repeat(64)}`,
      toolName: "create-post",
    }, () => api.post("/posts", { text: "hello" }));

    expect(capturedHeaders?.get("Authorization")).toBe("Bearer opaque-token");
    expect(capturedHeaders?.get("Idempotency-Key")).toBe(`mcp:${"a".repeat(64)}`);
    expect(capturedHeaders?.get("X-Oxy-MCP-Tool")).toBe("create-post");
  });

  test("refuses an authenticated write when no invocation key was established", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ ok: true });
    }) as typeof fetch;

    const error = await requestContext.run({
      userToken: "opaque-token",
      authMode: "central",
      tokenId: "token-1",
      clientId: "client-1",
      accountId: "account-1",
      scopes: new Set(["social.posts.publish"]),
    }, () => api.post("/posts", { text: "hello" }).catch((caught) => caught));

    expect(error).toMatchObject({ status: 500 });
    expect(calls).toBe(0);
  });

  test("normalizes terminal network failures for tool responses", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("connection refused");
    }) as typeof fetch;

    const error = await api.get("/feed").catch((caught) => caught);
    expect(formatApiError(error)).toContain("API error (503)");
    expect(formatApiError(error)).toContain("connection refused");
  });
});
