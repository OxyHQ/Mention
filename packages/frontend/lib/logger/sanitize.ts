import type { Metadata, Serializable, TransportEntry } from './types'

export const REDACTED = '[REDACTED]'
export const CIRCULAR = '[Circular]'
export const MAX_DEPTH_REACHED = '[MaxDepth]'
export const TRUNCATED = '[Truncated]'

const MAX_DEPTH = 5
const MAX_KEYS = 40
const MAX_ARRAY_ITEMS = 25
const MAX_STRING_LENGTH = 1_000
const MAX_KEY_LENGTH = 120
const MAX_NODES = 500

const OPERATIONAL_KEY_RE =
  /^(?:count|status|statuscode|type|kind|duration|durationms|result)$/i
const CONTENT_KEY_RE =
  /^(?:body|query|params|content|text)$|(?:Body|Query|Params|Content|Text)$|(?:_|-|\.)(?:body|query|params|content|text)$/i
const CREDENTIAL_KEY_RE =
  /^(?:token|tokens|authorization|auth|cookie|cookies|setcookie|secret|secrets|password|passwords|passwd|passcode|passcodes|apikey|clientsecret)$|(?:Token|Tokens|Authorization|Cookie|Cookies|Secret|Secrets|Password|Passwords|Passcode|Passcodes|ApiKey|APIKey|ClientSecret)$|(?:_|-|\.)(?:tokens?|authorization|auth|cookies?|secrets?|passwords?|passcodes?|api_?key|client_?secret)$/i
const IDENTITY_KEY_RE =
  /^(?:email|emails|username|usernames|handle|handles)$|(?:Email|Emails|Username|Usernames|Handle|Handles)$|(?:_|-|\.)(?:emails?|usernames?|handles?)$/i
const IDENTIFIER_KEY_RE =
  /^(?:id|ids|uri|uris|url|urls|ip|ips|ipaddress|remoteaddress|forwardedfor)$|(?:Id|ID|Ids|IDs|Uri|URI|Uris|URIs|Url|URL|Urls|URLs|Ip|IP|Ips|IPs|IpAddress|IPAddress|RemoteAddress|ForwardedFor)$|(?:_|-|\.)(?:id|ids|uri|uris|url|urls|ip|ips|ip_address|remote_address|forwarded_for)$/i

