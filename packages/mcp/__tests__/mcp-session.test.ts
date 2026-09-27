import { describe, expect, test } from "bun:test";
import { resolveMcpSession } from "../lib/mcp-session.js";

const initialize = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
};
const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("stateless MCP session ids", () => {
  test("issues a fresh id on initialize, even over a presented one", () => {
    expect(resolveMcpSession(initialize, undefined, () => "new-id")).toEqual({
      ok: true,
      id: "new-id",
      issued: true,
    });
    expect(resolveMcpSession(initialize, "old-id", () => "new-id")).toEqual({
      ok: true,
      id: "new-id",
      issued: true,
    });
    expect(resolveMcpSession([initialize], undefined, () => "batched")).toMatchObject({
      id: "batched",
      issued: true,
    });
  });

  test("accepts any well-formed presented id without a lookup", () => {
    for (const id of ["0b9c8a3e-4c5d-4e6f-8a7b-9c0d1e2f3a4b", "issued-by-a-dead-task", "x"]) {
      expect(resolveMcpSession(toolsList, id)).toEqual({ ok: true, id, issued: false });
    }
    expect(resolveMcpSession(toolsList, ["first", "second"])).toEqual({
      ok: true,
      id: "first",
      issued: false,
    });
  });

  test("requires an id after initialize", () => {
    const resolved = resolveMcpSession(toolsList, undefined);
    expect(resolved.ok).toBe(false);
    expect(resolveMcpSession(toolsList, "")).toMatchObject({ ok: false });
    expect(resolveMcpSession({ jsonrpc: "2.0", method: "notifications/initialized" }, undefined))
      .toMatchObject({ ok: false });
  });

  test("rejects ids outside visible ASCII or over 128 characters", () => {
    for (const id of ["has space", "tab\there", "ünïcode", "a".repeat(129)]) {
      expect(resolveMcpSession(toolsList, id)).toMatchObject({ ok: false });
    }
    expect(resolveMcpSession(toolsList, "a".repeat(128))).toMatchObject({ ok: true });
  });
});
