import { LanguageTagSchema } from '@oxyhq/crowdsource-contracts';
import { loadPostRecord } from '../../../db/posts/postRepository';
import type { PostRecord } from '../../../db/posts/postRecord';
import { config } from '../../../config';
import { getOwnerId, normalizeAuthorship } from '../../../utils/postAuthorship';
import { getPrimaryVariant } from '../../postVariants';
import type {
  ModerationContextResource,
  ModerationResource,
  ModerationSubjectProvider,
  ModerationSubjectSnapshot,
  ModerationUrgency,
} from './types';

/**
 * Mention posts, as universal material.
 *
 * A Mention post and a Mention comment are the same collection — a comment is a
 * post with a `parentPostId` — so both subject types are served by
 * {@link createPostSubjectProvider} with a different §5.4 label. That is the
 * shape a second application will usually find too: one loader, several nouns.
 *
 * ## What is NOT here, and why
 *
 * **Media is not attached.** A post's media is DECLARED in the report metadata —
 * count and kinds — so a jury can see that material exists which it was not given,
 * and a report whose only substance is an image is answerable as
 * `insufficient_context` for the right reason rather than by accident. That is the
 * honest state while the gap is open, and it is not the state it has to stay in.
 *
 * ### What closing it actually takes, as of `@oxyhq/crowdsource-contracts` 0.3.0
 *
 * 0.3.0 changed the answer and made it much smaller than it was. `AssetRef` used to
 * be "exactly one of `uploadId` or `url`", with `uploadId` needing a presigned upload
 * route CrowdSource never built. That is gone: the `Uploads` namespace was removed,
 * CrowdSource serves no upload route at all, and the shape is now
 * `{ fileId, url?, mimeType, sha256, sizeBytes?, width?, height?, durationSeconds? }`
 * — a bare Oxy file id plus a digest, because bytes travel through the Oxy media
 * chokepoint like all other Oxy media. `url` is PROVENANCE ONLY and no reviewer
 * client dereferences it (fetching would tell the origin host when its content is
 * under review, and deliver live bytes rather than the pinned ones §5.6 requires).
 *
 * Which means Mention already holds every field but one, and the missing one needs no
 * byte fetching either:
 *
 *   * `fileId` — `MediaItem.id` IS an Oxy file id for native media, and for federated
 *     media once the media cache has rewritten it (`cachedFromFederation`, with the
 *     origin URL preserved in `remoteUrl` — which is exactly `AssetRef.url`).
 *   * `sha256` + `mimeType` + `sizeBytes`/`width`/`height`/`durationSeconds` — one
 *     batched `getServiceAssetMetadataByIds` call on the service Oxy client returns
 *     `{ id, sha256, mime, size, width?, height?, durationSec? }` per file id, which
 *     is the whole of `AssetRef` field-for-field. Mention already makes this exact
 *     call in `services/mtn/mentionRecordBuilders.ts` (`resolvePostRecordEmbeds`) to
 *     content-address post media for the MTN chain, so the digest is a lookup rather
 *     than a download.
 *
 * So this is one function here — collect the file ids, resolve metadata, map to
 * `attachments` — plus flipping `evidenceAttachmentsSupported` in
 * `EvidenceSnapshotService`. Two things to get right when it is built, both of which
 * would otherwise be found in production: the digest MUST land in the snapshot hash
 * (a re-uploaded image is a different version and §5.6 says so), and a federated item
 * the cache has NOT rewritten still has a URL in `id` and no file id at all, so it
 * stays declared-only rather than becoming an `AssetRef` with an invented digest.
 */

/** A lean post, projected to exactly what a snapshot needs. */
/**
 * The post fields an evidence snapshot reads.
 *
 * A structural alias of {@link PostRecord} rather than a projection type: the
 * record is assembled whole, and naming a narrower shape here would only invite
 * a future field to be read without being declared.
 */
type SnapshotPost = PostRecord;

