import { ReportedType } from '../../../models/Report.model';
import { createPostSubjectProvider } from './postSubject';
import { createUserSubjectProvider } from './userSubject';
import type { ModerationSubjectProvider } from './types';

/**
 * Every noun Mention can send for review, and the §5.4 type each one is.
 *
 * Adding a subject type is one entry here plus one provider file. Nothing else in
 * the integration knows what a post is — not the outbox, not the delivery worker,
 * not the webhook receiver, not the enforcement service.
 *
 * ## This list decides DELIVERY, and nothing else
 *
 * A reported type with a provider here is sent to CrowdSource. A reported type
 * WITHOUT one is still accepted by `POST /reports` and still stored — it simply never
 * leaves. The registry is not an admission gate on the API, and making it one was
 * tried and reverted, because a gate that refuses unwired types means every
 * application breaks its own existing report surfaces on the day it adopts
 * CrowdSource. Incremental adoption, one subject type at a time, is the property that
 * makes this integration copyable to the other Oxy apps at all.
 *
 * ## Why a live room has no provider, and would not gain one by trying harder
 *
 * Mention owns the room EXPERIENCE but stores no Room document — there is no row to
 * load, no text, no author, nothing §5.6 could pin as "the exact version reported".
 * The only material a live audio room has is its audio, and capturing that is a
 * privacy decision far larger than this integration.
 *
 * There is also a tenancy argument, and it is worth stating because it survives even
 * if a Room document appeared: `applicationId` is read off the service credential, so
 * a report Mention submits opens a case in MENTION's tenant. A case about a room whose
 * sanction would have to be carried out in Syra names an object Mention cannot enforce
 * against, and when Syra reports the same room under its own credential §7.3's dedup
 * key (`applicationId + subjectExternalId + contentHash + policyVersion`) differs by
 * tenant — so one incident opens two cases, two juries and two consequences, breaking
 * "one decision per incident" at a layer nothing inside Mention can repair.
 *
 * Both arguments point at the same conclusion, which is a MISSING PROVIDER rather than
 * a refused report: cross-application hand-off is a real design question and the plan
 * does not answer it yet, so the report stays local until it does.
 */
const PROVIDERS: readonly ModerationSubjectProvider[] = Object.freeze([
  createPostSubjectProvider({
    reportedType: ReportedType.POST,
    subjectType: 'social.post',
  }),
  // A Mention comment is a post with a parent. Same loader, different §5.4 label —
  // the taxonomy a jury reasons about is the universal one, not Mention's schema.
  createPostSubjectProvider({
    reportedType: ReportedType.COMMENT,
    subjectType: 'social.comment',
  }),
  createUserSubjectProvider(),
]);

const BY_REPORTED_TYPE: ReadonlyMap<string, ModerationSubjectProvider> = new Map(
  PROVIDERS.map((provider) => [provider.reportedType, provider]),
);

/**
 * The provider for a reported type, or `undefined` when it is not deliverable.
 *
 * The single authority on whether a report leaves this deployment. `ReportIntakeService`
 * asks before queueing a delivery, and `EvidenceSnapshotService` asks again when it
 * builds one; a type this returns `undefined` for is stored and never enqueued.
 */
export function subjectProviderFor(
  reportedType: string,
): ModerationSubjectProvider | undefined {
  return BY_REPORTED_TYPE.get(reportedType);
}

/**
 * The reported types wired to CrowdSource, as the registry itself sees them.
 *
 * Exists so a test can pin the set (`reportsAcceptedTypes.test.ts`). That is not
 * ceremony: the difference between a delivered type and a local-only one is invisible
 * in a 201, so registering a provider — or forgetting to — is a change no response
 * body would reveal. The assertion makes widening the delivered surface a deliberate
 * act with an argument attached.
 */
export function deliverableTypes(): string[] {
  return Array.from(BY_REPORTED_TYPE.keys());
}