const URL_RE = /\b(?:https?|wss?):\/\/[^\s<>"')\]]+/gi
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const IPV4_RE =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
const IPV6_RE =
  /(?:^|[\s[(])(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{0,4}(?=$|[\s)\],])/gi
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
const OBJECT_ID_RE = /\b[0-9a-f]{24}\b/gi
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const CREDENTIAL_ASSIGNMENT_RE =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|secret|password|passcode|api[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi
const HANDLE_RE =
  /(^|[\s([{"'])@[a-z0-9](?:[a-z0-9._-]{0,62})(?:@[a-z0-9.-]+)?\b/gi

const OMIT = Symbol('omit')

type SanitizedValue = Serializable | typeof OMIT

type SanitizeState = {
  seen: WeakSet<object>
  remainingNodes: number
}

function truncate(value: string, maxLength = MAX_STRING_LENGTH): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}…${TRUNCATED}`
}

/**
 * Scrub secrets and common personal identifiers that may be interpolated into
 * otherwise useful operational messages.
 */
export function sanitizeLogString(value: string): string {
  const scrubbed = value
    .replace(BEARER_RE, REDACTED)
    .replace(CREDENTIAL_ASSIGNMENT_RE, (_match, label: string) => `${label}=${REDACTED}`)
    .replace(URL_RE, REDACTED)
    .replace(EMAIL_RE, REDACTED)
    .replace(IPV4_RE, REDACTED)
    .replace(IPV6_RE, (match) => `${match[0]?.trim() ? match[0] : ''}${REDACTED}`)
    .replace(UUID_RE, REDACTED)
    .replace(OBJECT_ID_RE, REDACTED)
    .replace(HANDLE_RE, (_match, prefix: string) => `${prefix}${REDACTED}`)

  return truncate(scrubbed)
}

function isSensitiveKey(key: string): boolean {
  if (OPERATIONAL_KEY_RE.test(key)) return false
  return (
    CONTENT_KEY_RE.test(key) ||
    CREDENTIAL_KEY_RE.test(key) ||
    IDENTITY_KEY_RE.test(key) ||
    IDENTIFIER_KEY_RE.test(key)
  )
}

function sanitizeKey(key: string, index: number): string {
  const bounded = truncate(key, MAX_KEY_LENGTH)
  if (bounded !== sanitizeLogString(bounded)) {
    return `[REDACTED_KEY_${index + 1}]`
  }
  return bounded
}

function sanitizeError(error: Error): Record<string, Serializable> {
  const result: Record<string, Serializable> = {
    name: sanitizeLogString(error.name || 'Error'),
    message: sanitizeLogString(error.message || ''),
  }
  if (error.stack) {
    result.stack = sanitizeLogString(error.stack)
  }
  return result
}

function sanitizeObject(
  value: object,
  depth: number,
  state: SanitizeState,
): Serializable {
  if (state.seen.has(value)) return CIRCULAR
  if (depth >= MAX_DEPTH) return MAX_DEPTH_REACHED
  if (state.remainingNodes <= 0) return TRUNCATED

  state.seen.add(value)
  state.remainingNodes -= 1

  if (value instanceof Error) {
    return sanitizeError(value)
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  }
  if (value instanceof RegExp) {
    return truncate(value.toString())
  }
  if (
    value instanceof ArrayBuffer ||
    (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value))
  ) {
    return '[Binary]'
  }

  if (Array.isArray(value)) {
    const result: Serializable[] = []
    const itemCount = Math.min(value.length, MAX_ARRAY_ITEMS)
    for (let index = 0; index < itemCount; index += 1) {
      const item = sanitizeValue(value[index], depth + 1, state)
      result.push(item === OMIT ? null : item)
    }
    if (value.length > MAX_ARRAY_ITEMS) result.push(TRUNCATED)
    return result
  }

  let descriptors: Record<string, PropertyDescriptor>
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    return '[Unserializable]'
  }

  const keys = Object.keys(descriptors)
  const result: Record<string, Serializable> = {}
  const keyCount = Math.min(keys.length, MAX_KEYS)

  for (let index = 0; index < keyCount; index += 1) {
    const key = keys[index]
    const outputKey = sanitizeKey(key, index)
    if (isSensitiveKey(key)) {
      result[outputKey] = REDACTED
      continue
    }

    const descriptor = descriptors[key]
    if (!('value' in descriptor)) {
      result[outputKey] = '[Accessor]'
      continue
    }

    const sanitized = sanitizeValue(descriptor.value, depth + 1, state)
    if (sanitized !== OMIT) result[outputKey] = sanitized
  }

  if (keys.length > MAX_KEYS) {
    result.__truncated_keys__ = keys.length - MAX_KEYS
  }
  return result
}

function sanitizeValue(
  value: unknown,
  depth: number,
  state: SanitizeState,
): SanitizedValue {
  if (value === undefined) return OMIT
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return sanitizeLogString(value)
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol' || typeof value === 'function') {
    return '[Unsupported]'
  }
  return sanitizeObject(value as object, depth, state)
}

export function sanitizeLogMetadata(
  metadata: Metadata | Record<string, unknown>,
): Metadata {
  const state: SanitizeState = {
    seen: new WeakSet<object>(),
    remainingNodes: MAX_NODES,
  }
  const sanitized = sanitizeObject(metadata, 0, state)
  return (
    typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)
      ? sanitized
      : {}
  ) as Metadata
}

export function sanitizeLogMessage(message: string | Error): string {
  if (message instanceof Error) {
    return sanitizeLogString(
      message.stack || `${message.name || 'Error'}: ${message.message || ''}`,
    )
  }
  return sanitizeLogString(String(message))
}

export function sanitizeTransportEntry(entry: TransportEntry): TransportEntry {
  return {
    level: entry.level,
    context: entry.context
      ? truncate(sanitizeLogString(entry.context), MAX_KEY_LENGTH)
      : undefined,
    message: sanitizeLogMessage(entry.message),
    metadata: sanitizeLogMetadata(entry.metadata),
    timestamp: entry.timestamp,
  }
}
