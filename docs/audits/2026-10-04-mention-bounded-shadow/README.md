# One reviewed native Jev operation

Source `f3a5417685e5f5bcfadf90b0aa7560c7bcb75f78`, based on Mention main
`dfb368638c6aed9985887f6abfe0736922c78ab0`.

The production factory requires one selected post, full semantic fingerprint,
preassigned claim/idempotency key and normalized input hash. Read-only preparation
uses the same request builder as the SDK and returns only IDs/hashes. The claim
rechecks eligibility, content, privacy and expiry under the existing SQL locks,
and inserts the reviewed key. The worker can process that selected revision even
if it was already classified; it does not reset ordinary classification or admit
other posts. No public endpoint accepts this selection.

Production approval remains `undefined`; static release blockers remain closed.
No post, live permit, authority grant, card, policy, expiry or funding was invented.
Oxy and Kaana need their own matching Mention source audience before activation.
The public SDK requires no new `scopedExecution` field: Oxy attaches its reviewed
permit server-side. A successful initial Alia permit does not authorize Mention.

Validation: four suites, **150 passed**; backend types/build and shared build exited
zero. The same 150 fixtures against the old factory/worker and old claim function
produced **9 failed / 141 passed**. This controlled baseline retains the new pure
request builder and additive read-only preparation so failures exercise admission,
not missing imports. The old claim helper call is renamed to its equivalent new
name; the original factory and worker are byte-exact Git files. Snapshots and the
runner are retained. Final input files were unchanged between those runs.

Tests cover one concurrent claim, replay/uncertain work, changed post/hash/content,
expiry, private/profile/import/federation/deletion exclusions, a real SQL privacy
writer race, no token/HTTP for altered selected input, receipt GET after expiry,
and one already-classified post without a canonical rewrite. Existing tests cover
full-content semantic identity and final-write privacy/deletion races.

The first command was mistakenly run from the root and stopped without a meaningful
focal result. Initial source/fixture errors (cross-major Zod schema composition,
missing imported score constant and wrong synthetic import columns) and the missing
fresh shared build are preserved separately; they are not the nine baseline RED
assertions. The final checks use the backend's own scripts. `bun run` uses ambient
1.4.2 to launch Node/Vitest/tsc; no installation, manifest or lock changed. Existing
read-only dependency directories were reused from the accepted factory worktree.

The owned PostgreSQL server at 127.0.0.1:18643 is stopped. No AWS, external provider,
production DB, deployment, push or source activation occurred. Real signed
Mention→Oxy→Kaana composition is a separate integration fixture, not claimed by
these synthetic-SDK/real-SQL product tests.
