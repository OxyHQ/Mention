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

import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import type { AccountNode } from '@oxy.so/core';
import { MENTION_JOB_ELIGIBLE_EMPLOYER_KINDS } from '@mention/shared-types';
import {
  assertCanPublishAsAccount,
  membershipAuthorizesActingFor,
  PublishAsAccessError,
  type AccountMemberReader,
  type OperatedAccountReader,
  type PublishAsAuthor,
} from './publishAsAccount';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';

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

/**
 * The organization/project accounts this caller currently operates — the
 * employer set behind `GET /jobs/mine`.
 *
 * Same inversion as {@link listOperatedChannelIds} and for the same reason:
 * `GET /accounts/:id/members` is authorized against the CALLER, so there is no
 * way to ask "which organizations does this person operate" except the other
 * direction — `GET /accounts`, read with the caller's own bearer, returning
 * each account's `callerMembership` alongside it.
 *
 * Fail-soft to `[]`: an Oxy outage degrades the dashboard to "no jobs found"
 * rather than 500ing it, and it can never ADD an employer the caller does not
 * actually operate.
 */
export async function listOperatedJobEmployerIds(
  reader: OperatedAccountReader | undefined,
): Promise<string[]> {
  if (!reader) return [];
  let accounts: AccountNode[];
  try {
    accounts = await reader.listAccounts();
  } catch (error) {
    logger.warn('[jobAuthority] Failed to list operated accounts', error);
    return [];
  }
  const eligibleKinds: readonly string[] = MENTION_JOB_ELIGIBLE_EMPLOYER_KINDS;
  return accounts
    .filter(
      (node) =>
        eligibleKinds.includes(node.kind) &&
        membershipAuthorizesActingFor(node.kind, node.callerMembership),
    )
    .map((node) => node.accountId)
    .filter((accountId): accountId is string => Boolean(accountId));
}

/**
 * The shared employer-side authority gate every job controller answers a
 * response through. Wraps {@link assertCanManageJob}, answers the response
 * itself on refusal, and returns whether the caller may proceed — so every
 * call site reads `if (!authorized) return;` instead of repeating the
 * try/catch around `PublishAsAccessError`. Originally duplicated across
 * `jobs.controller.ts`, `jobsManagement.controller.ts`, `jobMetrics.controller.ts`
 * and `jobApplications.controller.ts`; consolidated here so the next change to
 * how a refusal is surfaced is one edit, not four kept in sync by hand.
 */
export async function requireEmployerAuthority(
  employerOxyUserId: string,
  req: AuthRequest,
  res: Response,
): Promise<boolean> {
  try {
    await assertCanManageJob({
      employerOxyUserId,
      callerId: req.user?.id,
      memberReader: createUserScopedOxyServices(req),
    });
    return true;
  } catch (error) {
    if (error instanceof PublishAsAccessError) {
      res.status(error.status).json({ error: error.message });
      return false;
    }
    throw error;
  }
}
