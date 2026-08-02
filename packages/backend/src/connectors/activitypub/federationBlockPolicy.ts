import { canonicalFederationHost } from '@oxyhq/federation';
import type {
  FederationBlockCategory,
  FederationBlockSeverity,
  PublishedFederationBlock,
} from '@mention/shared-types';

/**
 * WHICH INSTANCES MENTION REFUSES TO FEDERATE WITH, AND WHY.
 *
 * This file is the policy. Not a cache of one, not a mirror of one — the list
 * below is read by the enforcement predicate (`isBlockedDomain`) and by the
 * public transparency page, and there is no third copy anywhere.
 *
 * WHY THE LIST LIVES IN THE REPOSITORY RATHER THAN IN CONFIGURATION
 *
 *   A blocklist is not a secret. It is public moderation policy. Mastodon
 *   instances publish theirs at `GET /api/v1/instance/domain_blocks`, and that
 *   is precisely how our own intelligence script
 *   (`scripts/reportFederationBlocklistCandidates.ts`) learns which domains
 *   other instances have suspended. Reading everyone else's published policy
 *   while hiding our own would be taking without giving.
 *
 *   Keeping it here also makes the history real. Git records WHEN each domain
 *   was added and — in the commit message — the evidence it was added on. That
 *   is an audit trail somebody can review, dispute and revert. A comma-separated
 *   string in a deploy console that one person edited once, months ago, is not.
 *
 *   And it removes the failure mode a transparency page is most prone to: the
 *   page and the server disagreeing. Both read {@link resolveFederationBlocks};
 *   the enforcement set is derived from the very array the page renders, so a
 *   domain cannot be quietly blocked without being listed. Two sources would
 *   eventually make the page a lie.
 *
 * THE EMERGENCY LEVER STILL WORKS
 *
 *   `FEDERATION_BLOCKED_DOMAINS` (comma-separated env) is unioned into the same
 *   predicate, so an urgent block does not have to wait for a deploy. One
 *   authority, two inputs — never a second predicate. Such an entry is published
 *   too, as `source: 'operational'`, saying openly that its reason has not been
 *   written up yet. A block that nobody can see is the thing this file exists to
 *   prevent, and an undocumented one showing on the page is a standing prompt to
 *   move it down here properly.
 *
 * WHAT IS DELIBERATELY *NOT* PUBLISHED
 *
 *   `isBlockedDomain` also rejects our OWN ActivityPub domains and the Oxy
 *   identity apex. Those are not moderation decisions — both hosts publish our
 *   own users, and treating them as remote would duplicate local accounts. They
 *   are enforcement-only and must never appear on the transparency page; listing
 *   `mention.earth` among "instances we refuse" would be a straightforward
 *   falsehood. The published list therefore covers exactly the moderation
 *   inputs: this file, plus the environment lever.
 */

/**
 * One reviewed entry in the policy.
 *
 * `domain` must be written CANONICAL — lowercase, bare host, no scheme, no
 * `www.` prefix, no path — which is the form
 * {@link canonicalFederationHost} produces and the federation engine compares
 * against. Every reader here canonicalises anyway so a slip cannot silently fail
 * to block, and a test asserts every committed entry is already in that form so
 * the file reads exactly as it behaves.
 *
 * ONE ENTRY BLOCKS ONE HOST. Matching is exact set membership on the canonical
 * host, so `evil.example` does not cover `sub.evil.example` — a subdomain is a
 * different server and needs its own reviewed entry. That is deliberate, and it
 * is what the transparency page tells the public, so do not widen it here
 * without changing the page too.
 */
export interface FederationBlockPolicyEntry {
  readonly domain: string;
  readonly severity: FederationBlockSeverity;
  readonly category: FederationBlockCategory;
  /**
   * One factual sentence, written for the public and in the knowledge that the
   * people it describes will read it. State what was found. Do not characterise
   * a community beyond the finding, and do not gloat.
   */
  readonly reason: string;
  /** `YYYY-MM-DD` — the day the block took effect. */
  readonly since: string;
  /**
   * Instances that had ALREADY published the same decision, independently, when
   * ours was taken — the corroboration our intelligence script reports.
   *
   * Empty is legitimate and means the decision came from moderation on Mention
   * itself. It is never a placeholder for "did not check": leaving it empty
   * makes the page say the decision was ours alone, so an entry that WAS
   * corroborated must name its sources.
   */
  readonly corroboratingSources: readonly string[];
}

