/**
 * WHO WE READ PUBLISHED BLOCKLISTS FROM, AND WHO ACTUALLY RUNS THOSE SITES.
 *
 * Corroboration is the entire product of the blocklist intelligence
 * (`scripts/reportFederationBlocklistCandidates.ts`): one instance blocking a
 * domain is that instance's opinion, several INDEPENDENT ones is a signal. That
 * distinction only holds if "independent" is measured — and it is measured
 * against this file.
 *
 * WHY THE MAPPING IS DECLARED RATHER THAN DERIVED
 *   There is no field that mechanically identifies an operator, which is exactly
 *   why this cannot be inferred:
 *     - `mastodon.social` and `mastodon.online` publish DIFFERENT contact
 *       mailboxes (`staff@mastodon.social` / `staff@mastodon.online`) and the
 *       SAME contact account (`@Mastodon@mastodon.social`). Keying on the
 *       mailbox misses the pair.
 *     - `universeodon.com` and `mastodonapp.uk` publish DIFFERENT accounts on
 *       their own hosts and the SAME mailbox (`support@mastodonapp.uk`). Keying
 *       on the account misses that pair instead.
 *     - `mstdn.social` (stux) and `mstdn.jp` (Sujitech) share a name prefix and
 *       nothing else. Keying on the hostname invents a pair that does not exist.
 *   So each row is a human assertion with the evidence that supports it written
 *   next to it, re-checkable by anyone against the instance's own
 *   `GET /api/v1/instance`. A count derived from this file is only as honest as
 *   the file is, and that is the property it is shaped to keep reviewable.
 *
 * WHAT THIS COST US WHEN IT WAS MISSING
 *   The first production run counted INSTANCES. 116 of its 196 candidates were
 *   "corroborated" by `mastodon.social` + `mastodon.online` alone — one
 *   moderation team, counted twice, clearing a threshold that exists precisely
 *   to stop that. The threshold is applied to OPERATORS now (see
 *   `services/federation/BlocklistProposalService`), and the committed policy's
 *   `corroboratingSources` names one instance per operator for the same reason:
 *   listing both halves of a pair would overstate what we found.
 *
 * WHAT IT STILL DOES NOT ESTABLISH
 *   Distinct operators are not necessarily distinct JUDGEMENTS — instances do
 *   import each other's lists wholesale, and nothing here can detect that. No
 *   threshold should be read as if it could. It is part of why the report only
 *   ever proposes, and why a person writes every entry and its public reason.
 *
 * ADDING A SOURCE
 *   Read `https://<instance>/api/v1/instance`, record the contact mailbox and
 *   contact account verbatim in `evidence`, and check both against every row
 *   already here before assigning an operator. Confirm the instance actually
 *   serves `/api/v1/instance/domain_blocks` (many do not — a non-publisher is a
 *   normal outcome the report handles, but it contributes nothing).
 */

/** One polled instance, and the assertion about who runs it. */
export interface BlocklistSourceInstance {
  /** Hostname polled for `GET /api/v1/instance/domain_blocks`. */
  readonly instance: string;
  /**
   * Stable id for the party that moderates it. Two instances sharing this value
   * corroborate each other ONCE.
   */
  readonly operator: string;
  /**
   * What was read from the instance's own `GET /api/v1/instance`, verbatim
   * enough to re-check. This is the whole basis of the `operator` above.
   */
  readonly evidence: string;
  /** `YYYY-MM-DD` — when a person last read that endpoint. */
  readonly checkedOn: string;
}

/**
 * The polled set. Every entry was confirmed on {@link checkedOn} to publish a
 * blocklist (all thirteen answered HTTP 200 with 228–1029 entries).
 *
 * Thirteen instances, ELEVEN operators: `mastodon.online` shares
 * `mastodon-gmbh` with `mastodon.social`, and `universeodon.com` shares
 * `mastodonapp-uk` with `mastodonapp.uk`. Both pairs are kept — dropping half of
 * one loses the entries only that half publishes — and both are collapsed when
 * corroboration is counted.
 *
 * ORDER IS LOAD-BEARING FOR A PAIR. When both instances of one operator publish
 * the same block, the one listed FIRST here is the name that represents that
 * operator in a proposal — and therefore in the `corroboratingSources` of any
 * policy entry written from it. Both published it, so either would be true;
 * naming the operator's principal site consistently is what keeps the published
 * list legible and its diffs stable. See {@link sourceRank}.
 */