/**
 * §5.2's `sensitivity` hint for a post carrying a content warning.
 *
 * An open lowercase token, and deliberately one that names its PROVENANCE. It is
 * a hint, never a verdict: triage computes the authoritative sensitivity class
 * server-side and gates access on that, so the only useful thing this field can
 * say is who asserted it.
 */
const AUTHOR_DECLARED_SENSITIVITY = 'author_marked_sensitive';

/** Whether the post carries a content warning from its author or its origin. */
function isMarkedSensitive(post: SnapshotPost): boolean {
  return post.metadata.isSensitive === true || post.federation?.sensitive === true;
}

/** Text length CrowdSource accepts inline. Beyond it the material is truncated. */
const MAX_CONTEXT_TEXT_LENGTH = 4_000;

/**
 * A BCP 47 tag the contract will accept, or nothing.
 *
 * Validated with the contract's OWN schema rather than a local regex: an invalid
 * tag makes envelope composition throw a non-retryable input error, and a report
 * must not be undeliverable because a post carries an exotic language tag. The
 * tag is context, not evidence, so dropping it costs nothing.
 */
function contractLanguage(tag: string | undefined): string | undefined {
  if (tag === undefined) return undefined;
  return LanguageTagSchema.safeParse(tag).success ? tag : undefined;
}

/** The post's own body, resolved through the single primary-variant accessor. */
function postText(post: SnapshotPost): { text: string; language?: string } | null {
  const primary = post.content === undefined ? undefined : getPrimaryVariant(post.content);
  const body = primary?.text?.trim();
  if (body) {
    return {
      text: body.slice(0, MAX_CONTEXT_TEXT_LENGTH),
      language: contractLanguage(primary?.tag ?? post.language),
    };
  }

  const articleTitle = post.content?.article?.title?.trim();
  if (articleTitle) {
    const excerpt = post.content?.article?.excerpt?.trim();
    return {
      text: (excerpt ? `${articleTitle}\n\n${excerpt}` : articleTitle).slice(
        0,
        MAX_CONTEXT_TEXT_LENGTH,
      ),
      language: contractLanguage(post.language),
    };
  }

  return null;
}

/** How many media items the post carries, by kind — declared, never attached. */
function mediaSummary(post: SnapshotPost): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const item of post.content?.media ?? []) {
    summary[item.type] = (summary[item.type] ?? 0) + 1;
  }
  return summary;
}

/**
 * The subject resource for a post with no body at all.
 *
 * A `metadata` resource (§5.3 "typed key value fields") rather than an empty text
 * resource, which the contract rejects and rightly so. It says what the post
 * consisted of without pretending to carry it.
 */
function mediaOnlySubjectResource(post: SnapshotPost): ModerationResource {
  const media = mediaSummary(post);
  const entries = Object.entries(media);
  return {
    type: 'metadata',
    data: {
      bodyText: 'absent',
      mediaItems: entries.reduce((total, [, count]) => total + count, 0),
      mediaKinds: entries.length > 0 ? entries.map(([kind]) => kind).join(',') : 'none',
      evidenceAttached: false,
    },
  };
}

/**
 * The two facts that decide where a post is readable.
 *
 * An absent field means the permissive value, matching the rest of the schema —
 * and both predicates have to agree with the disclosure gate below and with the
 * urgency they feed, or a post could be described as actively distributed by one
 * and withheld as private by the other.
 */
function isPublished(post: SnapshotPost): boolean {
  return (post.status ?? 'published') === 'published';
}

function isPublic(post: SnapshotPost): boolean {
  return (post.visibility ?? 'public') === 'public';
}

/**
 * Load material only when it is safe to disclose outside Mention.
 *
 * CrowdSource delivery runs asynchronously without the reporter's delegated Oxy
 * credentials, so it cannot reliably re-evaluate follower, profile, block, or
 * restriction relationships. Fail closed to public, published material while still
 * allowing an author to report their own post. Row ids are never treated as an
 * authorization boundary.
 */
