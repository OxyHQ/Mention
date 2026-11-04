/**
 * One-shot repair: store federated direct messages as private mentions.
 *
 * WHY. Until private mentions existed, `mapApVisibility` stored any ActivityPub
 * note that was not publicly addressed as `followers_only` — direct messages
 * included — so a DM to a local user was readable by every local follower of
 * its sender and not by the person it was sent to. `hideFederatedDirectMessages`
 * (this script's first form) moved those to `private`, where only the sender
 * could read them: no longer leaked, but still not delivered.
 *
 * WHAT IT DOES. For every stored ActivityPub post that is `private` (hidden by
 * the first form) or still `followers_only`, it re-fetches the note from its
 * origin and asks the ingest rule (`resolveApAudienceExisting`) who it is for:
 *
 *  - a direct note addressed to at least one local user becomes `direct`, with
 *    its addressees as recipients — the same post a new delivery would store
 *    (no notification is sent for history);
 *  - a followers-addressed note stays `followers_only`;
 *  - a followers-only post whose note is direct to nobody here, is gone, or is
 *    refused to every actor below, moves to `private`, as the first form did;
 *  - a publicly addressed note becomes `public` again (`restoredPublic`): it
 *    was stored narrower only because the old rule misread `as:Public`, a
 *    single-value `to`/`cc` or an embedded `{ id }` addressee, and the origin's
 *    addressing is the source of truth;
 *  - a note whose origin failed (5xx, network) is left as it is, to retry;
 *  - anything else is left exactly as it is.
 *
 * WHO ASKS. Mastodon serves a followers-only note only to a signed request from
 * a follower of its author, and a direct note only to the actors it addresses.
 * The instance actor is neither, so a refusal (401/403/404) to the instance is
 * retried signed as up to {@link MAX_ACTOR_ATTEMPTS} local users entitled to
 * read it: first the local users the post mentions or is addressed to, then
 * local accounts that follow its author. Oxy signs for them; the key never
 * enters Mention. A 410 is final. A refusal to every one of them hides the post
 * (privacy first); not one of them answering is never a reason to publish it.
 *
 * WHOSE FOLLOWERS. Followers-only is told from direct by the author's followers
 * collection. An author stored without one (or not stored) may only be stale —
 * read before `@oxy.so/federation` 2.16.0 understood an embedded collection —
 * so before a non-public note is judged its author is re-read once per run
 * through the shared resolver (`authorFollowersUrl`, which honours the domain
 * policy). Still none after a successful re-read: decided as before. The re-read
 * failed: the post is left as it is and counted `actorUnresolved` — missing
 * author data never hides a post.
 *
 * Addressees resolve against stored identities only, never a fetch: a remote
 * addressee nobody here knows is not a reader here anyway. Nothing is deleted.
 *
 * DIAGNOSIS. A dry run also logs `addressing shapes`: per outcome, how many
 * fetched notes had each addressing shape (the form of `to`/`cc` and the class
 * of each addressee — public, the author's stored followers collection, another
 * followers-like collection, a local actor — whether the author's row has a
 * followers URL, and whether `attributedTo` is the stored actor), plus a few
 * samples naming only the origin host. No URL path, id or content is logged.
 *
 * SAFETY: `DRY_RUN` defaults to true and only counts; a write needs
 * `CONFIRM_ADMIN_MUTATION=recoverFederatedDirectMessages`. Idempotent: a
 * converted or hidden post no longer matches what it was converted from, every
 * write re-checks the visibility it read, and a re-run picks up `retryLater`.
 *
 *   bun packages/backend/dist/src/scripts/recoverFederatedDirectMessages.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=recoverFederatedDirectMessages \
 *     bun packages/backend/dist/src/scripts/recoverFederatedDirectMessages.js
 */

import { PostVisibility } from '@mention/shared-types';
import { ownProfileUrlHandle } from '@mention/shared-types/profileUrls';
import { apIriList } from '@oxy.so/federation';
import { and, asc, eq, gt, inArray, like } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postMentions, postRecipients } from '../db/schema/postContent';
import { federatedFollows } from '../db/schema/federation';
import { findActorByUri } from '../db/federation/actorRepository';
import { convertToDirectPost } from '../db/posts/postAudience';
import {
  extractActorUri,
  fetchActivityPubObjectAs,
  isApPublicAddressee,
  localActorKeyIdResolver,
} from '../connectors/activitypub/helpers';
import { OWN_DOMAINS } from '../connectors/activitypub/ownDomain';
import {
  authorFollowersUrl,
  resolveApAudienceExisting,
  type AuthorRefreshOptions,
} from '../connectors/activitypub/apMentions';
import { invalidate as invalidatePostDetailCache } from '../services/postDetailCache';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { mapWithConcurrency, DEFAULT_CONCURRENCY } from '../utils/concurrency';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'recoverFederatedDirectMessages';
const BATCH = 200;
/** Local users a refused note is retried as, beyond the instance. */
const MAX_ACTOR_ATTEMPTS = 3;

