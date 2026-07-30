import mongoose from 'mongoose';
import { createModerationIntegration } from '@oxyhq/crowdsource-app';
import type { ModerationIntegration } from '@oxyhq/crowdsource-app';
import type { ModerationEnforcementAction } from '@mention/shared-types';
import { config } from '../../config';
import Post from '../../models/Post';
import Report, { type IReport } from '../../models/Report.model';
import { logger } from '../../utils/logger';
import { REPORT_TAXONOMY_VERSION, allegationsForCategories } from './reportTaxonomy';
import { createPostSubjectProvider } from './subjects/postSubject';
import { createUserSubjectProvider } from './subjects/userSubject';
import { ReportedType } from '../../models/Report.model';

/**
 * Mention's four answers to `@oxyhq/crowdsource-app`.
 *
 * The package owns the six problems every application shares — atomic intake,
 * delivery with retries and a dead-letter path, a webhook receiver that reads raw
 * bytes, cross-task dedupe, revision ordering, and idempotent reversible
 * consequences. What is left here is only what is Mention's: which nouns it can
 * describe, what its categories mean, what its levers are, and what pulling one
 * does to a `Post`.
 *
 * A factory rather than a module-level singleton because the package registers
 * its models on the connection it is GIVEN. Taking `mongoose.connection` at
 * import time would bind the collections before the app connects.
 */

const POST_SUBJECT_TYPES = new Set(['social.post', 'social.comment']);

/**
 * What `apply` may record for a later reversal. Scalars only — the package stores
 * it on the enforcement row and hands it back to whichever action reverses this
 * one, so it has to survive a round trip through Mongo unchanged.
 *
 * Annotated at each return rather than inferred, because TypeScript otherwise
 * unions the four branches into a shape carrying `metadataIsSensitive?: undefined`,
 * which is not assignable to a `Record` of scalars.
 */
type EffectPreviousState = Readonly<Record<string, string | number | boolean | null>>;

interface PostState {
  status?: string;
  metadata?: { isSensitive?: boolean };
}

async function loadPostState(postId: string): Promise<PostState | null> {
  if (!mongoose.isValidObjectId(postId)) return null;
  return await Post.findById(postId)
    .select('status metadata.isSensitive')
    .lean<PostState | null>();
}

/**
 * Build the integration against a live connection.
 *
 * `restoreAction: 'restore'` is what makes `no_violation` ALWAYS plan a restore,
 * which is the guard against an accepted appeal leaving a post removed forever.
 *
 * `reverses` maps each reversal to what it undoes, so the package hands `apply`
 * the most recent APPLIED row rather than making this file re-query the ledger —
 * which is where the `applied: true` filter lives, and re-implementing it here
 * would be one more chance to omit it.
 */
export function createMentionModerationIntegration(): ModerationIntegration<
  IReport,
  ModerationEnforcementAction
