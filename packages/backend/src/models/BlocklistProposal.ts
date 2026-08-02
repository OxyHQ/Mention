import mongoose, { Schema } from 'mongoose';
import type { BlockSeverity } from '../scripts/reportFederationBlocklistCandidates';

/**
 * ONE ROW PER DOMAIN: what the scheduled blocklist intelligence has proposed for
 * review, and what a person decided about it.
 *
 * WHAT THIS IS NOT
 *   It is NOT a blocklist, and nothing reads it to decide what to federate with.
 *   The blocklist is `connectors/activitypub/federationBlockPolicy` — a
 *   committed source file with a diff, an author and a review — plus the
 *   `FEDERATION_BLOCKED_DOMAINS` emergency lever. A row here is a note asking a
 *   person to consider writing one of those entries; the writing is manual, by
 *   design, and no runtime path can perform it. That separation is the whole
 *   reason this collection exists rather than an auto-sync: adopting another
 *   instance's list wholesale would make THEIR moderation silently OURS, and
 *   would make our transparency page — which states that corroboration is not
 *   the decision — false.
 *
 * WHY IT IS DURABLE STATE AND NOT JUST A LOG LINE
 *   A report that re-lists everything it has ever seen gets ignored, and an
 *   ignored report is exactly the rot this is meant to prevent. Suppressing what
 *   a person has already rejected requires REMEMBERING the rejection, so the
 *   decline — with its author and its reason — is the load-bearing field here.
 *   It doubles as the audit trail for why we do NOT block something, which
 *   nothing else in the repository records.
 *
 * THE STATES, AND WHO MOVES THEM
 *   `open`     Corroborated by enough independent operators, awaiting a person.
 *              Set by the sweep. An open row is re-rendered every run until
 *              somebody acts, and carries `firstProposedAt` so a reviewer can
 *              see how long it has been waiting.
 *   `declined` A person looked at it and said no. Set ONLY by a person (through
 *              `scripts/reviewFederationBlocklistProposals`), never by the
 *              sweep, and never moved by the sweep afterwards. A declined domain
 *              is not proposed again, however many further operators block it —
 *              re-litigating a decision nobody asked to revisit is what makes a
 *              report ignorable. Reopening is available, and is a person's
 *              action too.
 *   `adopted`  The domain is now refused by our own policy, so there is nothing
 *              left to review. Observed by the sweep from `isBlockedDomain`,
 *              never authoritative: the policy file is. If the entry is later
 *              removed and the corroboration still stands, the row returns to
 *              `open`, which is correct — content can arrive during the window
 *              it was allowed.
 *   `lapsed`   The corroboration that raised it no longer holds (sources
 *              un-blocked it, or now disagree). Observed by the sweep; returns
 *              to `open` by itself if it is corroborated again. No person was
 *              involved either way, which is what distinguishes it from
 *              `declined`.
 */
export type BlocklistProposalStatus = 'open' | 'declined' | 'adopted' | 'lapsed';

export const BLOCKLIST_PROPOSAL_STATUSES: readonly BlocklistProposalStatus[] = [
  'open',
  'declined',
  'adopted',
  'lapsed',
];

/**
 * Mastodon's published severities, as a runtime list for the schema's enum.
 *
 * `satisfies` rather than a cast so the ONE authority for the vocabulary stays
 * the parser in `scripts/reportFederationBlocklistCandidates`: a severity added
 * there and not here fails to compile, instead of failing a document validation
 * in production months later.
 */
const SEVERITY_VALUES = {
  suspend: 'suspend',
  silence: 'silence',
  noop: 'noop',
} as const satisfies Record<BlockSeverity, BlockSeverity>;

export const PUBLISHED_BLOCK_SEVERITIES: readonly BlockSeverity[] = Object.values(SEVERITY_VALUES);

/**
 * One source's own published verdict, kept UNMERGED.
 *
 * `suspend` and `silence` are different decisions and a summariser must never
 * flatten them: a domain two operators merely SILENCE is not a suspend
 * candidate, and `noop` (listed, no action taken) corroborates nothing at all.
 * They are all stored so a reviewer sees what each operator actually said,
 * including the ones that argue against acting.
 */
