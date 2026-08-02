import {
  FEDERATION_NETWORKS,
  blueskyUsernameFromHandle,
  createBridgeRelabeller,
  upstreamHandleFromPreferredUsername,
  upstreamHandleFromProfileField,
  type FederationBridgeEntry,
} from '@oxyhq/federation';

/**
 * WHICH HOSTS REPUBLISH ANOTHER NETWORK'S ACCOUNTS, AND HOW TO READ THE REAL
 * IDENTITY BACK OUT OF THEM.
 *
 * A BRIDGE mirrors accounts from somewhere else. What it publishes as
 * `@WIRED@mastox.eu` is not a person on mastox.eu — it is WIRED, on X, copied.
 * Naming the account after the bridge tells a reader nothing they can act on: the
 * hostname is an implementation detail of how the post reached us, and what they
 * want to know is which account on which network wrote it. So an actor from a
 * listed bridge is stored and rendered under its NETWORK — `@wired@x.com` —
 * exactly as an atproto actor with a custom-domain handle is stored under
 * `bsky.social` rather than under the domain its handle happens to spell.
 *
 * THIS FILE IS THE POLICY, AND IT IS MENTION'S, NOT THE PLATFORM'S
 *
 *   The MECHANISM lives in `@oxyhq/federation` and every Oxy app shares it. The
 *   entries do not, and must not: deciding that a given operator may be trusted
 *   to re-attribute somebody's account is a moderation judgement, and putting it
 *   in the shared package would hand Homiio, Allo and everything else a decision
 *   their owners never made. Same discipline as `./federationBlockPolicy` —
 *   committed, reviewed, reasons written down, git as the audit trail.
 *
 *   oxy-api keeps its OWN list, in `packages/api/src/config/federationBridgeTrust.ts`.
 *   `PUT /users/resolve` binds an actor URI's host to the domain being claimed,
 *   and a bridged identity is the one legitimate exception — so oxy-api
 *   ADJUDICATES what this file merely DERIVES, and an adjudicator reading the
 *   applicant's own list is taking their word rather than deciding.
 *
 *   ⚠ THAT SECOND LIST IS NOT DUPLICATION. DO NOT CONSOLIDATE THEM. Kept
 *   separate, drift fails CLOSED both ways: a bridge listed here that oxy-api
 *   does not trust simply has its resolve refused and the actor keeps its bridge
 *   identity; one trusted there that nothing here derives for does nothing at
 *   all. Neither direction can produce an accepted attribution nobody reviewed,
 *   which is the whole point. Merge the two and one side's list becomes the
 *   other's authority, so a single unreviewed entry starts re-attributing real
 *   people's writing. The redundancy IS the safety mechanism.
 *
 * A WRONG ENTRY MISATTRIBUTES SOMEBODY'S WRITING
 *
 *   Heavier than a wrong block: that loses content and somebody complains, while
 *   this silently publishes one person's posts under another person's name, on a
 *   network they may not even use. So every entry records what was VERIFIED
 *   against a live actor separately from what is merely ASSUMED, and no entry
 *   ships without a stored fixture and a test that fails if its rule stops
 *   round-tripping. Derivation is per-ACTOR and fails closed: an actor that does
 *   not satisfy its bridge's rule keeps the bridge hostname, which is how the
 *   operator's own admin and service accounts are left alone.
 *
 * THE LIST CANNOT BE COMPLETE, AND NOBODY SHOULD TRY TO FINISH IT
 *
 *   `mastox.eu` runs stock Mastodon. There is no bridge software to fingerprint —
 *   somebody points an off-the-shelf mirror bot at an ordinary instance, and the
 *   result is indistinguishable from any other Mastodon server by NodeInfo, by
 *   software name, or by any endpoint at all. The only tell is free-text
 *   instance description, in French here and in anything anywhere else. So this
 *   is ACCUMULATION, not enumeration: it grows as instances are found, it will
 *   never converge, and a crawler cannot close it. Do not write one and do not
 *   assume an unlisted host is not a bridge.
 *
 *   The one family that IS closed is BirdsiteLive, whose full deployment set is
 *   six hosts. Even there the software is self-hostable, so the closure is a fact
 *   about today rather than a property.
 *
 * WHAT IS DELIBERATELY NOT LISTED
 *
 *   `threads.net` is native first-party ActivityPub, not a bridge:
 *   `acct:zuck@threads.net` resolves to a threads.net actor, so `@user@threads.net`
 *   is ALREADY correct provenance and registering it would introduce a bug rather
 *   than fix one. An ordinary instance whose admin happens to run some mirror
 *   bots is not a bridge either — "hosts mirror accounts" is not "is a bridge".
 *
 *   Bridges whose actors are not PEOPLE are out of scope for this shape, because
 *   there is no upstream person to re-label: subreddits, arXiv categories, and
 *   websites republished as feeds. `@www.example.com@some-rss-bridge` maps to a
 *   site, not to an account elsewhere, and forcing it into `@handle@network`
 *   would invent an account that does not exist. They need a different entry
 *   type, or none.
 */

