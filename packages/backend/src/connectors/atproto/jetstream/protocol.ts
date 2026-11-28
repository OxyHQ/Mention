/**
 * The Jetstream v2 wire protocol, as much of it as the consumer reads.
 *
 * `GET wss://<host>/xrpc/network.bsky.jetstream.subscribeEvents` with repeated
 * `collections` and `kinds` parameters and an optional `cursor`. Every text frame
 * is one JSON object:
 *
 *   {"$type":"message","payload":{"$type":"network.bsky.jetstream.subscribeEvents#commit",
 *     "did","seq","time","witnessedAt","rev","operation","collection","rkey","record"?,"cid"?}}
 *   {"$type":"message","payload":{"$type":"…#info","name":"OutdatedCursor","message"}}
 *   {"$type":"error","error":"ConsumerTooSlow","message"}
 *
 * The cursor is the event's `witnessedAt` as unix MICROseconds. Jetstream accepts
 * a value ≥ 1e15 as a timestamp and resumes at the first event witnessed at or
 * after it, so it is inclusive (the event is delivered again) and, unlike `seq`,
 * portable between Jetstream instances. Delivery is at-least-once either way, so
 * every handler is idempotent on the record's AT-URI.
 */

import { isRecord } from '@mention/shared-types';

/** The subscription endpoint's NSID. */
export const SUBSCRIBE_NSID = 'network.bsky.jetstream.subscribeEvents';

const COMMIT_TYPE = `${SUBSCRIBE_NSID}#commit`;
const INFO_TYPE = `${SUBSCRIBE_NSID}#info`;

/** One record mutation, as handlers receive it. */
export interface JetstreamCommit {
  /** The repository (account) the record lives in. */
  did: string;
  collection: string;
  rkey: string;
  operation: 'create' | 'update' | 'delete';
  /** The record, decoded. Absent on a delete. */
  record?: unknown;
  /** The record's CID. Absent on a delete. */
  cid?: string;
  /** `at://<did>/<collection>/<rkey>` — the key every handler dedupes on. */
  uri: string;
  /** Where to resume from to see this event again (unix µs). */
  cursor: number;
}

/** What one frame told the consumer. */
export type JetstreamFrame =
  | { kind: 'commit'; commit: JetstreamCommit }
  | { kind: 'info'; name: string; message?: string }
  | { kind: 'error'; error: string; message?: string }
  | { kind: 'ignored' };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * An RFC 3339 timestamp as unix microseconds. `Date` keeps milliseconds only,
 * so the sub-second digits are read from the string itself.
 */
export function timestampToMicros(value: string): number | undefined {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return undefined;
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  const micros = Number(fraction.slice(0, 6).padEnd(6, '0'));
  return Math.floor(millis / 1_000) * 1_000_000 + micros;
}

const OPERATIONS: ReadonlySet<string> = new Set(['create', 'update', 'delete']);

/** Parse one text frame. Anything malformed or not a commit we can place is `ignored`. */
export function parseFrame(text: string): JetstreamFrame {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return { kind: 'ignored' };
  }
  if (!isRecord(frame)) return { kind: 'ignored' };

  if (frame.$type === 'error') {
    return {
      kind: 'error',
      error: asString(frame.error) ?? 'unknown',
      message: asString(frame.message),
    };
  }

  const payload = frame.payload;
  if (frame.$type !== 'message' || !isRecord(payload)) return { kind: 'ignored' };
  if (payload.$type === INFO_TYPE) {
    return {
      kind: 'info',
      name: asString(payload.name) ?? 'unknown',
      message: asString(payload.message),
    };
  }
  if (payload.$type !== COMMIT_TYPE) return { kind: 'ignored' };

  const did = asString(payload.did);
  const collection = asString(payload.collection);
  const rkey = asString(payload.rkey);
  const operation = asString(payload.operation);
  const witnessed = asString(payload.witnessedAt) ?? asString(payload.time);
  const cursor = witnessed ? timestampToMicros(witnessed) : undefined;
  if (!did || !collection || !rkey || !operation || !OPERATIONS.has(operation) || !cursor) {
    return { kind: 'ignored' };
  }
  return {
    kind: 'commit',
    commit: {
      did,
      collection,
      rkey,
      operation: operation as JetstreamCommit['operation'],
      record: payload.record,
      cid: asString(payload.cid),
      uri: `at://${did}/${collection}/${rkey}`,
      cursor,
    },
  };
}

/** The subscription URL: commits of `collections`, from `cursor` when there is one. */
export function subscribeUrl(
  endpoint: string,
  collections: readonly string[],
  cursor?: number,
): string {
  const search = new URLSearchParams();
  search.append('kinds', 'commit');
  for (const collection of collections) search.append('collections', collection);
  if (cursor !== undefined) search.set('cursor', String(cursor));
  return `${endpoint}/xrpc/${SUBSCRIBE_NSID}?${search.toString()}`;
}