async function loadPost(postId: string, reporterId?: string): Promise<SnapshotPost | null> {
  const post = await loadPostRecord(postId);
  if (!post) return null;

  const ownerId = getOwnerId(normalizeAuthorship(post.authorship)) ?? post.oxyUserId;
  if (ownerId === reporterId) return post;

  return isPublished(post) && isPublic(post) ? post : null;
}

/**
 * One neighbouring post as context (§5.5).
 *
 * Text only, and only if it has text: a jury judging a reply needs to read what
 * it replied to, not the parent's attachments. §9.1 keeps the view to the
 * minimum that makes the question answerable.
 */
async function contextResource(
  postId: string | undefined,
  role: ModerationContextResource['role'],
  reporterId?: string,
): Promise<ModerationContextResource | null> {
  if (postId === undefined) return null;
  const neighbour = await loadPost(postId, reporterId);
  if (!neighbour) return null;
  const body = postText(neighbour);
  if (!body) return null;
  return {
    role,
    type: 'text',
    data: { text: body.text },
    ...(body.language === undefined ? {} : { language: body.language }),
    ...(neighbour.createdAt === undefined
      ? {}
      : { createdAt: new Date(neighbour.createdAt) }),
  };
}

/** Where Mention's own users see the post. Never fetched by a jury (§5.1). */
function permalink(post: SnapshotPost): string {
  return post.federation?.url ?? `${config.web.origin}/p/${post.id}`;
}

/**
 * §5.1 `urgency.hint` — ONE token naming how far the material travelled.
 *
 * Distribution, and never severity. §7.4 is explicit that triage decides queue
 * ORDER and does not decide guilt, so a hint that read as evidence the allegation
 * is TRUE — naming what the content is alleged to be, or repeating an allegation
 * code — would be a policy violation wearing a scheduling hint's clothes. Every
 * token below states only where the post is readable.
 *
 * The contract constrains this to `^[a-z][a-z0-9_]*$` (max 40), so a descriptive
 * phrase is not available and the vocabulary itself has to carry the meaning.
 *
 * Ordered most-reachable first, because the states overlap and only one token can
 * be sent. A copy of remote material is published at its origin whatever Mention's
 * own row says, which outranks anything Mention's visibility can express.
 *
 * `public_feed` deliberately does not claim "Mention only". Whether a LOCAL post
 * also went out to the fediverse is not a fact this row can answer: the obvious
 * candidate, `metadata.federationDelivered`, is not a declared path on
 * `PostMetadataSchema` and Mongoose's strict mode strips it on write, so it reads
 * `undefined` on every post regardless of what happened. Asserting locality from
 * an absent flag would be inventing a distribution fact — so the token asserts
 * what is true and denies nothing.
 */
function distributionHint(post: SnapshotPost): string {
  if (post.federation !== undefined) return 'federated_origin';
  if (!isPublished(post)) return 'not_distributed';
  return isPublic(post) ? 'public_feed' : 'limited_audience';
}

/**
 * §5.1 `urgency.reach` — Mention's own view counter, and nothing else.
 *
 * `stats.viewsCount` is the one number this application holds that counts PEOPLE
 * rather than actions: `feedViewCounter` increments it at most once per
 * (viewer, post) within a rolling window and only for a published public post.
 * That is what the contract asks for in its own words — "how many people the
 * material reached, as the application counts it".
 *
 * The rejected candidates matter as much, because triage weights this
 * logarithmically (`log10(1 + reach) * 2`, capped) and a wrong number is not
 * visibly wrong — it just quietly orders the queue badly. The author's FOLLOWER
 * count is a potential audience rather than a reach, and would triage every post
 * by a large account identically whether or not anyone read it. Likes and boosts
 * are a SUBSET of the people who saw it, so sending one as reach understates by a
 * factor that varies with the topic and the author.
 *
 * It UNDERCOUNTS a federated post, because a read on a remote instance never comes
 * back to Mention — which is exactly why `federated_origin` exists as a hint, so
 * the shortfall is legible instead of silent. Scaling the number up by a guessed
 * multiplier would put a figure in front of triage that nobody could explain, and
 * a stated undercount is worth more than an invented estimate.
 */
