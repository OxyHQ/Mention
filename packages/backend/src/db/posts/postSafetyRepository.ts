import { inArray } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { postSafetyAssessments } from '../schema/postSafety';
import { POST_SAFETY_ASSESSMENT_VERSION } from '../../services/contentClassification/safetyAssessment';

/** Only the trusted classification worker writes this table; no request input reaches it. */
export async function savePostSafetyAssessment(
  input: {
    postId: string;
    materialDigest: string;
    rating: typeof postSafetyAssessments.$inferInsert.rating;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const values = {
    ...input,
    assessmentVersion: POST_SAFETY_ASSESSMENT_VERSION,
    assessedAt: new Date(),
  };
  await db
    .insert(postSafetyAssessments)
    .values(values)
    .onConflictDoUpdate({ target: postSafetyAssessments.postId, set: values });
}

export type PostSafetyAssessments = Map<string, typeof postSafetyAssessments.$inferSelect>;

/** One bounded local lookup for a hydrated graph, no per-post remote lookups. */
export async function loadPostSafetyAssessments(
  ids: readonly string[],
): Promise<PostSafetyAssessments> {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return new Map<string, typeof postSafetyAssessments.$inferSelect>();
  const rows = await getDb()
    .select()
    .from(postSafetyAssessments)
    .where(inArray(postSafetyAssessments.postId, uniqueIds));
  return new Map(rows.map((row) => [row.postId, row]));
}
