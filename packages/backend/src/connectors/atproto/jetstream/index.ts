/**
 * Bluesky Jetstream ingestion: the handler registry and the consumer's
 * lifecycle. Started and stopped with the scheduler leadership
 * (`runtime/schedulers.ts`), so exactly one task in the fleet holds the
 * subscription — the combined API task today, the dedicated worker once the
 * fleet is split (`MENTION_PROCESS_ROLE`), with no change here.
 *
 * ## Adding a collection
 *
 * Write a {@link JetstreamCollectionHandler} for it and add it to
 * {@link jetstreamHandlers}. That is the whole extension point: the consumer
 * subscribes to every listed collection, batches its commits, retries a batch
 * whose handler threw, and only advances the shared cursor past handled work.
 * A handler receives every commit of its collection from every account and
 * filters itself, idempotently on `commit.uri` (delivery is at-least-once).
 * `deleteStoredAtprotoRecords` (`postHandler.ts`) removes a stored post or boost
 * by its record's AT-URI, for a handler whose deletes mean that.
 */

import { config } from '../../../config';
import {
  readJetstreamCursor,
  writeJetstreamCursor,
} from '../../../db/federation/jetstreamCursorRepository';
import { logger } from '../../../utils/logger';
import {
  JetstreamConsumer,
  type JetstreamCollectionHandler,
  type JetstreamCursorStore,
} from './JetstreamConsumer';
import {
  createFollowJetstreamHandler,
  createKnownBlueskyAccounts,
  createLikeJetstreamHandler,
  createRepostJetstreamHandler,
} from './engagementHandlers';
import { createPostJetstreamHandler } from './postHandler';

export type { JetstreamCollectionHandler } from './JetstreamConsumer';
export type { JetstreamCommit } from './protocol';

/** The `jetstream_cursors` row this consumer resumes from. */
const STREAM_NAME = 'bluesky';

/**
 * Every collection the consumer reads, one handler each. Posts first, so a
 * like or repost of a post created in the same batch finds it stored.
 */
export function jetstreamHandlers(): JetstreamCollectionHandler[] {
  const known = createKnownBlueskyAccounts();
  return [
    createPostJetstreamHandler(),
    createLikeJetstreamHandler(known),
    createRepostJetstreamHandler(known),
    createFollowJetstreamHandler(known),
  ];
}

/** The cursor, stored as text in `jetstream_cursors`. */
const cursorStore: JetstreamCursorStore = {
  async read() {
    const saved = await readJetstreamCursor(STREAM_NAME);
    const cursor = saved === null ? Number.NaN : Number(saved);
    return Number.isSafeInteger(cursor) && cursor > 0 ? cursor : undefined;
  },
  write: (cursor) => writeJetstreamCursor(STREAM_NAME, String(cursor)),
};

let consumer: JetstreamConsumer | undefined;

/** Open the subscription (leader only). A no-op when the connector or the stream is off. */
export function startJetstreamIngestion(): void {
  if (!config.atproto.jetstream.enabled) {
    logger.info('[jetstream] disabled — not subscribing');
    return;
  }
  if (consumer) return;
  consumer = new JetstreamConsumer({
    endpoints: config.atproto.jetstream.urls,
    handlers: jetstreamHandlers(),
    cursors: cursorStore,
  });
  const starting = consumer;
  starting.start().catch((err) => {
    // The next leadership acquisition tries again.
    if (consumer === starting) consumer = undefined;
    logger.error('[jetstream] failed to start:', err);
  });
}

/** Close the subscription and save how far it got (leadership lost, or shutdown). */
export async function stopJetstreamIngestion(): Promise<void> {
  const running = consumer;
  consumer = undefined;
  await running?.stop();
}
