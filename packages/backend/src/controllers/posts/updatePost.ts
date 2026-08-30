/**
 * `PUT /posts/:id` — the author's edit of a published or draft post, including
 * the correction record an edit to a published post leaves behind.
 */

import { Response } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { posts as postsTable } from '../../db/schema/posts';
import {
  loadPostRecord,
  replacePostContent,
  updatePostRecord,
  type PostRecordPatch,
} from '../../db/posts/postRepository';
import { POST_CLASSIFICATION_PENDING, type PostRecord } from '../../db/posts/postRecord';
import { baselineContentClassifier } from '../../services/BaselineContentClassifier';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { PostVisibility, StoredPostContent, PostContentVariant, toBaseLanguages } from '@mention/shared-types';
import { mentionTextsFromContent } from '@mention/shared-types/mentions';
import {
  deleteArticles,
  findArticleById,
  insertArticle,
  newArticleId,
  updateArticle,
} from '../../db/posts/articleRepository';
import { logger } from '../../utils/logger';
import { postHydrationService } from '../../services/PostHydrationService';
import { mergeHashtags, reconcileMentionIdsForPost } from '../../utils/textProcessing';
import { foldProfileLinkMentions } from '../../services/profileLinkMentions';
import { createScopedOxyClient, createUserScopedOxyServices } from '../../utils/oxyHelpers';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';
import { normalizeMediaItems } from '../../utils/mediaInput';
import {
  authorVariants,
  buildPrimaryVariant,
  stripSpamHashtagBlocks,
  validateAuthorVariants,
} from '../../services/postVariants';
import { isChannelAccount } from '../../services/publishAsAccount';
import { recordPostCorrection } from '../../db/posts/postCorrectionsRepository';
import { postManagementRefusal } from '../../services/postManagementAccess';
import { emitPostCreated } from '../../services/mtn/MentionRecordEmitter';
import {
  postCollaborationService,
  CollabValidationError,
  CollabStateError,
} from '../../services/PostCollaborationService';
import { resolveMcpAutoAcceptIds } from '../../mcp/utils/resolveMcpAutoAcceptIds';
import { federateAsResolvedActor } from '../../connectors/outboundFederation';
import { toFederationPostPayload } from '../../services/serviceRegistry';
import { loadScheduledChain } from '../../services/scheduledChain';
import {
  MAX_TEXT_LENGTH,
  buildOrderedAttachments,
  hashtagsSchema,
  parseFailureMessage,
  sanitizeArticle,
  sanitizeSources,
} from './composeInput';

/**
 * The renditions a post carries after an edit.
 *
 * Three cases, and the machine translations survive NONE of them — they translate
 * a body that no longer exists:
 *  - the edit supplies an author variant set → it replaces the old one outright
 *    (the composer's language tabs are the whole truth);
 *  - the post is multilingual and only its body changed → the new body lands on the
 *    PRIMARY variant and the other declared languages are left exactly as the author
 *    wrote them (a Spanish edit must not silently rewrite the English rendition);
 *  - the post is single-language → the primary is rebuilt from the new body, re-tagged
 *    with what the classifier just detected, so an edit that changes the language of
 *    the post is actually allowed to change the language of the post.
 */
const rewriteEditedVariants = (params: {
  authorLanguageVariants?: PostContentVariant[];
  existingAuthorVariants: PostContentVariant[];
  text?: string;
  detectedPrimary?: string;
}): PostContentVariant[] => {
  const { authorLanguageVariants, existingAuthorVariants, text, detectedPrimary } = params;

  if (authorLanguageVariants !== undefined) {
    return authorLanguageVariants;
  }

  const newText = text ?? '';

  if (existingAuthorVariants.length > 1) {
    return existingAuthorVariants.map((variant, index) =>
      index === 0 ? { ...variant, text: newText } : variant,
    );
  }

  const primary = buildPrimaryVariant(newText, detectedPrimary);
  return primary ? [primary] : [];
};

