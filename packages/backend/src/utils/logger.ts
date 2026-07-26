import pino from 'pino';
import { isIP } from 'node:net';
import { config } from '../config';

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const TRUNCATED = '[Truncated]';
const UNSERIALIZABLE = '[Unserializable]';
const FUNCTION = '[Function]';
const ACCESSOR = '[Accessor]';
const INVALID_DATE = '[Invalid Date]';
const MAX_LOG_DEPTH = 5;
const MAX_LOG_KEYS = 50;
const MAX_LOG_ARRAY_ITEMS = 20;
const MAX_LOG_STRING_LENGTH = 2_000;

const PRESERVED_KEYS = new Set([
  'requestid',
  'route',
  'routetemplate',
  'duration',
  'durationms',
  'result',
  'status',
  'statuscode',
  'type',
  'kind',
  'count',
  'total',
]);

const SENSITIVE_EXACT_KEYS = new Set([
  'authorization',
  'body',
  'clientip',
  'connectionstring',
  'content',
  'cookie',
  'credential',
  'credentials',
  'database',
  'databasename',
  'dbname',
  'email',
  'handle',
  'host',
  'hostname',
  'ip',
  'ipaddress',
  'mongouri',
  'params',
  'password',
  'path',
  'pathname',
  'privatekey',
  'query',
  'redisurl',
  'remoteaddress',
  'secret',
  'session',
  'signature',
  'set-cookie',
  'text',
  'token',
  'username',
]);

function normalizeKey(key: string): string {
  return key.replace(/[-_.]/g, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (PRESERVED_KEYS.has(normalized)) return false;
  if (SENSITIVE_EXACT_KEYS.has(normalized)) return true;
  return (
    normalized.endsWith('id')
    || normalized.endsWith('ids')
    || normalized.endsWith('uri')
    || normalized.endsWith('uris')
    || normalized.endsWith('url')
    || normalized.endsWith('urls')
    || normalized.endsWith('ipaddress')
    || normalized.endsWith('handle')
    || normalized.endsWith('username')
    || normalized.endsWith('email')
    || normalized.endsWith('password')
    || normalized.endsWith('secret')
    || normalized.endsWith('token')
    || normalized.endsWith('credential')
    || normalized.endsWith('credentials')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('apikey')
    || normalized.endsWith('accesskey')
    || normalized.endsWith('sessionid')
    || normalized.endsWith('signature')
  );
}

function sanitizeLogString(
  value: string,
  preserveBareIdentifier = false,
): string {
  const sanitized = value
    .replace(
      /\b(?:https?|wss?|at|redis|rediss|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,
      (match) => {
        const trailing = match.match(/[),.;!?]+$/)?.[0] ?? '';
        const candidate = trailing ? match.slice(0, -trailing.length) : match;
        try {
          const parsed = new URL(candidate);
          if (
            parsed.protocol.startsWith('mongodb')
            || parsed.protocol.startsWith('redis')
            || parsed.username
            || parsed.password
          ) {
            return `${REDACTED}${trailing}`;
          }
          const host =
            /^(?:\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname)
            || parsed.hostname.includes(':')
              ? REDACTED
              : parsed.host;
          return `${parsed.protocol}//${host}/[REDACTED]${trailing}`;
        } catch {
          return `${REDACTED}${trailing}`;
        }
      },
    )
    .replace(/\b(?:did|acct):[^\s,;)\]]+/gi, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/@[A-Z0-9_][A-Z0-9_.-]*@[A-Z0-9.-]+/gi, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/(^|[\s(])@[A-Z0-9_][A-Z0-9_.-]*/gi, `$1${REDACTED}`)
    .replace(
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
      REDACTED,
    )
    .replace(/(?<![A-Z0-9:])\[?[A-F0-9:]{2,}\]?(?![A-Z0-9:])/gi, (candidate) => {
      const unwrapped = candidate.replace(/^\[/, '').replace(/\]$/, '');
      return isIP(unwrapped) === 6 ? REDACTED : candidate;
    })
    .replace(
      /\b((?:user|post|feed|label|actor|target|author|node|poll|thread|boost|notification|report|entity|oxy)[A-Za-z]*(?:Id|Ids|Uri)|handle|username|email)\s*[=:]\s*[^\s,;)\]]+/gi,
      `$1=${REDACTED}`,
    );
  const identifiersRedacted = preserveBareIdentifier
    ? sanitized
    : sanitized
      .replace(/\b[a-f0-9]{24}\b/gi, REDACTED)
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
        REDACTED,
      )
      .replace(/\boxy[-_:][A-Za-z0-9][A-Za-z0-9._:-]{2,}\b/gi, REDACTED);
  if (identifiersRedacted.length <= MAX_LOG_STRING_LENGTH) {
    return identifiersRedacted;
  }
  return `${identifiersRedacted.slice(0, MAX_LOG_STRING_LENGTH)}…${TRUNCATED}`;
}

