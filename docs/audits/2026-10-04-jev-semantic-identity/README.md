# Semantic identity before Jev activation

Physical rendition IDs change when `replacePostContent` rewrites identical content. Including those IDs in the paid-claim fingerprint let a no-op rewrite acquire another claim. The fingerprint now retains full author text, article fields, positions, tags, source, account/actor and languages, but excludes physical rendition IDs. Machine translations remain excluded. No normalization or truncation hides author changes.

The exact preserved fixtures produced seven failures against main `83459d4a9` and pass all 353 tests in the 14-suite canonical owned-Postgres runner after the fix. Controls cover an in-flight no-op rewrite; five concurrent claimers after claimed, uncertain, cancelled and completed states; real content edits and return to the original content; privacy/deletion and existing worker/domain regressions. No-op retries preserve the whole existing ledger row. Backend strict types and build pass. Every owned PostgreSQL process was stopped.

This is pre-activation work for OxyHQ/oxy#1572. It does not enable Jev, rewrite historical fingerprints, reconcile paid receipts, or claim that split content/language updates are now atomic. All release blockers remain present. The separate historical additive script is currently stale on main (expects migration0058 last and old SDK pins); its failed output is preserved, not counted as a passing gate. The first test attempt also had missing built shared-types; that setup failure is distinct from the seven product regressions recorded after canonical dependency build.

[Proof, source hashes and original logs](proof.json).
