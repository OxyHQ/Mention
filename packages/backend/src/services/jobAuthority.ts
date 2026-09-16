/**
 * "May this person manage jobs published under that employer account" — the
 * one gate every job-mutating route and MCP tool goes through.
 *
 * Layers exactly one restriction on top of {@link assertCanPublishAsAccount}:
 * the employer must be an `organization` or `project` account
 * ({@link MENTION_JOB_ELIGIBLE_EMPLOYER_KINDS}, issue #952's v1 eligibility
 * table). `assertCanPublishAsAccount` alone would also admit `channel` and
 * `bot`, which the issue explicitly excludes from authoring jobs.
 *
 * Deliberately NOT a new authority mechanism: reusing `assertCanPublishAsAccount`
 * means "removing organization authority immediately removes job-management
 * authority" (an acceptance criterion) is true for free — it is a LIVE read of
 * Oxy account membership on every call, never a cached flag on the job row.
 */

import { MENTION_JOB_ELIGIBLE_EMPLOYER_KINDS } from '@mention/shared-types';
import {
  assertCanPublishAsAccount,
  PublishAsAccessError,
  type AccountMemberReader,
  type PublishAsAuthor,
} from './publishAsAccount';

/**
 * Refuse unless `callerId` currently has authority to manage jobs published
 * under `employerOxyUserId`.
 *
 * The refusals:
 *  - **400** — `employerOxyUserId` is missing, or resolves to an account kind
 *    that may never author a job (`personal`, `channel`, `bot`, or unknown).
 *  - **403** — no client to ask with, or the caller is not an authorized
 *    operator of that employer account.
 *  - **503** — Oxy could not answer; see {@link assertCanPublishAsAccount}'s
 *    docblock on why that fails closed rather than open.
 */
export async function assertCanManageJob(params: {
  employerOxyUserId: string | null | undefined;
  callerId: string | null | undefined;
  memberReader: AccountMemberReader | undefined;
}): Promise<PublishAsAuthor> {
  const employerOxyUserId = params.employerOxyUserId?.trim();
  if (!employerOxyUserId) {
    throw new PublishAsAccessError(400, 'employerOxyUserId is required');
  }

  const author = await assertCanPublishAsAccount({
    publishAsOxyUserId: employerOxyUserId,
    callerId: params.callerId,
    memberReader: params.memberReader,
  });

  // `assertCanPublishAsAccount` treats naming the CALLER'S OWN account as
  // naming none (`authorKind: null`) — but a personal account can never be a
  // job's employer, so that shortcut must not let one through here.
  const eligibleKinds: readonly string[] = MENTION_JOB_ELIGIBLE_EMPLOYER_KINDS;
  if (!author.authorKind || !eligibleKinds.includes(author.authorKind)) {
    throw new PublishAsAccessError(
      400,
      'Only an organization or project account may publish a job',
    );
  }

  return author;
}
