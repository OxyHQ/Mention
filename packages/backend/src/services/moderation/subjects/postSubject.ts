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

async function loadPost(postId: string): Promise<SnapshotPost | null> {
  return loadPostRecord(postId);
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
): Promise<ModerationContextResource | null> {
  if (postId === undefined) return null;
  const neighbour = await loadPost(postId);
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

export function createPostSubjectProvider(input: {
  reportedType: string;
  subjectType: string;
}): ModerationSubjectProvider {
  return {
    reportedType: input.reportedType,
    subjectType: input.subjectType,

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      const post = await loadPost(reportedId);
      if (!post) return null;

      const ownerId = getOwnerId(normalizeAuthorship(post.authorship)) ?? post.oxyUserId ?? undefined;
      const body = postText(post);

      const context: ModerationContextResource[] = [];
      for (const [id, role] of [
        [post.parentPostId, 'parent'],
        [post.quoteOf, 'quoted'],
      ] as const) {
        const resource = await contextResource(id ?? undefined, role);
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