/**
 * The BirdsiteLive family emits this notice, differing only in the network name.
 * Its full deployment set is six hosts; the four we do not hold a single actor
 * from are absent, since an entry that has never matched anything is a claim
 * nobody has checked.
 */
const BIRDSITELIVE_NOTICE_TAIL =
  "\\.\\s*Its author can't see your replies\\.\\s*If you find this service useful, "
  + 'please consider supporting us via our Patreon\\.\\s*$';

function birdsiteLiveNotice(network: string): RegExp {
  return new RegExp(`\\s*This account is a replica from ${network}${BIRDSITELIVE_NOTICE_TAIL}`);
}

/** THE COMMITTED BRIDGE POLICY. */
export const FEDERATION_BRIDGE_POLICY: readonly FederationBridgeEntry[] = [
  {
    host: 'bird.makeup',
    network: FEDERATION_NETWORKS.x,
    operator: 'Vincent Cloutier (bird.makeup)',
    software: 'BirdsiteLive',
    derive: upstreamHandleFromProfileField({ fieldName: 'Official', hosts: ['twitter.com', 'x.com'] }),
    caseRule: 'lowercase',
    relabel: 'enabled',
    upstreamIdStability: 'recyclable',
    boilerplate: [birdsiteLiveNotice('Twitter')],
    consent: 'unconsented',
    evidence:
      'Every mirrored actor publishes an `Official` profile field whose rel="me" link is '
      + 'https://twitter.com/<handle> — the bridge states which upstream account it mirrors, so the '
      + 'handle is read from that assertion rather than inferred from the username. Verified against '
      + 'the stored actor rows for typecache, gorskon and giswqs, and a live fetch of '
      + 'bird.makeup/users/nasa. Enabled standalone because we hold actors from only two of the six '
      + 'live X bridges and zero cross-bridge duplicates: the wire-verified nasa collision between '
      + 'bird.makeup and birdmakeup.sboulema.nl exists in the world but not in our corpus.',
    assumption:
      'That an X handle identifies one person over time. X releases abandoned handles, so two '
      + 'bridges capturing years apart could derive the same key for two different humans — the '
      + 'residual named by `upstreamIdStability: recyclable`, which is why the merge refuses on '
      + 'sharply disagreeing profiles rather than merging on the key alone.',
    since: '2026-08-02',
  },
  {
    host: 'kilogram.makeup',
    network: FEDERATION_NETWORKS.instagram,
    operator: 'Vincent Cloutier (bird.makeup)',
    software: 'BirdsiteLive',
    derive: upstreamHandleFromProfileField({ fieldName: 'Official', hosts: ['instagram.com'] }),
    caseRule: 'lowercase',
    relabel: 'enabled',
    upstreamIdStability: 'recyclable',
    boilerplate: [birdsiteLiveNotice('Instagram')],
    consent: 'unconsented',
    evidence:
      'Same software and the same `Official` rel="me" assertion as bird.makeup, pointing at '
      + 'https://www.instagram.com/<handle>. Verified against the stored rows for robert.habeck, '
      + 'umwelthilfe and plex — note Instagram handles may contain dots, which the '
      + 'single-path-segment rule preserves. The only live Instagram bridge, so its collision set '
      + 'is empty; treat that as a fact about today, since the software is self-hostable.',
    assumption:
      'That an Instagram handle identifies one person over time — Instagram releases abandoned '
      + 'handles, the same residual as bird.makeup.',
    since: '2026-08-02',
  },
  {
    host: 'mastox.eu',
    network: FEDERATION_NETWORKS.x,
    operator: 'mastox.eu (contact @admin@mastox.eu)',
    software: 'Mastodon (stock; no bridge software to fingerprint)',
    derive: upstreamHandleFromPreferredUsername([
      /\(bot from x to mastodon managed by mastox\.eu, contact @admin for any information\)\s*$/i,
      /\(bot de x . mastodon g.r. par mastox\.eu, contactez @admin pour toute demande\)\s*$/i,
    ]),
    caseRule: 'lowercase',
    relabel: 'enabled',
    upstreamIdStability: 'recyclable',
    boilerplate: [
      /\s*\(bot from x to mastodon managed by mastox\.eu, contact @admin for any information\)\s*$/i,
      /\s*\(bot de x . mastodon g.r. par mastox\.eu, contactez @admin pour toute demande\)\s*$/i,
    ],
    consent: 'unconsented',
    evidence:
      'The instance describes itself as "une instance Mastodon de miroir non officiels de comptes X '
      + 'vers Mastodon", and every mirrored actor appends a per-account notice naming itself a bot '
      + 'from X — which is what identifies a mirror here, since the operator\'s own @admin account '
      + 'lives on the same host and carries no such notice. Verified against the stored rows for '
      + 'mehdirhasan, FranceskAlbs and gbsumudflotilla (English notice) and a live fetch of '
      + 'mastox.eu/users/RERB (French notice). The handle comes from preferredUsername and NEVER '
      + 'from the actor URI, which is numeric on some rows (/ap/users/116193264000459783).',
    assumption:
      'That the mirrored account\'s preferredUsername equals the upstream X handle. Unlike the '
      + 'BirdsiteLive bridges, a mastox.eu actor publishes NO link to the X account it mirrors — no '
      + 'alsoKnownAs, no rel="me" to x.com — so this mapping rests on the instance-level '
      + 'declaration plus the naming convention, and is the one derivation here that is not read '
      + 'off an assertion the actor makes about itself.',
    since: '2026-08-02',
  },
  {
    // The `bsky.app/profile/<handle>` link carries the FULL Bluesky handle, so the
    // same `.bsky.social`-suffix rule the atproto connector applies has to run
    // here too — without it `georgemonbiot.bsky.social` would be stored as the
    // doubled `@georgemonbiot.bsky.social@bsky.social` and would NOT match the row
    // the direct connector already holds for that account.
    host: 'bsky.brid.gy',
    network: FEDERATION_NETWORKS.bluesky,
    operator: 'Ryan Barrett (Bridgy Fed)',
    software: 'bridgy-fed',
    derive: (candidate) => {
      const handle = upstreamHandleFromProfileField({
        fieldName: 'Web site',
        hosts: ['bsky.app'],
        pathPrefix: ['profile'],
      })(candidate);
      return handle === undefined ? undefined : blueskyUsernameFromHandle(handle);
    },
    caseRule: 'preserve',
    // Enabled now that the merge sees ACROSS protocols. Re-labelling here derives
    // `@handle@bsky.social`, which is exactly what the atproto connector already
    // renders for the same account — 79 of our 815 Bridgy actors are accounts we
    // hold natively — so this was deliberately inert until a bridged copy could
    // adopt the native row's Oxy user rather than mint a twin. Both directions now
    // route through `resolveFederatedActorIdentity`, and it matches a native row
    // by its `username@domain` identity as well as by `networkAcct`, so no
    // backfill of the 10,066 native rows is required for it to work.
    relabel: 'enabled',
    upstreamIdStability: 'stable',
    boilerplate: [
      /\s*🌉\s*\S+\s+from\s+🦋\s+\S+, follow (?:@bsky\.brid\.gy|\S+) to interact\s*$/u,
    ],
    consent: 'opt-in',
    evidence:
      'Bridgy Fed only bridges a Bluesky account once that account opts in, and each bridged actor '
      + 'publishes a `Web site` rel="me" link to https://bsky.app/profile/<handle> plus its atproto '
      + 'DID in alsoKnownAs — the same DID the atproto connector keys its own row on, which is what '
      + 'makes the two paths provably the same account and why upstreamIdStability is stable. '
      + 'Verified against the stored rows for thistleandmoss.com, georgemonbiot.bsky.social and '
      + 'assignedmale.bsky.social, and a live fetch of '
      + 'bsky.brid.gy/ap/did:plc:z72i7hdynmk6r22z27h6tvur.',
    assumption: '',
    since: '2026-08-02',
  },
];

/**
 * Mention's bridge readers.
 *
 * `alsoKnownAs` is deliberately NOT read as a generic upstream backlink anywhere
 * above. It IS one on Bridgy Fed, but on the stock-Mastodon mirror farms it is a
 * Mastodon MIGRATION pointer aimed at a sibling farm domain — treating it
 * generically would attribute an account to whatever that pointer happens to
 * name. Where a backlink is used, the entry says which field carries it.
 */
export const federationBridges = createBridgeRelabeller(FEDERATION_BRIDGE_POLICY);
