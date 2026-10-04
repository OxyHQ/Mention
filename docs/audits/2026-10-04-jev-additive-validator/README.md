# Jev additive validator maintenance

The validator now checks migration 0058 at its own position instead of requiring it to remain the final migration. Migration 0059 is already on main. The owned snapshot still preserves every existing table and metadata field; only the two original Jev tables may be added, and destructive SQL remains rejected.

Published contracts 4.9.0 and core 4.2.0 replace stale 4.7/4.1 integrity expectations. This changes no manifest or lock. All six dormant activation blockers remain required.

The exact preserved fixture rejects the old validator's current-repository control (1 failed, 8 passed), then passes all nine controls after the fix. Negative controls cover changed/duplicate migration identity, destructive SQL, protected table mutation, version/integrity drift, and removed/bypassed approval gates. Baseline negative results may stop at the stale journal assumption; their protection is demonstrated on the fixed validator. The canonical validator also passes against the actual checkout.

Commands: `node --test scripts/validate-jev-additive.test.mjs` and `node scripts/validate-jev-additive.mjs`. See [proof.json](proof.json) for source and record hashes. No runtime or activation change.