export interface RecoverDirectMessagesResult {
  /** Private and followers-only ActivityPub posts examined. */
  scanned: number;
  /** Direct notes to a local user: converted to `direct` (or would be, dry). */
  converted: number;
  /** Followers-addressed notes, left followers-only. */
  followersOnly: number;
  /** Followers-only posts that are not followers-addressed, gone or refused: moved to private. */
  hidden: number;
  /** Notes the origin addresses publicly: restored to public. */
  restoredPublic: number;
  /** Posts left as they are (still private, or no longer followers-only). */
  unchanged: number;
  /** Notes the instance was refused but a local user's signature fetched. */
  fetchedAsActor: number;
  /** Notes no attempt found (404/410). */
  gone: number;
  /** Notes refused (401/403) to the instance and every local user tried. */
  refused: number;
  /** Notes whose origin failed (5xx, network): left unchanged for a re-run. */
  retryLater: number;
  /** Notes whose author lacked a followers collection and could not be re-read: left unchanged. */
  actorUnresolved: number;
}

/** Shapes kept per outcome, and samples logged per outcome, on a dry run. */
const MAX_SHAPES_PER_OUTCOME = 20;
const MAX_SAMPLES_PER_OUTCOME = 3;

/**
 * A fetched note's addressing as classes only — never a URL, id or content —
 * so a dry run shows WHY notes land where they do.
 */
export function addressingShape(
  note: Record<string, unknown>,
  actorUri: string,
  followersUrl: string | undefined,
): string {
  const field = (value: unknown) => {
    if (value === undefined || value === null) return 'absent';
    const classes = new Set(
      apIriList(value).map((addressee) => {
        if (addressee === 'https://www.w3.org/ns/activitystreams#Public') return 'public';
        if (isApPublicAddressee(addressee)) return 'public-compact';
        if (followersUrl && addressee === followersUrl) return 'author-followers';
        if (/\/followers\/?$/.test(addressee)) return 'followers-like';
        if (addressee === actorUri) return 'author';
        if (ownProfileUrlHandle(addressee, OWN_DOMAINS)) return 'local-actor';
        return 'other';
      }),
    );
    const form = Array.isArray(value) ? 'array' : typeof value === 'string' ? 'single' : 'object';
    return `${form}[${[...classes].sort().join(',')}]`;
  };
  const attributedTo = extractActorUri(note.attributedTo);
  return [
    String(note.type ?? 'untyped'),
    `to=${field(note.to)}`,
    `cc=${field(note.cc)}`,
    `followersUrl=${followersUrl ? 'stored' : 'missing'}`,
    `attributedTo=${!attributedTo ? 'absent' : attributedTo === actorUri ? 'actor' : 'other'}`,
  ].join(' ');
}

type CandidateNote =
  | { kind: 'note'; note: Record<string, unknown>; asActor: boolean }
  | { kind: 'gone' | 'refused' | 'retryLater' };

