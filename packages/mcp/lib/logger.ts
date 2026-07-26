type LogLevel = "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const TRUNCATED = "[Truncated]";
const MAX_DEPTH = 5;
const MAX_KEYS = 50;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 2_000;
const ACCESSOR = "[Accessor]";
const BINARY = "[Binary]";
const UNSERIALIZABLE = "[Unserializable]";

const SAFE_SCALAR_KEYS = new Set([
  "activesessions",
  "cleanedsessions",
  "count",
  "durationms",
  "kind",
  "method",
  "requestid",
  "result",
  "route",
  "signal",
  "status",
  "statuscode",
  "total",
  "transport",
  "type",
]);

const SENSITIVE_KEYS = new Set([
  "authorization",
  "body",
  "content",
  "cookie",
  "email",
  "errorbody",
  "handle",
  "headers",
  "params",
  "password",
  "privatekey",
  "query",
  "secret",
  "setcookie",
  "text",
  "token",
  "username",
]);

function normalizedKey(key: string): string {
  return key.replace(/[-_.]/g, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SAFE_SCALAR_KEYS.has(normalized)) return false;
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith("id") ||
    normalized.endsWith("ids") ||
    normalized.endsWith("uri") ||
    normalized.endsWith("uris") ||
    normalized.endsWith("url") ||
    normalized.endsWith("urls") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("apikey")
  );
}

function sanitizeString(value: string): string {
  const sanitized = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b(?:https?|wss?|redis|rediss|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi, REDACTED)
    .replace(/\b(?:did|acct):[^\s,;)\]]+/gi, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/(^|[\s([{"'])@[A-Z0-9_][A-Z0-9_.-]*/gi, `$1${REDACTED}`)
    .replace(/\b[0-9a-f]{24}\b/gi, REDACTED)
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      REDACTED,
    )
    .replace(
      /\b(?:\d{1,3}\.){3}\d{1,3}\b|(?<![A-Za-z0-9:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![A-Za-z0-9:])/gi,
      REDACTED,
    );
  if (sanitized.length <= MAX_STRING_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_STRING_LENGTH)}…${TRUNCATED}`;
}

function sanitizeInternal(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  preserveRequestId = false,
): unknown {
  if (typeof value === "string") {
    return preserveRequestId
      ? value.slice(0, MAX_STRING_LENGTH)
      : sanitizeString(value);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (depth >= MAX_DEPTH) return TRUNCATED;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  if (value instanceof Error) {
    const error: Record<string, unknown> = {
      name: sanitizeString(value.name),
      message: sanitizeString(value.message),
    };
    const withCode = value as Error & { code?: unknown; cause?: unknown };
    if (typeof withCode.code === "string" || typeof withCode.code === "number") {
      error.code = withCode.code;
    }
    if (withCode.cause !== undefined) {
      error.cause = sanitizeInternal(withCode.cause, depth + 1, seen);
    }
    return error;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (
    value instanceof ArrayBuffer ||
    (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(value))
  ) {
    return BINARY;
  }
  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeInternal(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) result.push(TRUNCATED);
    return result;
  }

  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return UNSERIALIZABLE;
  }

  const result: Record<string, unknown> = {};
  const keys = Object.keys(descriptors);
  for (const key of keys.slice(0, MAX_KEYS)) {
    const normalized = normalizedKey(key);
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
      continue;
    }
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) {
      result[key] = ACCESSOR;
      continue;
    }
    result[key] = sanitizeInternal(
      descriptor.value,
      depth + 1,
      seen,
      normalized === "requestid",
    );
  }
  if (keys.length > MAX_KEYS) result.__truncated__ = true;
  return result;
}

/** Convert arbitrary MCP log metadata into a bounded, JSON-safe value. */
export function sanitizeLogValue(value: unknown): unknown {
  try {
    return sanitizeInternal(value, 0, new WeakSet<object>());
  } catch {
    return UNSERIALIZABLE;
  }
}

export function logInfo(message: string, fields: LogFields = {}): void {
  writeLog("info", message, fields);
}

export function logWarn(message: string, fields: LogFields = {}): void {
  writeLog("warn", message, fields);
}

export function logError(
  message: string,
  error?: unknown,
  fields: LogFields = {},
): void {
  writeLog("error", message, {
    ...fields,
    ...(error === undefined ? {} : { error: serializeError(error) }),
  });
}

function writeLog(level: LogLevel, message: string, fields: LogFields): void {
  const safeFields = sanitizeLogValue(fields) as LogFields;
  const line = JSON.stringify({
    ...safeFields,
    timestamp: new Date().toISOString(),
    level,
    service: "mention-mcp",
    message: sanitizeString(message),
  });

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function serializeError(error: unknown): { name: string; message: string } {
  const sanitized = sanitizeLogValue(error);
  if (
    sanitized &&
    typeof sanitized === "object" &&
    "name" in sanitized &&
    "message" in sanitized
  ) {
    return sanitized as { name: string; message: string };
  }
  return { name: "UnknownError", message: sanitizeString(String(error)) };
}