function reachedAudience(post: SnapshotPost): number | undefined {
  const views = post.stats?.viewsCount;
  /**
   * The contract types `reach` as a non-negative integer and refuses anything
   * else — and a refused envelope is a NON-retryable input error, so a corrupt
   * counter would cost the whole report rather than just its queue position.
   * Omitted rather than coerced: a rounded or clamped value would be a number
   * Mention made up, which is the thing this field must never carry.
   */
  return typeof views === 'number' && Number.isInteger(views) && views >= 0
    ? views
    : undefined;
}

export function createPostSubjectProvider(input: {
  reportedType: string;
  subjectType: string;
}): ModerationSubjectProvider {
  return {
    reportedType: input.reportedType,
    subjectType: input.subjectType,

    /**
     * Read at INTAKE, through the same disclosure gate as the material itself.
     *
     * Sharing `loadPost` is what keeps the two answers from disagreeing: a post a
     * reporter may not be shown produces no snapshot AND no urgency, so a report
     * can never describe the distribution of material the envelope will not
     * carry. It also means `limited_audience` and `not_distributed` are only ever
     * reachable on a self-report, which is the only case where a non-public post
     * is disclosable at all.
     *
     * A comment gets the same treatment as a post, and that is not an oversight:
     * they are one collection with one `stats.viewsCount`, so a reply that was
     * read by ten thousand people reached ten thousand people. A profile is the
     * case with no defensible answer — see `userSubject.ts`.
     */
    async urgencySnapshot(
      reportedId: string,
      reporterId?: string,
    ): Promise<ModerationUrgency | null> {
      const post = await loadPost(reportedId, reporterId);
      if (!post) return null;

      const reach = reachedAudience(post);
      return {
        hint: distributionHint(post),
        ...(reach === undefined ? {} : { reach }),
        /**
         * "Is it still being handed to people right now." `status: 'published'`
         * plus a public `visibility` is precisely what every feed source and the
         * post-hydration ACL already require, so this reuses the read path's own
         * definition of reachable rather than writing a second one. It is also why
         * a post that an earlier decision RESTRICTED answers `false` here, without
         * anything in this file knowing that enforcement exists.
         */
        activeDistribution: isPublished(post) && isPublic(post),
      };
    },

    async snapshot(
      reportedId: string,
      reporterId?: string,
    ): Promise<ModerationSubjectSnapshot | null> {
      const post = await loadPost(reportedId, reporterId);
      if (!post) return null;

      const ownerId = getOwnerId(normalizeAuthorship(post.authorship)) ?? post.oxyUserId ?? undefined;
      const body = postText(post);

      const context: ModerationContextResource[] = [];
      for (const [id, role] of [
        [post.parentPostId, 'parent'],
        [post.quoteOf, 'quoted'],
      ] as const) {
        const resource = await contextResource(id ?? undefined, role, reporterId);
        if (resource) context.push(resource);
      }

      const content: ModerationResource =
        body === null
          ? mediaOnlySubjectResource(post)
          : {
              type: 'text',
              data: { text: body.text },
              ...(body.language === undefined ? {} : { language: body.language }),
              ...(post.createdAt === undefined ? {} : { createdAt: new Date(post.createdAt) }),
              // Only a DECLARED content warning travels. Mention's own classifier
              // score is a ranking signal, not something the author asserted, and
              // sending it would put a machine's guess in front of a jury as if
              // the author had said it.
              ...(isMarkedSensitive(post) ? { sensitivity: AUTHOR_DECLARED_SENSITIVITY } : {}),
            };

      return {
        subject: {
          externalId: post.id,
          type: input.subjectType,
          permalink: permalink(post),
          ...(ownerId === undefined ? {} : { author: { oxyUserId: ownerId } }),
        },
        content,
        ...(context.length > 0 ? { context } : {}),
      };
    },
  };
}
