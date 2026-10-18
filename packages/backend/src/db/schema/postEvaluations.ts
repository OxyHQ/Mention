import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz } from '@oxy.so/db';
import { posts } from './posts';
import type { ShadowUsageReconciliation } from '../../services/contentClassification/jevReceipt';
import type { ShadowSignals } from '../../services/contentClassification/jevShadow';

export const POST_EVALUATION_STATES = [
  'claimed',
  'completed',
  'abstained',
  'cancelled',
  'cost_uncertain',
] as const;
export const POST_EVALUATION_FOLLOW_STATES = ['accepted', 'not_followed', 'unknown'] as const;
export const POST_EVALUATION_ABSTENTIONS = [
  'no_primary_text',
  'unknown_language',
  'unsupported_language',
] as const;

/** Shadow-only metadata. Never read by ranking, admission or canonical topics. */
export const postEvaluations = pgTable(
  'post_evaluations',
  {
    id: generatedId(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    fingerprint: text().notNull(),
    /** The model the request pinned; NULL when Oxy's decisions profile chose. */
    model: text(),
    /** The model that answered; set, and required, once the row is completed. */
    resolvedModel: text(),
    /** The routing policy that served the answer, from the response; NULL until completed. */
    policyRef: text(),
    policyVersion: integer(),
    evaluationVersion: text().notNull(),
    state: text({ enum: POST_EVALUATION_STATES }).notNull(),
    abstention: text({ enum: POST_EVALUATION_ABSTENTIONS }),
    followState: text({ enum: POST_EVALUATION_FOLLOW_STATES }).notNull().default('unknown'),
    languages: text().array(),
    sdkReceipt: jsonb().$type<ShadowSignals['sdkReceipt']>(),
    /**
     * Historical: the approval lineage of the 2026-10 one-post runs. The
     * continuous lane leaves it NULL; Kaana reads back only Mention's own
     * records, so a claim needs no recorded authority.
     */
    receiptAuthority: jsonb().$type<Record<string, unknown>>(),
    requestDeadlineAt: timestamptz(),
    usageReconciliation: jsonb().$type<ShadowUsageReconciliation>(),
    languageEvidence: jsonb().$type<ShadowSignals['languageEvidence']>(),
    spam: doublePrecision(),
    repetition: doublePrecision(),
    feedValue: doublePrecision(),
    createdAt: createdAt(),
    finishedAt: timestamptz(),
  },
  (table) => [
    unique('post_evaluations_revision_version_key').on(
      table.postId,
      table.fingerprint,
      table.evaluationVersion,
    ),
    index('post_evaluations_post_idx').on(table.postId),
    index('post_evaluations_created_idx').on(table.createdAt),
    check(
      'post_evaluations_state_check',
      sql`${table.state} in (${sql.raw(inList(POST_EVALUATION_STATES))})`,
    ),
    check(
      'post_evaluations_follow_check',
      sql`${table.followState} in (${sql.raw(inList(POST_EVALUATION_FOLLOW_STATES))})`,
    ),
    check(
      'post_evaluations_abstention_check',
      sql`${table.abstention} in (${sql.raw(inList(POST_EVALUATION_ABSTENTIONS))})`,
    ),
    check('post_evaluations_policy_version_check', sql`${table.policyVersion} > 0`),
    check(
      'post_evaluations_scores_check',
      sql`${table.spam} between 0 and 1 and ${table.repetition} between 0 and 1 and ${table.feedValue} between 0 and 1`,
    ),
    check(
      'post_evaluations_result_check',
      sql`(
    ${table.state} = 'completed' and ${table.spam} is not null and ${table.repetition} is not null
    and ${table.feedValue} is not null and ${table.languages} is not null
    and ${table.sdkReceipt} is not null and ${table.languageEvidence} is not null
    and ${table.resolvedModel} is not null and ${table.policyRef} is not null
    and ${table.policyVersion} is not null
    and ${table.abstention} is null and ${table.finishedAt} is not null
  ) or (
    ${table.state} <> 'completed' and ${table.spam} is null and ${table.repetition} is null
    and ${table.feedValue} is null and ${table.languages} is null
    and ${table.sdkReceipt} is null and ${table.languageEvidence} is null
    and ((${table.state} = 'abstained' and ${table.abstention} is not null)
      or (${table.state} <> 'abstained' and ${table.abstention} is null))
  )`,
    ),
  ],
);

export const postEvaluationTopics = pgTable(
  'post_evaluation_topics',
  {
    id: generatedId(),
    evaluationId: text()
      .notNull()
      .references(() => postEvaluations.id, { onDelete: 'cascade' }),
    topic: text().notNull(),
    probability: doublePrecision().notNull(),
  },
  (table) => [
    unique('post_evaluation_topics_evaluation_topic_key').on(table.evaluationId, table.topic),
    check('post_evaluation_topics_probability_check', sql`${table.probability} between 0 and 1`),
  ],
);
