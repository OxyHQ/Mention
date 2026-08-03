/**
 * The seam that makes this integration copyable.
 *
 * §5 opens by naming the mistake to avoid: designing moderation around `post`,
 * `comment`, `room` or `product`. CrowdSource's side of that is already solved —
 * the Case Envelope knows nothing about any of them, and `@oxyhq/crowdsource`
 * composes one from a description of the material. What is left for an
 * application is a translation problem, and this file is the whole of it:
 *
 *     "given one of MY nouns and its id, describe the material"
 *
 * Everything downstream — digests, resource ids, relations, principal bindings,
 * the binding proof, the policy version, privacy terms, the idempotency key, the
 * envelope itself — is composed by the SDK from that description and is
 * IDENTICAL for every application and every subject type. So adding a subject
 * type is one file implementing {@link ModerationSubjectProvider} plus one line
 * in the registry. Mercaria's `commerce.listing` and Homiio's `commerce.listing`
 * are each a provider; neither touches the outbox, the delivery worker, the
 * webhook receiver, the decision worker or the enforcement service.
 *
 * Two rules keep it that way, and both are load-bearing rather than stylistic:
 *
 * 1. **A provider returns a DESCRIPTION, never an envelope.** The types below are
 *    the SDK's own input types, re-exported unchanged. A provider that built an
 *    envelope would have to invent resource ids and principal refs, and §7.3's
 *    dedup key is computed over exactly those — two reporters describing one post
 *    would open two cases, and "one penalty per incident" would fail in
 *    production with nothing failing in a test.
 * 2. **A provider is pure translation with reads.** It fetches its own object and
 *    returns; it does not decide whether to deliver, what the allegation is, or
 *    what happens to the report. Those belong to callers that are shared.
 */

import type { ContextInput, ReportSubjectInput, ResourceInput } from '@oxyhq/crowdsource';

/**
 * The SDK's resource description, unchanged.
 *
 * Re-exported as a type alias so a provider imports the vocabulary from this
 * seam rather than from four places — but it IS the SDK's type, not a local
 * restatement of it. A resource type added to the contract becomes available to
 * every provider the moment the dependency is bumped.
 */
export type ModerationResource = ResourceInput;
export type ModerationContextResource = ContextInput;

/**
 * One reported object, described.
 *
 * `content` is required because a report with no material is a question a jury
 * cannot answer. An application that cannot produce the material for one of its
 * nouns should not register a provider for it — see the registry.
 */
export interface ModerationSubjectSnapshot {
  /** Identity, type and author of the reported object (§5.1 `subject`). */
  readonly subject: ReportSubjectInput;
  /** The reported material itself. A string is shorthand for plain text. */
  readonly content: string | ModerationResource;
  /** Media carried BY the subject. */
  readonly attachments?: readonly ModerationResource[];
  /**
   * Surrounding material a jury needs to judge fairly — the parent of a reply,
   * the post a quote is about. Context, not extra exposure: §9.1 keeps a
   * reviewer's view to the minimum that makes the question answerable.
   */
  readonly context?: readonly ModerationContextResource[];
  /**
   * SHA-256 of the exact representation being reviewed, stored on the local
   * report so a decision about an older version stays identifiable as such
   * (§5.6). Computed by `EvidenceSnapshotService`, not by the provider — one
   * definition of "the hash of this snapshot" for every subject type.
   */
  readonly snapshotHash?: string;
}

/**
 * Translates one of the application's nouns into universal material.
 *
 * `subjectType` is declared on the provider rather than returned per snapshot
 * because it is a property of the noun (§5.4): every Mention post is a
 * `social.post`, every Mercaria product a `commerce.listing`. Keeping it here
 * means the registry can answer "what does this application report?" without
 * loading a single object.
 */
export interface ModerationSubjectProvider {
  /** The application's own name for the noun, as it arrives on a report. */
  readonly reportedType: string;
  /** §5.4's namespaced subject type, or `custom.<organization>.<object_type>`. */
  readonly subjectType: string;
  /**
   * Describes the object for the reporter, or returns `null` when it no longer
   * exists or cannot safely be disclosed to that reporter.
   *
   * `null` is not a failure. Content deleted between the report and its delivery
   * is ordinary, and it is the caller's job to decide what that means — a
   * provider that threw would make deletion look like an outage and be retried
   * for days.
   */
  snapshot(reportedId: string, reporterId?: string): Promise<ModerationSubjectSnapshot | null>;
}
