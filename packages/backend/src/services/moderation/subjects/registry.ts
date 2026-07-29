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
 * ## This list is also an ownership boundary, not just a capability list
 *
 * Mention may only report objects Mention OWNS. That is a tenancy constraint, and
 * it is stricter than "can we produce a snapshot":
 *
 * `applicationId` is read off the service credential, so a report Mention submits
 * opens a case in MENTION's tenant. A case about a Syra live room would therefore
 * sit in Mention's tenant describing an object Mention cannot snapshot and cannot
 * enforce against — enforcement would have to happen in Syra, which never receives
 * the decision. Worse, when Syra reports the same room under its own credential,
 * §7.3's dedup key (`applicationId + subjectExternalId + contentHash + policyVersion`)
 * differs by tenant, so the same incident opens a SECOND case with a second jury and
 * a second consequence. "One decision per incident" is an invariant, and a
 * cross-application report breaks it at the tenancy layer where no amount of
 * care inside Mention can repair it.
 *
 * So a report for an object Mention does not own is refused at the API (see
 * `routes/reports.routes.ts`), not stored in a terminal state. Cross-application
 * hand-off is a real design question, and the honest answer is that the plan does
 * not answer it yet.
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

/** The provider for a reported type, or `undefined` when it is not deliverable. */
export function subjectProviderFor(
  reportedType: string,
): ModerationSubjectProvider | undefined {
  return BY_REPORTED_TYPE.get(reportedType);
}

/**
 * Whether Mention may accept a report about this kind of object.
 *
 * The single authority, consulted by `POST /reports` before anything is stored. A
 * type absent from the registry is refused, so no report can enter the pipeline
 * without a route through it.
 */
export function isReportableType(reportedType: string): boolean {
  return BY_REPORTED_TYPE.has(reportedType);
}

/** The types a client may report, for the API's own error message. */
export function reportableTypes(): string[] {
  return Array.from(BY_REPORTED_TYPE.keys());
}