function sanitizeError(
  error: Error,
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(error);
  const dataValue = (key: string): unknown => {
    const descriptor = descriptors[key];
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const name = dataValue('name');
  const message = dataValue('message');
  const stack = dataValue('stack');
  const safe: Record<string, unknown> = {
    name: sanitizeLogString(typeof name === 'string' ? name : 'Error'),
    message: sanitizeLogString(typeof message === 'string' ? message : ''),
  };
  if (typeof stack === 'string' && stack) {
    safe.stack = sanitizeLogString(stack);
  }
  const code = dataValue('code');
  if (
    typeof code === 'string'
    || typeof code === 'number'
  ) {
    safe.code = typeof code === 'string' ? sanitizeLogString(code) : code;
  }
  const cause = dataValue('cause');
  if (cause !== undefined && depth < MAX_LOG_DEPTH) {
    safe.cause = sanitizeLogValueInternal(cause, depth + 1, seen);
  }
  return safe;
}

function sanitizeLogValueInternal(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return sanitizeLogString(value);
  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return sanitizeLogString(String(value));
  if (typeof value === 'function') return FUNCTION;
  if (depth >= MAX_LOG_DEPTH) return TRUNCATED;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  if (value instanceof Error) {
    return sanitizeError(value, depth, seen);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? INVALID_DATE : value.toISOString();
  }
  if (Array.isArray(value)) {
    const safe = value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((item) => sanitizeLogValueInternal(item, depth + 1, seen));
    if (value.length > MAX_LOG_ARRAY_ITEMS) safe.push(TRUNCATED);
    return safe;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value))
    .filter(([, descriptor]) => descriptor.enumerable);
  for (const [key, nested] of entries.slice(0, MAX_LOG_KEYS)) {
    const normalized = normalizeKey(key);
    if (isSensitiveKey(key)) {
      output[key] = REDACTED;
    } else if (!('value' in nested)) {
      output[key] = ACCESSOR;
    } else if (normalized === 'requestid' && typeof nested.value === 'string') {
      output[key] = sanitizeLogString(nested.value, true);
    } else {
      output[key] = sanitizeLogValueInternal(nested.value, depth + 1, seen);
    }
  }
  if (entries.length > MAX_LOG_KEYS) output.__truncated__ = true;
  return output;
}

/**
 * Convert arbitrary log metadata into a bounded, JSON-safe value.
 *
 * Request correlation fields and normalized operational dimensions remain
 * visible. Identity, request payload, content and credential fields are always
 * redacted, including when nested inside arrays or error causes.
 */
export function sanitizeLogValue(value: unknown): unknown {
  try {
    return sanitizeLogValueInternal(value, 0, new WeakSet<object>());
  } catch {
    return UNSERIALIZABLE;
  }
}

const pinoLogger = pino({
  level: config.logging.level,
  ...(config.runtime.isProduction
    ? {
        // JSON output in production for log aggregation
        formatters: {
          level: (label: string) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }
    : {
        // Pretty print in development
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),
});

interface LoggerFunction {
  (message: string, ...args: unknown[]): void;
}

interface Logger {
  info: LoggerFunction;
  warn: LoggerFunction;
  error: (message: string, error?: unknown) => void;
  debug: LoggerFunction;
}

/** Fold variadic log args into a single pino-mergeable object. */
function mergeLogArgs(args: unknown[]): Record<string, unknown> {
  const first = args[0];
  if (args.length === 1 && first !== null && typeof first === 'object') {
    const sanitized = sanitizeLogValue(first);
    if (
      sanitized !== null
      && typeof sanitized === 'object'
      && !Array.isArray(sanitized)
    ) {
      return sanitized as Record<string, unknown>;
    }
    return { data: sanitized };
  }
  return { data: sanitizeLogValue(args) };
}

export const logger: Logger = {
  info: (message: string, ...args: unknown[]) => {
    if (args.length > 0) {
      pinoLogger.info(mergeLogArgs(args), sanitizeLogString(message));
    } else {
      pinoLogger.info(sanitizeLogString(message));
    }
  },
  error: (message: string, error?: unknown) => {
    if (error instanceof Error) {
      pinoLogger.error(
        { err: sanitizeLogValue(error) },
        sanitizeLogString(message),
      );
    } else if (error) {
      pinoLogger.error(mergeLogArgs([error]), sanitizeLogString(message));
    } else {
      pinoLogger.error(sanitizeLogString(message));
    }
  },
  warn: (message: string, ...args: unknown[]) => {
    if (args.length > 0) {
      pinoLogger.warn(mergeLogArgs(args), sanitizeLogString(message));
    } else {
      pinoLogger.warn(sanitizeLogString(message));
    }
  },
  debug: (message: string, ...args: unknown[]) => {
    if (args.length > 0) {
      pinoLogger.debug(mergeLogArgs(args), sanitizeLogString(message));
    } else {
      pinoLogger.debug(sanitizeLogString(message));
    }
  },
};