/** The run's memo of who may sign a refused fetch. */
function actorSigners() {
  const keyIdOf = localActorKeyIdResolver();
  const usernameById = new Map<string, Promise<string | null>>();
  const followersByActor = new Map<string, Promise<string[]>>();

  async function localUsernames(ids: readonly string[]): Promise<string[]> {
    const missing = ids.filter((id) => !usernameById.has(id));
    if (missing.length > 0) {
      const lookup = getServiceOxyClient()
        .users.getMany(missing)
        .then((users) => {
          const byId = new Map<string, string>();
          for (const user of users) {
            const local = user.type !== 'federated' && user.isFederated !== true;
            if (local && user.id && user.username) byId.set(String(user.id), user.username);
          }
          return byId;
        });
      for (const id of missing) {
        usernameById.set(
          id,
          lookup.then(
            (byId) => byId.get(id) ?? null,
            () => {
              usernameById.delete(id);
              return null;
            },
          ),
        );
      }
    }
    const usernames = await Promise.all(ids.map((id) => usernameById.get(id)));
    return usernames.filter((name): name is string => Boolean(name));
  }

  function followersOf(actorUri: string): Promise<string[]> {
    let followers = followersByActor.get(actorUri);
    if (!followers) {
      followers = getDb()
        .select({ id: federatedFollows.localUserId })
        .from(federatedFollows)
        .where(
          and(
            eq(federatedFollows.remoteActorUri, actorUri),
            eq(federatedFollows.direction, 'outbound'),
            eq(federatedFollows.status, 'accepted'),
          ),
        )
        .limit(MAX_ACTOR_ATTEMPTS * 2)
        .then((rows) => rows.map((row) => row.id));
      followersByActor.set(actorUri, followers);
    }
    return followers;
  }

  /** Up to {@link MAX_ACTOR_ATTEMPTS} local usernames entitled to read the post. */
  return async function signersFor(postId: string, actorUri: string) {
    const db = getDb();
    const [mentioned, addressed] = await Promise.all([
      db
        .select({ id: postMentions.oxyUserId })
        .from(postMentions)
        .where(eq(postMentions.postId, postId)),
      db
        .select({ id: postRecipients.oxyUserId })
        .from(postRecipients)
        .where(eq(postRecipients.postId, postId)),
    ]);
    const ids = [...new Set([...mentioned, ...addressed].map((row) => row.id))];
    const names = await localUsernames(ids);
    if (names.length < MAX_ACTOR_ATTEMPTS) {
      names.push(...(await localUsernames(await followersOf(actorUri))));
    }
    return { names: [...new Set(names)].slice(0, MAX_ACTOR_ATTEMPTS), keyIdOf };
  };
}

/**
 * Fetch the note as the instance, then — while refused — as each local user
 * entitled to read it. A 5xx or network failure stops and asks for a re-run;
 * a 410 is final.
 */
async function fetchCandidateNote(
  activityId: string,
  signers: () => Promise<{ names: string[]; keyIdOf: (username: string) => Promise<string> }>,
): Promise<CandidateNote> {
  const first = await fetchActivityPubObjectAs(activityId);
  if (first.kind === 'object') return { kind: 'note', note: first.object, asActor: false };
  if (first.kind === 'failed') return { kind: 'retryLater' };
  if (first.status === 410) return { kind: 'gone' };

  let refused = first.kind === 'refused';
  const { names, keyIdOf } = await signers();
  for (const username of names) {
    let keyId: string;
    try {
      keyId = await keyIdOf(username);
    } catch {
      continue; // No key for this user here; the next one may have one.
    }
    const attempt = await fetchActivityPubObjectAs(activityId, { keyId });
    if (attempt.kind === 'object') return { kind: 'note', note: attempt.object, asActor: true };
    if (attempt.kind === 'failed') return { kind: 'retryLater' };
    if (attempt.status === 410) return { kind: 'gone' };
    if (attempt.kind === 'refused') refused = true;
  }
  return { kind: refused ? 'refused' : 'gone' };
}

