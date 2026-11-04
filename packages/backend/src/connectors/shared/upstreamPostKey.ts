import { qualified } from '@oxy.so/db';
import { eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { postSourceKeys } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import { mirrorPostKey } from '../../utils/federation/mirrorTransports';
import { atUriFromBridgyObjectUri } from '../activitypub/bridgy';
import { AT_URI_RE, ANY_DID_RE } from '../atproto/constants';

/**
 * ONE UPSTREAM POST, SEVERAL TRANSPORTS — AND THE KEY THAT MAKES THEM MEET.
 *
 * A person on another network reaches Mention through every transport that
 * carries them: an X account through bird.makeup (and mastox.eu), an Instagram
 * account through kilogram.makeup and Meta's Graph API, a Bluesky account
 * natively over atproto and through Bridgy Fed. Each transport names a post its
 * own way, so the object id alone stores one post once per transport.
 *
 * The upstream post key is the network's OWN id for the post, read off the
 * transport's object id wherever the transport embeds it:
 *
 *   `x:<tweet id>`              bird.makeup `…/users/<h>/statuses/<tweet id>`
 *   `instagram:<shortcode>`     kilogram.makeup `…/statuses/<shortcode>`, and the
 *                               Graph import's own activity id
 *   `bluesky:<at-uri>`          a native atproto post, and Bridgy Fed's
 *                               `https://bsky.brid.gy/convert/ap/<at-uri>`
 *
 * Every write of a federated post stores its key in `post_source_keys`, whose
 * `source_key` is UNIQUE, in the same transaction as the post: whichever
 * transport arrives second collides instead of duplicating, and every "is this
 * object already here?" gate ({@link postMatchesFederatedObjectSql},
 * {@link findPostsByFederatedObjects}) finds the first transport's row by key.
 *
 * A transport whose ids are its own (mastox.eu) yields no key. What that means
 * for its posts is `connectors/activitypub/transportHandoff.ts`.
 */

const BLUESKY_KEY_PREFIX = 'bluesky:';

/** The upstream post key of a federated object id, or undefined when it names none. */
export function upstreamPostKey(objectUri: string | null | undefined): string | undefined {
  if (!objectUri) return undefined;
  if (objectUri.startsWith('at://')) return blueskyKey(objectUri);
  if (objectUri.startsWith('https://bsky.brid.gy/')) {
    const atUri = atUriFromBridgyObjectUri(objectUri);
    return atUri ? blueskyKey(atUri) : undefined;
  }
  return mirrorPostKey(objectUri) ?? graphImportKey(objectUri);
}

/** A record at-URI under a DID authority; a handle authority is not stable enough to be a key. */
function blueskyKey(atUri: string): string | undefined {
  const match = AT_URI_RE.exec(atUri);
  if (!match || !ANY_DID_RE.test(match[1]) || !match[2] || !match[3]) return undefined;
  return `${BLUESKY_KEY_PREFIX}${atUri}`;
}

/** The Instagram Graph import stores its post under its key (`instagram:<shortcode>`). */
function graphImportKey(objectUri: string): string | undefined {
  return /^instagram:[A-Za-z0-9_-]{5,64}$/.test(objectUri) ? objectUri : undefined;
}

/**
 * "The stored post that IS this federated object": its own activity id, or the
 * post holding its upstream key — the same upstream post stored from another
 * transport. Every single-object "is this already here?" gate uses this.
 */
export function postMatchesFederatedObjectSql(objectUri: string): SQL {
  const sourceKey = upstreamPostKey(objectUri);
  const byActivityId = eq(posts.federationActivityId, objectUri);
  return sourceKey ? (or(byActivityId, postIsSourceKeySql(sourceKey)) as SQL) : byActivityId;
}

/**
 * "This post is the one holding source key `sourceKey`".
 *
 * An UNCORRELATED scalar subquery, on purpose. The obvious spelling — a
 * correlated `exists (… post_id = posts.id …)` — cannot be driven by any index
 * on `posts` inside the `or` above, so every keyed object turned the inbox
 * dedupe, Delete, Update and object resolution into a sequential scan of
 * `posts` (it stayed one even with `enable_seqscan = off`). This form is
 * evaluated ONCE (an InitPlan through `post_source_keys_source_key_key`), and
 * the `or` becomes a BitmapOr of the activity-id index and the primary key.
 * `source_key` is UNIQUE, so the subquery yields at most one row; a claim
 * (NULL `post_id`) matches nothing.
 */
export function postIsSourceKeySql(sourceKey: string): SQL {
  return sql`${qualified(posts.id)} = (
    select ${qualified(postSourceKeys.postId)} from ${postSourceKeys}
    where ${qualified(postSourceKeys.sourceKey)} = ${sourceKey}
  )`;
}

/** A stored post as the batch lookup returns it. */
export interface FederatedObjectPost {
  id: string;
  threadId: string | null;
  /** The stored post's own activity id: another URI when it was matched by key. */
  activityId: string | null;
}

/**
 * The stored post for each of `objectUris`, by its activity id or its upstream
 * key — the batch form of {@link postMatchesFederatedObjectSql}. A URI with no
 * stored post is absent from the map. One query.
 */
export async function findPostsByFederatedObjects(
  objectUris: readonly string[],
): Promise<Map<string, FederatedObjectPost>> {
  const found = new Map<string, FederatedObjectPost>();
  const uris = [...new Set(objectUris.filter((uri) => uri.length > 0))];
  if (uris.length === 0) return found;
  const keyOf = new Map(
    uris.flatMap((uri) => {
      const key = upstreamPostKey(uri);
      return key ? [[uri, key] as const] : [];
    }),
  );
  const keys = [...new Set(keyOf.values())];
  const rows = await getDb()
    .select({
      id: posts.id,
      threadId: posts.threadId,
      activityId: posts.federationActivityId,
      sourceKey: postSourceKeys.sourceKey,
    })
    .from(posts)
    .leftJoin(postSourceKeys, eq(postSourceKeys.postId, posts.id))
    .where(
      keys.length > 0
        ? or(
            inArray(posts.federationActivityId, uris),
            inArray(
              posts.id,
              getDb()
                .select({ postId: postSourceKeys.postId })
                .from(postSourceKeys)
                .where(inArray(postSourceKeys.sourceKey, keys)),
            ),
          )
        : inArray(posts.federationActivityId, uris),
    );
  for (const uri of uris) {
    const key = keyOf.get(uri);
    const row =
      rows.find((candidate) => candidate.activityId === uri) ??
      (key ? rows.find((candidate) => candidate.sourceKey === key) : undefined);
    if (row) found.set(uri, { id: row.id, threadId: row.threadId, activityId: row.activityId });
  }
  return found;
}