/**
 * THE COMMITTED POLICY — 118 instances, decided on 2026-08-02.
 *
 * HOW THIS LIST WAS ARRIVED AT
 *   Every entry began as a candidate from a production run of
 *   `scripts/reportFederationBlocklistCandidates.ts`, which reads the blocklists
 *   other instances publish and crosses them against what we actually hold. The
 *   run polled thirteen instances; all thirteen published. Three filters were
 *   then applied, in this order, and each one removed real candidates:
 *
 *   1. SUSPEND ONLY. A domain another instance merely SILENCES is not evidence
 *      for suspending it — those are different decisions, and Mention has no
 *      mechanism for the lesser one. Reasons published alongside a `silence` were
 *      discarded with it: `h5q.net` reads as unmoderated only in a comment
 *      attached to a silencing, and `switter.at`'s sole suspension says
 *      "preparing for announced shutdown", which is not a moderation finding at
 *      all. Both are absent below.
 *
 *   2. TWO DISTINCT OPERATORS, NOT TWO INSTANCES. Corroboration across sites
 *      that share a moderation team is one decision counted twice.
 *      `mastodon.social` and `mastodon.online` are both Mastodon GmbH and publish
 *      from the same contact account; `universeodon.com` and `mastodonapp.uk` are
 *      likewise one operator. Counting instances rather than operators inflated
 *      the corroborated set substantially, and the threshold is applied to
 *      operators here. It is why `corroboratingSources` below names exactly one
 *      instance per operator: the field's contract says INDEPENDENTLY, so listing
 *      both halves of a pair would overstate what we found.
 *
 *   3. A HOST THE ENGINE CAN ACTUALLY REFUSE. `isBlockedDomain` is EXACT
 *      canonical-host membership — blocking `evil.example` does NOT block
 *      `sub.evil.example`. Three otherwise-corroborated candidates were shared
 *      hosting apexes (`workers.dev`, `hf.space`, `repl.co`) where nobody
 *      federates from the bare host at all: every actor lives on a subdomain, so
 *      the entry would have refused precisely nothing while the page stated we
 *      refuse the domain. The instances that publish those blocks run Mastodon,
 *      whose domain blocks DO cover subdomains; ours do not, and an entry is not
 *      transcribable across that difference. They are absent below.
 *
 *   4. A CATEGORY WE CAN HONESTLY ASSIGN. `FederationBlockCategory` is closed on
 *      purpose, and a domain whose published suspensions do not fit any member is
 *      left OUT rather than filed under the nearest one. This removed 58
 *      otherwise-corroborated domains — almost all of them Twitter-mirror bridges
 *      published as "third-party bots", which are not spam, not unmoderated, and
 *      not anything else this vocabulary names. Calling them spam to get them
 *      onto the list would have been the exact editorialising the `reason` field
 *      forbids.
 *
 * WHAT THE REASONS DO AND DO NOT CLAIM
 *   We did not audit these instances ourselves, and the sentences do not pretend
 *   we did: they say a decision was taken elsewhere, by how many independent
 *   operators, and for what. Where the published suspensions support a specific
 *   finding — the child-safety entries, the relays that exist to route around
 *   other instances' blocks — the finding is stated first, in our own words. The
 *   wording of other operators' published comments is deliberately NOT copied:
 *   those are their characterisations, written for their own audiences, and some
 *   are insults. The stated count always equals the length of
 *   `corroboratingSources`, and a test holds it to that.
 *
 * @example
 * ```ts
 * {
 *   domain: 'example.invalid',
 *   severity: 'suspend',
 *   category: 'child_safety',
 *   reason: 'Hosts sexualised imagery of minors and does not act on reports.',
 *   since: '2026-08-02',
 *   corroboratingSources: ['mastodon.social', 'mstdn.social'],
 * }
 * ```
 */
