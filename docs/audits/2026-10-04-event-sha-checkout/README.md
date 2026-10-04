# Immutable frontend source

Every checkout now uses the immutable event `github.sha`. A completed CI run is admitted only when its tested `head_sha` equals that event SHA, in addition to the existing repository, branch, successful-push CI and hold conditions. An older completion is skipped before checkout/build/effect. Existing current-main checks still refuse a head that becomes stale later. Manual expected-SHA and exact-CI gates, push provenance, release markers and non-ref checkout options remain intact.

The exact final fixture failed against the preceding source, then passed after the workflow change. It evaluates the parsed admission expression for current/stale, held, failed/foreign CI, manual main/feature and applicable push events; mutation controls reject a restored variable checkout and a deleted SHA equality. Local workflow validators also pass. CrowdSource's intermediate log is a synthetic mixed-event control exposing an omitted explicit event discriminator, corrected in the final expression; it is not a live exploit claim.

The earlier conditional checkout-pair attempt remains historical: Mention CodeQL still reported four alerts. This followup does not suppress those alerts; remote analysis must verify the new source. No registry installation, build artifact, merge or deployment is claimed.