export interface BlocklistProposalObservation {
  /** The instance that published it. */
  instance: string;
  /** Who operates that instance, per `connectors/activitypub/blocklistSourceRegistry`. */
  operator: string;
  severity: BlockSeverity;
  /** The reason that operator published, bounded and control-stripped upstream. */
  comment?: string;
  /** The instance published this block MASKED; the domain came from its digest. */
  resolvedFromDigest: boolean;
}

const observationSchema = new Schema<BlocklistProposalObservation>({
  instance: { type: String, required: true },
  operator: { type: String, required: true },
  severity: { type: String, required: true, enum: PUBLISHED_BLOCK_SEVERITIES },
  comment: { type: String },
  resolvedFromDigest: { type: Boolean, required: true },
}, { _id: false });

/**
 * What blocking this domain would cost US, measured against our own corpus.
 *
 * Carried onto the row so a reviewer can decide without re-running the census by
 * hand — which, needing a Mongo shell and a script invocation, they would not.
 */
export interface BlocklistProposalFootprint {
  /** `FederatedActor` rows we hold from that domain. */
  actors: number;
  /** Stored posts authored by those actors. */
  posts: number;
  /** Distinct LOCAL users with an accepted outbound follow to an account there. */
  localUsersFollowing: number;
  /** Distinct accounts there that some local user follows. */
  remoteActorsFollowed: number;
  /** Distinct LOCAL users an account there follows — they would lose a follower. */
  localUsersFollowed: number;
}

const footprintSchema = new Schema<BlocklistProposalFootprint>({
  actors: { type: Number, required: true },
  posts: { type: Number, required: true },
  localUsersFollowing: { type: Number, required: true },
  remoteActorsFollowed: { type: Number, required: true },
  localUsersFollowed: { type: Number, required: true },
}, { _id: false });

export interface IBlocklistProposal {
  /** Canonical domain, in the form the enforcement predicate compares against. */
  domain: string;
  status: BlocklistProposalStatus;
  /** When this domain first cleared the operator threshold. Never overwritten. */
  firstProposedAt: Date;
  /** The last sweep that still saw it corroborated. */
  lastSeenAt: Date;
  /** Distinct operators SUSPENDING it at the last sighting — the threshold value. */
  operatorCount: number;
  /**
   * One instance per suspending operator, sorted — exactly what a policy entry's
   * `corroboratingSources` takes.
   *
   * Held clean and transcribable on purpose: that field is published on the
   * transparency page as who independently reached the same decision, so it can
   * carry neither a count nor an annotation. Which of these were read directly
   * and which were recovered from a digest is in {@link observations}.
   */
  corroboratingSources: string[];
  /** Every operator's own verdict at the last sighting, unmerged. */
  observations: BlocklistProposalObservation[];
  footprint: BlocklistProposalFootprint;
  /** When a person decided. Set with `declined`, cleared on reopen. */
  decidedAt?: Date;
  /** Who decided. Required for a decline: an audit record with no author is weak. */
  decidedBy?: string;
  /** Why. This is the record of why we do NOT block a corroborated domain. */
  decisionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const blocklistProposalSchema = new Schema<IBlocklistProposal>({
  domain: { type: String, required: true, unique: true },
  status: { type: String, required: true, enum: BLOCKLIST_PROPOSAL_STATUSES, default: 'open' },
  firstProposedAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
  operatorCount: { type: Number, required: true },
  corroboratingSources: { type: [String], required: true, default: [] },
  observations: { type: [observationSchema], required: true, default: [] },
  footprint: { type: footprintSchema, required: true },
  decidedAt: { type: Date },
  decidedBy: { type: String },
  decisionReason: { type: String },
}, { timestamps: true, collection: 'blocklistproposals' });

// The review queue, oldest first: a proposal nobody has answered for months is
// the one worth seeing at the top.
blocklistProposalSchema.index({ status: 1, firstProposedAt: 1 });

export const BlocklistProposal = mongoose.model<IBlocklistProposal>(
  'BlocklistProposal',
  blocklistProposalSchema,
);

export default BlocklistProposal;