export const FEDERATION_BLOCK_POLICY: readonly FederationBlockPolicyEntry[] = [
  {
    domain: '5dollah.click',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'a.sc',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'mstdn.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'activitypub-proxy.cf',
    severity: 'suspend',
    category: 'spam',
    reason: 'Relays traffic around blocks other instances have applied; suspended for it by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'activitypub-troll.cf',
    severity: 'suspend',
    category: 'spam',
    reason: 'Relays traffic around blocks other instances have applied; suspended for it by 10 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'aethy.com',
    severity: 'suspend',
    category: 'child_safety',
    reason: 'Hosts sexualised drawings of minors and does not remove them; suspended for it by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'annihilation.social',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'asbestos.cafe',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'bae.st',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'baraag.net',
    severity: 'suspend',
    category: 'child_safety',
    reason: 'Hosts sexualised drawings of minors and does not remove them; suspended for it by 10 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'beefyboys.club',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 4 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'universeodon.com'],
  },
  {
    domain: 'beefyboys.win',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'breastmilk.club',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'cachapa.cc',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 3 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'ohai.social'],
  },
  {
    domain: 'cachapa.xyz',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'catgirl.life',
    severity: 'suspend',
    category: 'harassment',
    reason: 'Suspended for targeted harassment by 3 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mastodon.social', 'mstdn.social', 'universeodon.com'],
  },
  {
    domain: 'chudbuds.lol',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'clew.live',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 4 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mastodon.social', 'ohai.social'],
  },
  {
    domain: 'clew.lol',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'clubcyberia.co',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mastodonapp.uk', 'mstdn.social', 'ohai.social', 'techhub.social'],
  },
  {
    domain: 'comfyboy.club',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 4 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'ohai.social', 'universeodon.com'],
  },
  {
    domain: 'cum.estate',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'ohai.social', 'sfba.social', 'techhub.social'],
  },
  {
    domain: 'cum.salon',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 10 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'decayable.ink',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'deepspace.cafe',
    severity: 'suspend',
    category: 'harassment',
    reason: 'Suspended for targeted harassment by 2 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mastodon.social', 'techhub.social'],
  },
  {
    domain: 'detroitriotcity.com',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 10 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'dsmc.space',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 2 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mastodon.social', 'ohai.social'],
  },
  {
    domain: 'eientei.org',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'eveningzoo.club',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 10 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'fediblock.lol',
    severity: 'suspend',
    category: 'harassment',
    reason: 'Suspended for targeted harassment by 4 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mastodon.social', 'mstdn.social', 'sfba.social', 'universeodon.com'],
  },
  {
    domain: 'freeatlantis.com',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'freecumextremist.com',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'freespeech.club',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 3 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'universeodon.com'],
  },
  {
    domain: 'freespeechextremist.com',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 10 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.jp', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'fsebugoutzone.org',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'gab.ai',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'gab.com',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'mstdn.jp', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'gameliberty.club',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'gearlandia.haus',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.online', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'genderheretics.xyz',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'getgle.org',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 2 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mastodon.social', 'universeodon.com'],
  },
  {
    domain: 'gleasonator.com',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'glindr.org',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'universeodon.com'],
  },
  {
    domain: 'glowers.club',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'universeodon.com'],
  },
  {
    domain: 'honkwerx.tech',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'universeodon.com'],
  },
  {
    domain: 'hunk.city',
    severity: 'suspend',
    category: 'spam',
    reason: 'Suspended for spam by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'mstdn.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'iddqd.social',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'jaeger.website',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 3 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mastodon.social', 'ohai.social', 'universeodon.com'],
  },
  {
    domain: 'kingcels.ca',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 3 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mastodon.social', 'sfba.social'],
  },
  {
    domain: 'kiwifarms.cc',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'leafposter.club',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'lolison.top',
    severity: 'suspend',
    category: 'child_safety',
    reason: 'Hosts sexualised drawings of minors and does not remove them; suspended for it by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'mashtodon.alterracloud.com',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'mast-serv.site',
    severity: 'suspend',
    category: 'spam',
    reason: 'Suspended for spam by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'mastinator.com',
    severity: 'suspend',
    category: 'spam',
    reason: 'Republishes posts from other instances publicly without consent, and routes around the blocks they apply; suspended for it by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'merovingian.club',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'minds.com',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 3 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mastodon.social', 'ohai.social', 'universeodon.com'],
  },
  {
    domain: 'misskey-forkbomb.cf',
    severity: 'suspend',
    category: 'spam',
    reason: 'Suspended for spam by 10 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'mostr.pub',
    severity: 'suspend',
    category: 'spam',
    reason: 'Suspended for spam by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'mstdn.jp', 'mstdn.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'mugicha.club',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'nationalist.social',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 10 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'nazi.social',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'neckbeard.xyz',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'nekosat.work',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mastodon.social', 'ohai.social', 'techhub.social'],
  },
  {
    domain: 'nicecrew.digital',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 10 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'nnia.space',
    severity: 'suspend',
    category: 'child_safety',
    reason: 'Hosts child sexual abuse material; suspended for it by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'noauthority.social',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'norwoodzero.net',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'ns.auction',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'universeodon.com'],
  },
  {
    domain: 'nyanide.com',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'paravielfalt.zone',
    severity: 'suspend',
    category: 'child_safety',
    reason: 'Hosts sexualised drawings of minors and does not remove them; suspended for it by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mastodon.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'parcero.bond',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'parcero.casa',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'pawoo.net',
    severity: 'suspend',
    category: 'child_safety',
    reason: 'Hosts sexualised imagery of minors; suspended for it by 10 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'paypig.org',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'universeodon.com'],
  },
  {
    domain: 'pieville.net',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'pl.smuglo.li',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 3 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mastodon.social', 'mstdn.social'],
  },
  {
    domain: 'pleroma.adachi.party',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 2 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mastodon.social'],
  },
  {
    domain: 'pleroma.fun',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 2 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mastodon.social', 'universeodon.com'],
  },
  {
    domain: 'pleroma.kitsunemimi.club',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 3 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mastodon.social', 'ohai.social', 'universeodon.com'],
  },
  {
    domain: 'pleroma.us',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 2 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social'],
  },
  {
    domain: 'poa.st',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 10 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'poast.tv',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'pooper.social',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'mstdn.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'poster.place',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 10 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'pouque.net',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 4 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mastodon.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'rakket.app',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'mstdn.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'rapemeat.express',
    severity: 'suspend',
    category: 'harassment',
    reason: 'Suspended for targeted harassment by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'mstdn.jp', 'mstdn.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'rdrama.cc',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'ryona.agency',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'schwartzwelt.xyz',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 3 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'universeodon.com'],
  },
  {
    domain: 'seal.cafe',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'ohai.social', 'sfba.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'shitpisscum.mooo.com',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 4 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mastodon.social', 'mastodonapp.uk', 'mstdn.social'],
  },
  {
    domain: 'shitpost.cloud',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'shortstackran.ch',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'shortstacksran.ch',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'shrimpposter.club',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'skinheads.social',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'sleepy.cafe',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'sneed.social',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'social.cutefunny.net',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mastodon.social', 'mstdn.jp', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'social.freysa.ai',
    severity: 'suspend',
    category: 'spam',
    reason: 'Suspended for spam by 4 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mastodon.social', 'mstdn.social', 'techhub.social'],
  },
  {
    domain: 'social.lovingexpressions.net',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mastodon.social', 'mstdn.social', 'sfba.social', 'troet.cafe'],
  },
  {
    domain: 'solagg.com',
    severity: 'suspend',
    category: 'spam',
    reason: 'Suspended for spam by 5 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'mstdn.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'spinster.xyz',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'strelizia.net',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'supernets.social',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'tastingtraffic.net',
    severity: 'suspend',
    category: 'spam',
    reason: 'Exists primarily to post search-engine spam; suspended for it by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'mastodonapp.uk', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social'],
  },
  {
    domain: 'the.usualsuspects.lol',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 2 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mastodon.social', 'mastodonapp.uk'],
  },
  {
    domain: 'theblab.org',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'truthsocialpro.org',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 3 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'mstdn.social'],
  },
  {
    domain: 'tsundere.love',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'ohai.social', 'sfba.social', 'techhub.social'],
  },
  {
    domain: 'urchan.org',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 4 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['mas.to', 'mastodon.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'varishangout.net',
    severity: 'suspend',
    category: 'child_safety',
    reason: 'Hosts sexualised drawings of minors and does not remove them; suspended for it by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'troet.cafe', 'universeodon.com'],
  },
  {
    domain: 'volk.network',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 7 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'ohai.social', 'sfba.social', 'techhub.social'],
  },
  {
    domain: 'webmasto.online',
    severity: 'suspend',
    category: 'spam',
    reason: 'Suspended for spam by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['kolektiva.social', 'mas.to', 'mastodon.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'wolfgirl.bar',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 8 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'yggdrasil.social',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 9 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'mstdn.social', 'ohai.social', 'sfba.social', 'techhub.social', 'universeodon.com'],
  },
  {
    domain: 'zztails.gay',
    severity: 'suspend',
    category: 'hate_speech',
    reason: 'Suspended for hate speech by 6 independently operated instances.',
    since: '2026-08-02',
    corroboratingSources: ['infosec.exchange', 'kolektiva.social', 'mas.to', 'mastodon.social', 'techhub.social', 'universeodon.com'],
  },
];