export async function recoverFederatedDirectMessages(options: {
  dryRun: boolean;
  concurrency?: number;
}): Promise<RecoverDirectMessagesResult> {
  const result: RecoverDirectMessagesResult = {
    scanned: 0,
    converted: 0,
    followersOnly: 0,
    hidden: 0,
    restoredPublic: 0,
    unchanged: 0,
    fetchedAsActor: 0,
    gone: 0,
    refused: 0,
    retryLater: 0,
    actorUnresolved: 0,
  };
  const storedActors = new Map<string, ReturnType<typeof findActorByUri>>();
  const authorRefreshes: AuthorRefreshOptions['refreshes'] = new Map();
  /** The author's followers collection, re-reading a row without one once per run. */
  const followersUrlOf = async (note: Record<string, unknown>, actorUri: string) => {
    let stored = storedActors.get(actorUri);
    if (!stored) {
      stored = findActorByUri(actorUri);
      storedActors.set(actorUri, stored);
    }
    const actor = await stored;
    return authorFollowersUrl(
      note,
      { uri: actorUri, followersUrl: actor?.followersUrl },
      { recheckAfterMs: 0, refreshes: authorRefreshes },
    );
  };
  const signersFor = actorSigners();
  const shapes = new Map<string, Map<string, number>>();
  const samples = new Map<string, Array<{ host: string; shape: string }>>();
  const observe = (outcome: string, activityId: string, shape: string) => {
    if (!options.dryRun) return;
    const counts = shapes.get(outcome) ?? new Map<string, number>();
    shapes.set(outcome, counts);
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
    const kept = samples.get(outcome) ?? [];
    samples.set(outcome, kept);
    if (kept.length < MAX_SAMPLES_PER_OUTCOME) {
      kept.push({ host: new URL(activityId).host, shape });
    }
  };

  /** Move a post from the visibility this run read to `to`; a concurrent change wins. */
  const setVisibility = async (id: string, from: PostVisibility, to: PostVisibility) => {
    if (options.dryRun) return;
    const updated = await getDb()
      .update(posts)
      .set({ visibility: to })
      .where(and(eq(posts.id, id), eq(posts.visibility, from)))
      .returning({ id: posts.id });
    if (updated.length > 0) await invalidatePostDetailCache(id);
  };
  const hide = async (id: string) => {
    result.hidden += 1;
    await setVisibility(id, PostVisibility.FOLLOWERS_ONLY, PostVisibility.PRIVATE);
  };

  const recoverOne = async (row: {
    id: string;
    visibility: string;
    activityId: string | null;
    actorUri: string | null;
  }) => {
    if (!row.activityId || !row.actorUri) return;
    const actorUri = row.actorUri;
    result.scanned += 1;
    const stored = row.visibility as PostVisibility;
    const fetched = await fetchCandidateNote(row.activityId, () => signersFor(row.id, actorUri));

    if (fetched.kind === 'retryLater') {
      result.retryLater += 1;
      return;
    }
    if (fetched.kind !== 'note') {
      result[fetched.kind] += 1;
      if (stored === PostVisibility.FOLLOWERS_ONLY) await hide(row.id);
      else result.unchanged += 1;
      return;
    }
    if (fetched.asActor) result.fetchedAsActor += 1;

    const followers = await followersUrlOf(fetched.note, actorUri);
    if (!followers) {
      result.actorUnresolved += 1;
      return;
    }
    const { followersUrl } = followers;
    const audience = await resolveApAudienceExisting(fetched.note, { uri: actorUri, followersUrl });
    const shape = () => addressingShape(fetched.note, actorUri, followersUrl);
    if (audience?.visibility === PostVisibility.DIRECT) {
      result.converted += 1;
      observe('converted', row.activityId, shape());
      if (!options.dryRun && (await convertToDirectPost(row.id, stored, audience.recipients))) {
        await invalidatePostDetailCache(row.id);
      }
    } else if (audience?.visibility === PostVisibility.FOLLOWERS_ONLY) {
      result.followersOnly += 1;
      observe('followersOnly', row.activityId, shape());
    } else if (audience?.visibility === PostVisibility.PUBLIC) {
      result.restoredPublic += 1;
      observe('restoredPublic', row.activityId, shape());
      await setVisibility(row.id, stored, PostVisibility.PUBLIC);
    } else if (stored === PostVisibility.FOLLOWERS_ONLY) {
      observe('hidden', row.activityId, shape());
      await hide(row.id);
    } else {
      result.unchanged += 1;
      observe('unchanged', row.activityId, shape());
    }
  };

  let after = '';
  for (;;) {
    const rows = await getDb()
      .select({
        id: posts.id,
        visibility: posts.visibility,
        activityId: posts.federationActivityId,
        actorUri: posts.federationActorUri,
      })
      .from(posts)
      .where(
        and(
          inArray(posts.visibility, [PostVisibility.PRIVATE, PostVisibility.FOLLOWERS_ONLY]),
          like(posts.federationActivityId, 'http%'),
          after ? gt(posts.id, after) : undefined,
        ),
      )
      .orderBy(asc(posts.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    after = rows[rows.length - 1].id;

    const settled = await mapWithConcurrency(
      rows,
      options.concurrency ?? DEFAULT_CONCURRENCY,
      recoverOne,
    );
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') {
        // A database or Oxy failure on one post: it is untouched, so a re-run retries it.
        result.retryLater += 1;
        logger.warn(`[${SCRIPT_NAME}] post failed; left unchanged`, {
          postId: rows[index].id,
          reason: outcome.reason instanceof Error ? outcome.reason.message : 'unknown',
        });
      }
    }
  }

  if (options.dryRun) {
    const top = (counts: Map<string, number>) =>
      Object.fromEntries(
        [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SHAPES_PER_OUTCOME),
      );
    logger.info(`[${SCRIPT_NAME}] addressing shapes`, {
      shapes: Object.fromEntries([...shapes.entries()].map(([k, v]) => [k, top(v)])),
      samples: Object.fromEntries(samples),
    });
  }
  logger.info(`[${SCRIPT_NAME}] complete`, { ...options, ...result });
  return result;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun });
  await recoverFederatedDirectMessages({ dryRun });
}

if (require.main === module) {
  main()
    .then(async () => {
      await closeAdminScriptResources();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