export const BLOCKLIST_SOURCE_REGISTRY: readonly BlocklistSourceInstance[] = [
  {
    instance: 'mastodon.social',
    operator: 'mastodon-gmbh',
    evidence: 'contact staff@mastodon.social, contact account @Mastodon@mastodon.social',
    checkedOn: '2026-08-02',
  },
  {
    instance: 'mastodon.online',
    operator: 'mastodon-gmbh',
    evidence:
      'contact staff@mastodon.online, contact account @Mastodon@mastodon.social — the same account mastodon.social publishes',
    checkedOn: '2026-08-02',
  },
  {
    instance: 'mstdn.social',
    operator: 'stux',
    evidence: 'contact hello@mstdn.social, contact account @stux',
    checkedOn: '2026-08-02',
  },
  {
    instance: 'mas.to',
    operator: 'trumpet',
    evidence: 'contact trumpet@mas.to, contact account @trumpet',
    checkedOn: '2026-08-02',
  },
  {
    instance: 'infosec.exchange',
    operator: 'jerry',
    evidence: 'contact jerry@infosec.exchange, contact account @jerry',
    checkedOn: '2026-08-02',
  },
  {
    instance: 'kolektiva.social',
    operator: 'kolektiva',
    evidence: 'contact kolektiva@riseup.net, contact account @admin',
    checkedOn: '2026-08-02',
  },
  {
    instance: 'techhub.social',
    operator: 'techhub',
    evidence: 'contact techhubadmin@shl.ee, contact account @TechHubAdmin',
    checkedOn: '2026-08-02',
  },
  {
    instance: 'ohai.social',
    operator: 'ohai',
    evidence: 'contact support@ohai.social, contact account @ohai',
    checkedOn: '2026-08-02',
  },
  {
    instance: 'sfba.social',
    operator: 'sfba',
    evidence: 'contact support@sfba.social, contact account @moderators',
    checkedOn: '2026-08-02',
  },
  {
    instance: 'troet.cafe',
    operator: 'troet-cafe',
    evidence: 'contact helpdesk@troet.cafe, contact account @martinmuc',
    checkedOn: '2026-08-02',
  },
  {
    instance: 'mstdn.jp',
    operator: 'sujitech',
    evidence:
      'contact info@sujitech.com, contact account @mstdn_jp — unrelated to mstdn.social despite the name',
    checkedOn: '2026-08-02',
  },
  {
    instance: 'universeodon.com',
    operator: 'mastodonapp-uk',
    evidence:
      'contact support@mastodonapp.uk, contact account @wild1145 — the same mailbox mastodonapp.uk publishes',
    checkedOn: '2026-08-02',
  },
  {
    instance: 'mastodonapp.uk',
    operator: 'mastodonapp-uk',
    evidence: 'contact support@mastodonapp.uk, contact account @wild1145',
    checkedOn: '2026-08-02',
  },
];

/** Instance → operator, built once from the registry above. */
const OPERATOR_BY_INSTANCE: ReadonlyMap<string, string> = new Map(
  BLOCKLIST_SOURCE_REGISTRY.map((source) => [source.instance, source.operator]),
);

/**
 * The hostnames the intelligence report polls when no operator names others.
 *
 * Derived from the registry rather than written beside it, so a source can never
 * be polled without its operator having been declared.
 */
export const BLOCKLIST_SOURCE_INSTANCES: readonly string[] = BLOCKLIST_SOURCE_REGISTRY.map(
  (source) => source.instance,
);

/** The declared operator of an instance, or `null` when it is not registered. */
export function operatorOf(instance: string): string | null {
  return OPERATOR_BY_INSTANCE.get(instance.trim().toLowerCase()) ?? null;
}

/** Instance → its position in the registry. */
const RANK_BY_INSTANCE: ReadonlyMap<string, number> = new Map(
  BLOCKLIST_SOURCE_REGISTRY.map((source, index) => [source.instance, index]),
);

/**
 * Where an instance sits in the registry — lower is that operator's principal
 * site, and the name used when one operator's several instances all publish the
 * same block.
 *
 * An unregistered instance ranks last. It is always the sole member of its own
 * operator, so this never decides anything for it.
 */
export function sourceRank(instance: string): number {
  return RANK_BY_INSTANCE.get(instance.trim().toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
}

/** Distinct operators behind a set of instances, and which of them are unknown. */
export interface OperatorTally {
  /** Distinct operator ids, sorted. An unregistered instance counts as itself. */
  operators: string[];
  /**
   * Instances with no declared operator, sorted. NEVER silently folded away: an
   * unregistered instance is counted as its own operator, which is the
   * PERMISSIVE direction, so a reader has to be told when a count rests on it.
   * Only reachable from a manual run that names its own sources — the scheduled
   * sweep polls {@link BLOCKLIST_SOURCE_INSTANCES} and nothing else.
   */
  unregistered: string[];
}

/**
 * Collapse instances onto their operators.
 *
 * This is the function the corroboration threshold is applied to, and the reason
 * two instances of one moderation team can never clear a threshold of two.
 */
export function tallyOperators(instances: Iterable<string>): OperatorTally {
  const operators = new Set<string>();
  const unregistered = new Set<string>();

  for (const raw of instances) {
    const instance = raw.trim().toLowerCase();
    if (instance.length === 0) continue;

    const operator = operatorOf(instance);
    if (operator) {
      operators.add(operator);
      continue;
    }
    // Counted as its own operator: refusing to count it would silently discard a
    // manual run's evidence, and folding it into an existing operator would
    // invent a relationship nobody asserted.
    operators.add(instance);
    unregistered.add(instance);
  }

  return {
    operators: [...operators].sort(),
    unregistered: [...unregistered].sort(),
  };
}