/**
 * THE COMMITTED POLICY, PARSED — the single reader of {@link FEDERATION_BLOCK_POLICY}.
 *
 * Domains come back canonicalised through `canonicalFederationHost` — the
 * federation engine's OWN function, the one `createDomainPolicy` compares
 * incoming hosts with — so a consumer never has to know the comparison form, and
 * a slip in the file cannot quietly produce a domain that matches nothing. Then
 * deduplicated last-wins and sorted, the same treatment
 * {@link resolveFederationBlocks} gives them, because it is this function's
 * output that it merges.
 *
 * Mention held a hand-copy of that rule until `@oxyhq/federation@0.6.0` exported
 * it. Two implementations of "are these the same host" only have to disagree
 * once for a consumer to act on a domain the engine never refused, and one of
 * these consumers DELETES content, so the copy was removed rather than
 * documented. There is now nothing to keep in step.
 *
 * Returns REVIEWED entries only. The `FEDERATION_BLOCKED_DOMAINS` environment
 * lever is deliberately absent: a committed entry has a diff, an author and a
 * review, an environment value has none of those. Any consumer whose action is
 * irreversible — deleting already-ingested content, say — should key off THIS,
 * not off the merged {@link resolveFederationBlocks} output, and the boundary is
 * enforced by the shape rather than left to a filter the caller has to remember.
 *
 * `since` is the day the block took effect AS DECLARED BY THE AUTHOR. It is not a
 * commit timestamp and is not guaranteed to move only forwards — a typo in it is
 * an ordinary correction. Do not use it to decide that a domain is NEWLY blocked;
 * diff the domain set against what you have already acted on.
 *
 * Call it with no arguments — the default IS the committed policy, and that is
 * the only source a consumer should be reading. `entries` exists so the parsing
 * can be tested against data while the committed list is empty; a test that
 * needs to swap the policy for a whole module graph should mock this function
 * instead (`__tests__/connectors/federationTransparency.test.ts` is the worked
 * example).
 */
