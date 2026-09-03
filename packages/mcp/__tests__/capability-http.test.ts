import { afterEach, describe, expect, test, vi } from "bun:test";
import type { CapabilityTicketClaims } from "@oxyhq/contracts";
import { handleMentionCapabilityRequest } from "../lib/capability-http.js";
import type { MentionCapabilityAuthority } from "../lib/capability-authority.js";

const originalFetch = globalThis.fetch;

function claims(tool: string, capability: string): CapabilityTicketClaims {
  const now = Math.floor(Date.now() / 1_000);
  return {
    iss: "https://api.oxy.so",
    aud: "mention-api",
    sub: "agent-account",
    jti: `ticket-${tool}`,
    iat: now,
    exp: now + 60,
    runId: "run-1",
    executionAuthorization: { kind: "direct_request", id: "authorization-1" },
    coordinator: { applicationId: "alia", credentialId: "alia-credential" },
    requesterAccountId: "owner-account",
    ownerAccountId: "owner-account",
    actor: { type: "agent", accountId: "agent-account" },
    resource: {
      appId: "mention",
      effectiveAccountId: "assigned-account",
      resourceType: "mention_account",
      resourceId: "assigned-account",
    },
    tool,
    capabilities: [capability],
    limits: [],
    autonomy: "execute_on_request",
  };
}

function authorityFor(ticketClaims: CapabilityTicketClaims | null) {
  const audit = vi.fn(async () => undefined);
  const authority: MentionCapabilityAuthority = {
    introspect: vi.fn(async () => ticketClaims),
    audit,
  };
  return { authority, audit };
}

function invocation(tool: string, body: Record<string, unknown>, idempotencyKey?: string) {
  return {
    method: "POST",
    pathname: `/_oxy/capabilities/${tool}`,
    authorization: "Capability signed-ticket",
    body,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

describe("Mention native capability HTTP adapter", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("publishes from the assigned account and audits the raw idempotency key", async () => {
    const { authority, audit } = authorityFor(claims("create-post", "social.posts.publish"));
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Capability signed-ticket");
      expect(headers["X-Oxy-Capability-Tool"]).toBe("create-post");
      expect(headers["Idempotency-Key"]).toBe("run-1:create-post");
      return new Response(JSON.stringify({
        success: true,
        data: { id: "post-1", oxyUserId: "assigned-account", content: { text: "Hello" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchMock;

    const result = await handleMentionCapabilityRequest(
      invocation("create-post", { text: "Hello" }, "run-1:create-post"),
      authority,
    );

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      ticket: "signed-ticket",
      idempotencyKey: "run-1:create-post",
      result: { status: "succeeded" },
    }));
  });

  test("reads social content through the same catalog handler", async () => {
    const { authority } = authorityFor(claims("get-post", "social.posts.read"));
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/feed/item/post-1");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Capability signed-ticket");
      expect(headers["X-Oxy-Capability-Tool"]).toBe("get-post");
      expect(headers["Idempotency-Key"]).toBeUndefined();
      return new Response(JSON.stringify({
        id: "post-1",
        oxyUserId: "author-account",
        content: { text: "Visible post" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchMock;

    const result = await handleMentionCapabilityRequest(
      invocation("get-post", { id: "post-1" }),
      authority,
    );
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not report a completed publication as failed when audit delivery is unavailable", async () => {
    const ticketClaims = claims("create-post", "social.posts.publish");
    const authority: MentionCapabilityAuthority = {
      introspect: vi.fn(async () => ticketClaims),
      audit: vi.fn(async () => {
        throw new Error("audit unavailable");
      }),
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { id: "post-1", oxyUserId: "assigned-account", content: { text: "Hello" } },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await handleMentionCapabilityRequest(
      invocation("create-post", { text: "Hello" }, "run-1:create-post"),
      authority,
    );

    expect(result.status).toBe(200);
    expect(result.body.isError).not.toBe(true);
  });

  test("fails closed when authority was revoked before execution", async () => {
    const { authority } = authorityFor(null);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const result = await handleMentionCapabilityRequest(
      invocation("create-post", { text: "must not publish" }, "key-1"),
      authority,
    );
    expect(result.status).toBe(403);
    expect(result.body.error).toBe("capability_revoked_or_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects a ticket bound to a different account resource", async () => {
    const mismatched = claims("delete-post", "social.posts.delete");
    mismatched.resource.resourceId = "other-account";
    const { authority } = authorityFor(mismatched);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const result = await handleMentionCapabilityRequest(
      invocation("delete-post", { id: "post-1" }, "key-2"),
      authority,
    );
    expect(result.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
