import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  logError,
  logInfo,
  sanitizeLogValue,
} from "../lib/logger.js";

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

afterEach(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

describe("structured MCP logger", () => {
  test("recursively redacts identity, payload and credential fields", () => {
    const circular: Record<string, unknown> = {
      authorization: "Bearer top.secret.value",
      body: { text: "private post" },
      actorId: "507f1f77bcf86cd799439011",
      nested: {
        email: "person@example.com",
        endpointUrl: "https://example.com/?token=secret",
      },
    };
    circular.self = circular;

    expect(sanitizeLogValue(circular)).toEqual({
      authorization: "[REDACTED]",
      body: "[REDACTED]",
      actorId: "[REDACTED]",
      nested: {
        email: "[REDACTED]",
        endpointUrl: "[REDACTED]",
      },
      self: "[Circular]",
    });
  });

  test("does not invoke accessors and safely handles invalid or binary values", () => {
    let getterRead = false;
    const hostile = Object.defineProperty({}, "computed", {
      enumerable: true,
      get() {
        getterRead = true;
        return "private";
      },
    });

    expect(sanitizeLogValue({
      hostile,
      invalidDate: new Date(Number.NaN),
      bytes: new Uint8Array([1, 2, 3]),
    })).toEqual({
      hostile: { computed: "[Accessor]" },
      invalidDate: "Invalid Date",
      bytes: "[Binary]",
    });
    expect(getterRead).toBe(false);
  });

  test("preserves bounded operational dimensions and prevents envelope overrides", () => {
    const output = mock(() => undefined);
    console.log = output;
    const requestId = "39ed6275-b778-4d49-991f-e08c542b74fb";

    logInfo("Request completed", {
      requestId,
      route: "/mcp",
      statusCode: 200,
      durationMs: 12.5,
      service: "spoofed-service",
      level: "error",
      message: "spoofed-message",
    });

    const entry = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(entry).toMatchObject({
      requestId,
      route: "/mcp",
      statusCode: 200,
      durationMs: 12.5,
      service: "mention-mcp",
      level: "info",
      message: "Request completed",
    });
  });

  test("sanitizes values in operational fields except the opaque request ID", () => {
    const requestId = "39ed6275-b778-4d49-991f-e08c542b74fb";
    expect(sanitizeLogValue({
      requestId,
      route: "https://private.example/users/507f1f77bcf86cd799439011",
      result: "sent to person@example.com",
    })).toEqual({
      requestId,
      route: "[REDACTED]",
      result: "sent to [REDACTED]",
    });
  });

  test("sanitizes identifiers and tokens embedded in error messages", () => {
    const output = mock(() => undefined);
    console.error = output;

    logError(
      "Request failed for 507f1f77bcf86cd799439011",
      new Error(
        "Bearer abc.def.ghi from 203.0.113.8 for person@example.com",
      ),
    );

    const serialized = String(output.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("507f1f77bcf86cd799439011");
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("203.0.113.8");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).toContain("[REDACTED]");
  });
});