export function getBlockedDomainPolicy(
  entries: readonly FederationBlockPolicyEntry[] = FEDERATION_BLOCK_POLICY,
): readonly FederationBlockPolicyEntry[] {
  const byDomain = new Map<string, FederationBlockPolicyEntry>();

  for (const entry of entries) {
    const domain = canonicalFederationHost(entry.domain);
    if (domain.length === 0) continue;
    byDomain.set(domain, { ...entry, domain });
  }

  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

/**
 * Merge the committed policy with the environment lever into the ONE list that
 * is both enforced and published.
 *
 * Deduplicated by canonical domain, with the committed entry winning: the same
 * domain in both inputs is the same block, and the reviewed entry is the one
 * that can explain itself. Sorted by domain so the page has a stable order and a
 * diff of the published output is readable.
 *
 * `entries` is normally {@link getBlockedDomainPolicy}'s output, already
 * canonicalised. Canonicalising again here is idempotent and keeps the function
 * correct for a caller that passes raw entries.
 */
export function resolveFederationBlocks(
  entries: readonly FederationBlockPolicyEntry[],
  environmentDomains: Iterable<string>,
): readonly PublishedFederationBlock[] {
  const byDomain = new Map<string, PublishedFederationBlock>();

  for (const domain of environmentDomains) {
    const canonical = canonicalFederationHost(domain);
    if (canonical.length === 0) continue;
    byDomain.set(canonical, { source: 'operational', domain: canonical, severity: 'suspend' });
  }

  for (const entry of entries) {
    const canonical = canonicalFederationHost(entry.domain);
    if (canonical.length === 0) continue;
    byDomain.set(canonical, {
      source: 'policy',
      domain: canonical,
      severity: entry.severity,
      category: entry.category,
      reason: entry.reason,
      since: entry.since,
      corroboratingSources: entry.corroboratingSources,
    });
  }

  return [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}