// Update post
export const updatePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Fetched by id and authorized separately, rather than scoped by
    // `oxy_user_id = userId`. A CHANNEL post's `oxyUserId` is the channel — an
    // account nobody can be signed in as — so the scoped lookup made every
    // channel post uneditable by everybody, including the person who wrote it.
    // `postManagementRefusal` below is what decides, and it still answers 404,
    // so the reply is unchanged for a caller who may not touch this post.
    const loaded = await loadPostRecord(String(req.params.id));
    if (!loaded) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const editRefusal = await postManagementRefusal({
      post: loaded,
      callerId: userId,
      memberReader: createUserScopedOxyServices(req),
    });
    if (editRefusal) {
      return res.status(editRefusal.status).json({ message: editRefusal.message });
    }

    // The 30-minute edit window exists because READERS have already seen a
    // published post: rewriting one indefinitely is a trust problem, so the
    // author gets a short grace period and no more.
    //
    // A SCHEDULED post has no readers. It has not published, has not federated,
    // and has emitted no MTN record — so the window's reason simply does not
    // apply, while the window itself would make a post scheduled for next
    // Tuesday uneditable thirty minutes after it was written. Hence the
    // carve-out. It is decided from the STORED status read in this request;
    // nothing the client sends can select it.
    // A CHANNEL post has no window either, and for the opposite reason to a
    // scheduled one: not that nobody has read it, but that a publication is
    // expected to fix what it published however long ago — and to do it in the
    // open. So the grace period is replaced rather than extended: the post stays
    // editable for life, and every change to its body appends a row to
    // `post_corrections` that says what it said before (see below). Permanent
    // editability WITHOUT that trail would be strictly worse than the window,
    // because it would let a publication rewrite what people read with nothing to
    // show for it.
    //
    // `isChannelAccount` fails SOFT to `false`, which here means "apply the
    // window" — during an Oxy identity outage a late correction is refused rather
    // than allowed, and refusing an edit is the recoverable direction.
    const editingScheduledPost = loaded.status === 'scheduled';
    const editingChannelPost = await isChannelAccount(loaded.oxyUserId);
    if (!editingScheduledPost && !editingChannelPost) {
      const EDIT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
      if (Date.now() - loaded.createdAt.getTime() > EDIT_WINDOW_MS) {
        return res.status(403).json({ message: 'Edit window has expired. Posts can only be edited within 30 minutes of creation.' });
      }
    }

    // The edit is assembled as PLAIN VALUES and written once at the end, rather
    // than mutated onto a live document and saved. `content` is a graph across
    // six child tables whose `position` columns are densely unique, so the only
    // correct write is `replacePostContent`'s transactional delete-then-insert —
    // there is no per-field `markModified` to reach for, and a half-applied edit
    // would leave a post with some of its renditions.
    const post = loaded;
    const content: StoredPostContent = { ...post.content };
    const patch: PostRecordPatch = {};

    // Rescheduling. Only a post that is still scheduled can be moved — sending a
    // time for a published post is a client bug, not a silent no-op. The new
    // time may be EARLIER or later; the only bound is that it is still ahead,
    // since the publisher sweeps for `scheduled_for <= now` and a past time would
    // mean "publish on the next tick" while reading as a schedule.
    let rescheduledTo: Date | null = null;
    if (req.body.scheduledFor !== undefined) {
      if (!editingScheduledPost) {
        return res.status(400).json({ message: 'Only a scheduled post can be rescheduled' });
      }
      const nextScheduledFor = new Date(req.body.scheduledFor);
      if (Number.isNaN(nextScheduledFor.getTime())) {
        return res.status(400).json({ message: 'scheduledFor must be a valid date' });
      }
      if (nextScheduledFor.getTime() <= Date.now()) {
        return res.status(400).json({ message: 'scheduledFor must be in the future' });
      }
      patch.scheduledFor = nextScheduledFor;
      rescheduledTo = nextScheduledFor;
    }

    // Support both flat body fields and nested content object from frontend
    const contentObj = req.body.content;
    const media = contentObj?.media ?? req.body.media;
    const { hashtags, mentions, contentLocation, postLocation, sources } = req.body;

    // `hashtags` is read at TWO points below — once when the body changes and
    // once as a field of its own — and both handed it straight to
    // `mergeHashtags`, which calls `.map` on whatever it is given. A truthy
    // non-array was a `TypeError` and a 500; an array of any size and any
    // content was written to `posts.hashtags` unbounded, while `POST /posts`
    // refused both. Parsed ONCE here so the two uses cannot disagree, and only
    // when truthy, because a falsy value has always meant "keep what is stored".
    let parsedHashtags: string[] | undefined;
    if (hashtags) {
      const parsed = hashtagsSchema.safeParse(hashtags);
      if (!parsed.success) {
        return res.status(400).json({ message: parseFailureMessage(parsed.error) });
      }
      parsedHashtags = parsed.data;
    }

    // The media set the variants localize: the incoming one when this edit
    // replaces it, otherwise the set already on the post.
    const normalizedMedia = media !== undefined ? normalizeMediaItems(media) : undefined;
    const sharedMediaIds = (normalizedMedia ?? content.media ?? []).map((item) => String(item.id));

    let authorLanguageVariants: PostContentVariant[] | undefined;
    if (contentObj?.variants !== undefined) {
      const variantResult = validateAuthorVariants(contentObj.variants, sharedMediaIds);
      if (!variantResult.ok) {
        return res.status(400).json({ message: variantResult.error });
      }
      authorLanguageVariants = variantResult.variants;
    }

    const existingAuthorVariants = authorVariants(content);
    const currentText = existingAuthorVariants[0]?.text;

    // The new primary body: the first author variant's when this edit supplies
    // variants, otherwise the plain text field (the API's single-language shape).
    const text = authorLanguageVariants !== undefined
      ? (authorLanguageVariants[0]?.text ?? '')
      : (contentObj?.text ?? req.body.text);

    if (text !== undefined && typeof text === 'string' && text.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ message: `Post text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` });
    }

    const textChanged = text !== undefined && currentText !== text;

    // Save the old primary body to edit history before modifying
    let nextHashtags = post.hashtags;
    if (textChanged) {
      patch.editHistory = currentText
        ? [...post.editHistory, currentText]
        : [...post.editHistory];
      patch.isEdited = true;
      // Re-extract hashtags when the body changes
      nextHashtags = mergeHashtags(text || '', parsedHashtags || post.hashtags);
      patch.hashtags = nextHashtags;
    }

    if (normalizedMedia !== undefined) {
      content.media = normalizedMedia;
    }

    if (authorLanguageVariants !== undefined || textChanged) {
      // Re-classify the post for its new content. The deterministic Stage-A
      // classifier is pure/synchronous, so it refreshes the canonical
      // `postClassification.topics` slug list (plus languages/region/scores/
      // sensitive) inline; stale Stage-B `topicRefs` from the old text are
      // cleared and `status` is reset to `pending` so the AI batch re-refines
      // this post on its next cycle (a no-op when the AI batch is disabled —
      // the refreshed Stage-A slugs remain the canonical list).
      //
      // Only a real DECLARATION is fed back in: the variant set this edit supplies,
      // or the one already on the post when it holds several languages (nothing but
      // a declaration produces more than one). A post with a single, DERIVED
      // rendition declares nothing, so detection re-runs on the new body — otherwise
      // a post rewritten from Spanish into English would stay pinned to `es`, since
      // the classifier trusts a declaration over the detector.
      const declaredVariants = authorLanguageVariants
        ?? (existingAuthorVariants.length > 1 ? existingAuthorVariants : []);

      const signals = baselineContentClassifier.classify({
        text: text ?? currentText,
        hashtags: nextHashtags,
        languages: toBaseLanguages(declaredVariants.map((variant) => variant.tag)),
        sensitive: post.federation?.sensitive ?? post.metadata.isSensitive,
        isFederated: post.federation != null,
      });
      // A fresh Stage-A baseline with status reset to `pending`, and the Stage-B
      // fields reset WITH it: `attempts` back to 0, the AI `scores`/`sentiment`/
      // `intent`/`confidence` replaced by the deterministic ones, `topicRefs`
      // cleared. Mongo got that for free by replacing the whole subdocument and
      // letting the schema defaults refill it; here every reset field is named,
      // because `updatePostRecord` MERGES a partial and would otherwise leave the
      // previous body's AI topics attached to the new one.
      patch.postClassification = {
        status: POST_CLASSIFICATION_PENDING,
        attempts: 0,
        topics: signals.topics,
        topicRefs: [],
        languages: signals.languages,
        region: signals.region,
        hashtagsNorm: signals.hashtagsNorm,
        trendTerms: signals.trendTerms,
        sensitive: signals.sensitive,
        scores: signals.scores,
        version: signals.version,
        sentiment: 'neutral',
        intent: 'other',
        confidence: 0,
        classifiedAt: new Date(signals.classifiedAt),
      };
      const primaryLanguage = signals.languages[0];
      if (primaryLanguage != null) {
        patch.language = primaryLanguage;
      }

      // Rewrite the renditions. Every branch drops the machine translations: they
      // translate a body that no longer exists, and serving one would show a reader
      // the post as it used to be.
      //
      // `stripSpamHashtagBlocks` is the edit half of the retired `pre('validate')`
      // hook (`toStoredContent` is the create half). It sits INSIDE this branch on
      // purpose: the branch condition — the edit supplied renditions, or the body
      // changed — is what `isModified('content.variants')` used to answer, so a
      // media-only or settings-only edit still rewrites nobody's words. The tags
      // themselves survive the strip: `patch.hashtags` was taken from the RAW body
      // above, before this runs.
      content.variants = stripSpamHashtagBlocks(rewriteEditedVariants({
        authorLanguageVariants,
        existingAuthorVariants,
        text,
        detectedPrimary: primaryLanguage,
      }));
    }

    // Handle content location updates (user's shared location)
    //
    // The pair is tested for BEING A COORDINATE PAIR, which is the check
    // `createThread` has always applied and this path had only half of: a
    // `!== undefined` test admitted `latitude: 'x'` into a `double precision`
    // column (a driver error) and `latitude: 999` into one guarded by
    // `posts_content_location_range_check` (a check violation), and both were a
    // 500 that failed the WHOLE edit. A pair that is not a pair leaves the
    // stored location untouched, exactly as a half-written one already did.
    if (contentLocation !== undefined) {
      if (contentLocation === null) {
        // Remove content location
        content.location = undefined;
      } else if (
        typeof contentLocation.latitude === 'number' && typeof contentLocation.longitude === 'number' &&
        contentLocation.latitude >= -90 && contentLocation.latitude <= 90 &&
        contentLocation.longitude >= -180 && contentLocation.longitude <= 180
      ) {
        // Update content location
        content.location = {
          type: 'Point',
          coordinates: [contentLocation.longitude, contentLocation.latitude], // GeoJSON format: [lng, lat]
          address: contentLocation.address || undefined
        };
      }
    }

    // Handle post location updates (creation location metadata)
    if (postLocation !== undefined) {
      if (postLocation === null) {
        // Remove post location. `null` is the ERASURE, distinct from the
        // `undefined` that means "this edit does not mention the location" —
        // `updatePostRecord` reads the two differently and would keep the old
        // coordinates for `undefined`.
        patch.location = null;
      } else if (
        typeof postLocation.latitude === 'number' && typeof postLocation.longitude === 'number' &&
        postLocation.latitude >= -90 && postLocation.latitude <= 90 &&
        postLocation.longitude >= -180 && postLocation.longitude <= 180
      ) {
        // Update post location
        patch.location = {
          type: 'Point',
          coordinates: [postLocation.longitude, postLocation.latitude], // GeoJSON format: [lng, lat]
          address: postLocation.address || undefined
        };
      }
    }

    if (sources !== undefined) {
      const { sources: sanitized, error: sourcesErr } = sanitizeSources(sources);
      if (sourcesErr) {
        return res.status(400).json({ message: sourcesErr });
      }
      content.sources = sanitized.length ? sanitized : undefined;
    }

    if (req.body.article !== undefined) {
      const sanitizedArticle = sanitizeArticle(req.body.article);
      const existingArticleId = content.article?.articleId;
      if (sanitizedArticle) {
        const existing = existingArticleId ? await findArticleById(existingArticleId) : undefined;
        const previousArticle = content.article || {};

        // `updateArticle` re-anchors `post_id` as well as writing the body, so
        // the two branches differ only in whether a row already exists.
        let articleId: string;
        if (existing) {
          articleId = existing.id;
          await updateArticle(articleId, post.id, {
            title: sanitizedArticle.title,
            body: sanitizedArticle.body,
          });
        } else {
          articleId = newArticleId();
          await insertArticle({
            id: articleId,
            createdBy: userId,
            postId: post.id,
            title: sanitizedArticle.title || undefined,
            body: sanitizedArticle.body || undefined,
          });
        }
        content.article = {
          articleId,
          title: sanitizedArticle.title !== undefined ? sanitizedArticle.title : previousArticle.title,
          excerpt: sanitizedArticle.body !== undefined
            ? (sanitizedArticle.body ? sanitizedArticle.body.slice(0, 280) : undefined)
            : previousArticle.excerpt,
        };
      } else {
        if (existingArticleId) {
          await deleteArticles([existingArticleId]);
        }
        content.article = undefined;
      }
    }
    const attachmentUpdateInput = req.body.content?.attachments ?? req.body.attachments ?? req.body.attachmentOrder;
    const updatedAttachments = buildOrderedAttachments({
      rawAttachments: attachmentUpdateInput ?? content.attachments,
      media: Array.isArray(content.media) ? content.media : [],
      includePoll: Boolean(content.pollId),
      includeArticle: Boolean(content.article),
      includeEvent: Boolean(content.event),
      includeRoom: Boolean(content.room),
      includeLocation: Boolean(content.location),
      includeSources: Boolean(content.sources && content.sources.length),
      includePodcast: Boolean(content.podcast)
    });

    content.attachments = updatedAttachments ?? undefined;

    if (hashtags !== undefined) patch.hashtags = mergeHashtags('', parsedHashtags || []);

    // An edit is a write boundary like any other: a profile link the author has
    // just pasted into the body becomes a mention here, on the same terms as on
    // creation (see `foldProfileLinkMentions`). Run after the renditions above
    // have been rewritten, so it reads the body this edit is actually storing.
    // `content` is the object this request will persist, and the fold rewrites it
    // in place — no `markModified` equivalent is needed, because the whole column
    // is written back below rather than a tracked subtree of a live document.
    const foldedMentions = await foldProfileLinkMentions(
      content,
      mentions !== undefined ? mentions : post.mentions,
    );
    const nextMentions = reconcileMentionIdsForPost(
      mentionTextsFromContent(content),
      foldedMentions.mentions,
    );

    const collaboratorIds = await postCollaborationService.resolveCollaboratorRefs(
      userId,
      Array.isArray(req.body.collaboratorIds) ? req.body.collaboratorIds : undefined,
      Array.isArray(req.body.collaboratorHandles) ? req.body.collaboratorHandles : undefined,
    );

    // An edit that started under the scheduled carve-out must not land on a post
    // that went live while it was being assembled — the publisher sweeps every
    // 60s, and the body above does its own I/O (article save, collaborator
    // resolution). Re-read the STORED status as late as possible and refuse
    // rather than write, so a just-published post cannot be edited without its
    // 30-minute window. This narrows the window to the gap between this read and
    // the two writes below; it does not close it, because the content graph is a
    // second statement that no predicate on the first could cover. The residual
    // exposure is bounded: `status` is not among the patched columns, so the
    // write can never revert a publish, and the federation/MTN gates below
    // re-read the status themselves.
    if (editingScheduledPost) {
      const [stillScheduled] = await getDb()
        .select({ id: postsTable.id })
        .from(postsTable)
        .where(and(eq(postsTable.id, post.id), eq(postsTable.status, 'scheduled')))
        .limit(1);
      if (!stillScheduled) {
        return res.status(409).json({
          message: 'This post published while you were editing it. Reload it to edit within the 30-minute window.',
        });
      }
    }

    await updatePostRecord(post.id, patch);
    await replacePostContent(post.id, content, nextMentions);

    // The correction trail — the half of permanent editability that makes it
    // honest. Recorded AFTER the write, so an edit that failed leaves no claim
    // that the post once said something else.
    //
    // Three conditions, and each excludes a case where there is nothing to be
    // accountable for. A channel post, because only a publication trades its
    // window for a trail. A change to the BODY, because that is what a reader
    // read — a lane move, a pin or a media swap is not a correction and
    // `isEdited` has never counted one either. And a post that was already
    // PUBLISHED before this edit: a draft or a scheduled post has no readers, so
    // rewriting it corrects nobody's understanding of anything.
    let correction: Awaited<ReturnType<typeof recordPostCorrection>> = null;
    if (editingChannelPost && textChanged && post.status === 'published') {
      correction = await recordPostCorrection({
        postId: post.id,
        previousText: currentText ?? '',
        correctedByOxyUserId: userId,
        correctedAt: new Date(),
      });
    }

    // A scheduled THREAD has one publish moment, not one per post: its
    // continuations are replies to each other and the author picked a time for
    // the thread, so moving any member moves the whole chain. Leaving the others
    // behind would not break the ordering invariant — a continuation whose
    // parent is still scheduled simply waits — but it would show the author a
    // queue with three different times for one thread and publish it in dribs.
    // After the write, so a failed edit cannot move anything.
    //
    // Scoped to the post's OWNER, never the caller. A channel's thread is owned
    // by the channel, so walking it as the caller matched nothing and moved the
    // edited post alone — silently producing the exact split queue this block
    // exists to prevent, with no error anywhere. The caller's right to be here at
    // all was settled by `postManagementRefusal` above; this only has to name the
    // account whose chain it is.
    if (rescheduledTo) {
      const chainOwnerId = post.oxyUserId ? String(post.oxyUserId) : userId;
      const chain = await loadScheduledChain(post.id, chainOwnerId);
      if (chain.ok) {
        const others = chain.postIds.filter((id) => id !== post.id);
        if (others.length > 0) {
          await getDb()
            .update(postsTable)
            .set({ scheduledFor: rescheduledTo })
            .where(and(
              inArray(postsTable.id, others),
              eq(postsTable.oxyUserId, chainOwnerId),
              eq(postsTable.status, 'scheduled'),
            ));
        }
      }
    }

    let edited: PostRecord = {
      ...post,
      ...(patch.isEdited !== undefined ? { isEdited: patch.isEdited } : {}),
      ...(patch.editHistory !== undefined ? { editHistory: patch.editHistory } : {}),
      ...(patch.hashtags !== undefined ? { hashtags: patch.hashtags } : {}),
      ...(patch.language ? { language: patch.language } : {}),
      ...(patch.postClassification !== undefined
        ? { postClassification: { ...post.postClassification, ...patch.postClassification } }
        : {}),
      ...(patch.location !== undefined ? { location: patch.location ?? undefined } : {}),
      // Carried onto the in-memory record so the response this request hydrates
      // already shows the correction it just made. Without it the marker appears
      // only on the NEXT read of the post.
      ...(correction
        ? { correctionCount: correction.correctionCount, lastCorrectedAt: correction.correctedAt }
        : {}),
      content,
      mentions: nextMentions,
    };

    if (collaboratorIds && collaboratorIds.length > 0) {
      edited = await postCollaborationService.attachCollaborators(edited, userId, collaboratorIds);
    }

    const isPublished = edited.status === 'published';
    if (isPublished && collaboratorIds && collaboratorIds.length > 0) {
      const autoAcceptIds = await resolveMcpAutoAcceptIds(req, collaboratorIds);
      if (autoAcceptIds && autoAcceptIds.length > 0) {
        edited = await postCollaborationService.autoAcceptInvites(edited, new Set(autoAcceptIds));
      }
      await postCollaborationService.notifyPendingInvites(edited, userId);
    }

    // MTN dual-write: an edit re-emits the `app.mention.feed.post` record under
    // the SAME rkey (the post id). The chain is append-only and materialization
    // is last-writer-wins by chain order, so the new record supersedes the old
    // version. Only LOCAL posts emit (an edited federated post never had a record;
    // the 30-minute edit window above only applies to owner-scoped native posts).
    if (edited.federation == null && edited.oxyUserId) {
      await emitPostCreated(edited);
    }

    // Outbound federation: an edit re-federates the Note as an ActivityPub
    // Update (carrying an `updated` timestamp — how Mastodon marks an edit),
    // reusing the shared Note builder so a reply's `inReplyTo` + parent Mention
    // survive. Local + published + public non-boost only; the same gates as
    // creation. Username resolved server-side from the authoritative oxyUserId.
    //
    // The whole DOCUMENT goes through the seam. The Note builder reads more than
    // `LocalPostEventPayload` names — `metadata.isSensitive` becomes the Note's
    // `sensitive` flag, `quoteOf` its quote fields — so a hand-picked field list
    // re-federated an edited sensitive post as UNMARKED and dropped the quote,
    // which is the shape `PostCreationService` has always avoided by passing the
    // document.
    if (
      edited.federation == null &&
      edited.oxyUserId &&
      !edited.boostOf &&
      edited.visibility === PostVisibility.PUBLIC &&
      edited.status === 'published'
    ) {
      const editorOxyUserId = edited.oxyUserId;
      federateAsResolvedActor(editorOxyUserId, 'post update', (username) => ({
        kind: 'post.update',
        post: toFederationPostPayload(edited),
        actorOxyUserId: editorOxyUserId,
        actorUsername: username,
      }));
    }

    // Hydrate the updated post for consistent frontend response shape.
    // PostHydrationService is the single source of truth for post DTOs; we do NOT
    // hand-build a `user` object here (that would leak the raw oxyUserId as the
    // display name and break the profile-identity contract). If hydration fails
    // for this just-saved, owner-scoped post, treat it as a server-side error.
    const hydrated = await postHydrationService.hydratePosts([edited], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      // `postManagementRefusal` above already let this caller edit the post, and
      // a scheduled one is still withheld after the edit — so without the same
      // authority answer here the write succeeds and the response is a 500 to
      // the person who made it.
      operatedAccountReader: createUserScopedOxyServices(req),
    });
    if (hydrated.length === 0) {
      logger.error('Failed to hydrate edited post', { postId: edited.id, userId });
      return res.status(500).json({ message: 'Error updating post' });
    }
    res.json(hydrated[0]);
  } catch (error) {
    if (error instanceof CollabValidationError) {
      return res.status(400).json({ message: error.message });
    }
    if (error instanceof CollabStateError) {
      return res.status(400).json({ message: error.message });
    }
    logger.error('Error updating post', error);
    res.status(500).json({ message: 'Error updating post' });
  }
};