> {
  return createModerationIntegration<IReport, ModerationEnforcementAction>({
    connection: mongoose.connection,
    crowdSource: config.crowdSource,
    reportModel: Report,
    /**
     * Delivery, and nothing else. A type with no provider here is still accepted
     * and still stored — it simply never leaves, which is the behaviour Mention
     * had before CrowdSource existed. `room` is the live case.
     */
    subjects: [
      createPostSubjectProvider({
        reportedType: ReportedType.POST,
        subjectType: 'social.post',
      }),
      createPostSubjectProvider({
        reportedType: ReportedType.COMMENT,
        subjectType: 'social.comment',
      }),
      createUserSubjectProvider(),
    ],
    taxonomy: {
      version: REPORT_TAXONOMY_VERSION,
      allegationsFor: allegationsForCategories,
    },
    enforcement: {
      actions: [
        'none',
        'restrict',
        'restore',
        'label_sensitive',
        'unlabel_sensitive',
        'manual_review',
      ],
      noneAction: 'none',
      reviewAction: 'manual_review',
      restoreAction: 'restore',
      recommendationToAction: {
        remove: 'restrict',
        remove_or_restrict: 'restrict',
        hide: 'restrict',
        label: 'label_sensitive',
        allow_with_label: 'label_sensitive',
        age_gate: 'label_sensitive',
        reduce_distribution: 'label_sensitive',
        allow: 'none',
        no_action: 'none',
        no_global_effect: 'none',
        restore: 'restore',
      },
      /**
       * `critical` goes to a human rather than straight to removal: §7.5 routes
       * that material to a specialist team under legal protocol, and an automatic
       * effect driven by a webhook is not that.
       */
      severityFallback: {
        critical: 'manual_review',
        high: 'restrict',
        medium: 'label_sensitive',
        low: 'manual_review',
      },
      absorb: { restrict: ['label_sensitive', 'none', 'restore'] },
      reversibleActions: ['restore', 'unlabel_sensitive'],
      reverses: {
        restore: 'restrict',
        unlabel_sensitive: 'label_sensitive',
      },
      apply: async ({ action, subject, previousState }) => {
        if (!POST_SUBJECT_TYPES.has(subject.type)) {
          /**
           * A reported ACCOUNT is not Mention's to suspend — Oxy owns accounts,
           * and reaching into another product's user state is what the one-way
           * reputation rule forbids. Recorded for a human.
           */
          return {
            changed: false,
            reason: `Mention has no '${action}' effect for a reported ${subject.type}`,
          };
        }

        const current = await loadPostState(subject.id);
        if (!current) {
          return { changed: false, reason: 'The reported post no longer exists' };
        }

        switch (action) {
          case 'restrict': {
            if (current.status === 'restricted') {
              return { changed: false, reason: 'The post was already restricted' };
            }
            await Post.updateOne({ _id: subject.id }, { $set: { status: 'restricted' } });
            const restrictedFrom: EffectPreviousState = {
              postStatus: current.status ?? 'published',
            };
            return { changed: true, previousState: restrictedFrom };
          }

          case 'restore': {
            if (current.status !== 'restricted') {
              return { changed: false, reason: 'The post was not restricted' };
            }
            /**
             * Restored to what it WAS, off the row that restricted it — not to a
             * hardcoded `published`. A draft that was somehow restricted must not
             * be published by a correction. The package supplies that row.
             */
            const restoreTo = previousState?.postStatus ?? 'published';
            await Post.updateOne({ _id: subject.id }, { $set: { status: restoreTo } });
            const restoredFrom: EffectPreviousState = { postStatus: 'restricted' };
            return { changed: true, previousState: restoredFrom };
          }

          case 'label_sensitive': {
            if (current.metadata?.isSensitive === true) {
              return { changed: false, reason: 'The post already carried a content warning' };
            }
            await Post.updateOne(
              { _id: subject.id },
              { $set: { 'metadata.isSensitive': true } },
            );
            const labelledFrom: EffectPreviousState = { metadataIsSensitive: false };
            return { changed: true, previousState: labelledFrom };
          }

          case 'unlabel_sensitive': {
            /**
             * Only lifted if MODERATION set it. An author's own content warning is
             * theirs, and a correction that removed it would be a moderation action
             * nobody asked for — invisible until the post reappeared in discovery.
             * `previousState` is present exactly when a `label_sensitive` row was
             * applied, so its absence IS the "moderation never set it" answer.
             */
            if (previousState === undefined) {
              return {
                changed: false,
                reason: 'The content warning was not set by moderation',
              };
            }
            if (current.metadata?.isSensitive !== true) {
              return { changed: false, reason: 'The post carried no content warning' };
            }
            await Post.updateOne(
              { _id: subject.id },
              { $set: { 'metadata.isSensitive': false } },
            );
            const unlabelledFrom: EffectPreviousState = { metadataIsSensitive: true };
            return { changed: true, previousState: unlabelledFrom };
          }

          default:
            return {
              changed: false,
              reason: `'${action}' is recorded, never executed by Mention`,
            };
        }
      },
    },
    logger,
  });
}
