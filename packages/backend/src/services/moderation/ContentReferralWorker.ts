// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { config } from '../../config';
import { findReportById } from '../../db/moderation/reportRepository';
import type { ModerationOutboxEvent } from '../../db/moderation/moderationOutboxRepository';
import { getRuntimeOxyClient } from '../../runtime/oxyClient';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';
import { ModerationDeliveryRejectedError } from './ModerationDeliveryWorker';
import { MAX_EVIDENCE_ITEMS } from './reportEvidence';
import { subjectProviderFor } from './subjects/registry';

/**
 * Referring content to Oxy's claim review (oxy ADR 0043 D14).
 *
 * Material that may sexualise or exploit a minor is never put before a jury:
 * CrowdSource routes it to its legal pool and publishes no decision (§7.5), and
 * §7.6 leaves the legal queue to the application. Mention's legal queue is
 * Oxy's own reviewed takedown, so this hands the content to it and does nothing
 * else.
 *
 * It does NOT restrict the post. One report must not take content down, and a
 * critical finding is a decision with legal weight that a person makes
 * (`enforcementPlan.ts` says the same of `critical`). If Oxy's staff block the
 * files, Mention learns through `file.blocked`, like any other takedown.
 *
 * Nothing about the reporter is sent: a referral names the files and the page,
 * and Oxy keeps no claimant for it.
 *
 * Idempotent at Oxy (the same reason and targets answer with the claim already
 * open), so the two callers below can both retry freely.
 */

/** The noun and id of what is referred: a report's subject, or a decision's. */
export interface ReferralSubject {
  type: string;
  id: string;
}

export type ReferralOutcome =
  | { referred: true; reference: string }
  | { referred: false; reason: string };

/** Where a reader sees a post or a comment: the page a reviewer is pointed at. */
function pageUrlOf(subject: ReferralSubject): string | undefined {
  if (subject.type !== 'post' && subject.type !== 'comment') return undefined;
  const base = (config.frontendUrl ?? 'https://mention.earth').replace(/\/$/, '');
  if (!base.startsWith('https://')) return undefined;
  return `${base}/p/${encodeURIComponent(subject.id)}`;
}

/** The ids Oxy said it does not hold, from its refusal of a referral. */
function unknownFileIds(error: unknown): string[] | undefined {
  const candidate = error as {
    code?: unknown;
    details?: { fileIds?: unknown };
    response?: { data?: { code?: unknown; details?: { fileIds?: unknown } } };
  } | null;
  const body = candidate?.response?.data ?? candidate;
  if (body?.code !== 'CONTENT_REFERRAL_UNKNOWN_FILES') return undefined;
  const ids = body.details?.fileIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Refer one of Mention's nouns to Oxy for child safety.
 *
 * The files are the subject's own media, as a reader sees it; the page is where
 * it is shown. A media item that is not an Oxy file (a federated one the cache
 * never re-hosted) is one Oxy says it does not hold: it is dropped and the
 * referral is sent again with the rest, because the page still names the
 * content. A subject that no longer exists, or that Mention has no provider
 * for, is not referred, and the reason is returned for the record.
 */
export async function referSubjectForChildSafety(
  subject: ReferralSubject,
  reporterId?: string,
): Promise<ReferralOutcome> {
  const provider = subjectProviderFor(subject.type);
  if (!provider) {
    return { referred: false, reason: `Mention cannot describe a reported ${subject.type}` };
  }
  const snapshot = await provider.snapshot(subject.id, reporterId);
  if (snapshot === null) {
    return { referred: false, reason: 'The reported content no longer exists' };
  }

  const pageUrl = pageUrlOf(subject);
  let fileIds = (snapshot.evidenceMedia ?? []).slice(0, MAX_EVIDENCE_ITEMS).map((item) => item.id);
  if (fileIds.length === 0 && pageUrl === undefined) {
    return { referred: false, reason: 'The reported content has no file and no public page' };
  }

  const oxy = getRuntimeOxyClient();
  const send = (ids: string[]) =>
    oxy.referContent({
      reason: 'child_safety',
      fileIds: ids,
      pageUrls: pageUrl === undefined ? [] : [pageUrl],
    });

  let answer: Awaited<ReturnType<typeof send>>;
  try {
    answer = await send(fileIds);
  } catch (error: unknown) {
    const unknown = unknownFileIds(error);
    if (unknown === undefined || unknown.length === 0) throw error;
    const missing = new Set(unknown);
    fileIds = fileIds.filter((id) => !missing.has(id));
    if (fileIds.length === 0 && pageUrl === undefined) {
      return { referred: false, reason: 'None of the reported media is a file Oxy holds' };
    }
    answer = await send(fileIds);
  }

  metrics.incrementCounter('oxy_content_referral_total', 1, { reason: 'child_safety' });
  logger.info('[Moderation] content referred to Oxy', {
    subjectType: subject.type,
    reference: answer.reference,
    files: fileIds.length,
  });
  return { referred: true, reference: answer.reference };
}

/**
 * `report.refer`: a report filed for child safety, referred as it is taken.
 *
 * Queued in the report's own transaction, so a report that was stored is a
 * referral that will be sent. A report that no longer exists has nothing to
 * refer; a subject that cannot be referred is logged and the event is done,
 * because retrying cannot change either.
 */
export async function referReportOutboxEvent(event: ModerationOutboxEvent): Promise<void> {
  const reportId = event.payload.reportId;
  if (reportId === undefined) {
    throw new ModerationDeliveryRejectedError('A report.refer event carried no reportId.');
  }
  const report = await findReportById(reportId);
  if (!report) {
    logger.warn('[Moderation] referral event has no report', { reportId });
    return;
  }
  const outcome = await referSubjectForChildSafety(
    { type: report.reportedType, id: report.reportedId },
    report.reporter,
  );
  if (!outcome.referred) {
    logger.warn('[Moderation] report not referred to Oxy', { reportId, reason: outcome.reason });
  }
}
