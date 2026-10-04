# Original-key Jev usage recovery (candidate)

Source `5fe94e9a23c6789e057fce8d3c9fb6f9c6a3ad89` records the original public principal and configured request deadline before a Jev dispatch. The existing classifier cycle can then read the original idempotency key through the canonical SDK GET. It never repeats a decision or invents a new request identity.

Usage is stored separately as `reconciled_result_missing`: customer charges (v1) remain distinct from internal usage and tariff quotes (v2); provider invoiced cost remains unknown. Missing answers never become a completed classification. Row locking preserves completed answers, deletion cannot resurrect a row, and concurrent recovery cannot replace already recorded evidence. A bounded cursor advances past unavailable keys so they cannot indefinitely starve later claims.

Validation: 371 tests in 14 suites passed against an owned PostgreSQL cluster, which was stopped afterward. Tests cover the installed candidate SDK transport, v1/v2 evidence, foreign authority/model, 404/401, held/aborted reads and late responses, persisted deadlines, deletion/privacy/completion races, duplicate recovery and the existing classifier cycle. Backend typecheck and build passed. The canonical migration adds only three nullable columns; its generated snapshot was compared with the preceding snapshot.

The installed candidate core has 581 files byte-equal to the archive built from Oxy PR1574 source1dd665784. Its existing package version is not a publication claim. Root manifests and lock were restored to their original published baseline; they must be updated after the new SDK release before this consumer can be accepted in normal CI. No production changes or Jev availability changes occurred.

Historical failures are retained: an initial overlay filename setup error; nine test failures from crossing Zod4 with Zod3 schemas; a branded-type declaration error. These are implementation/setup failures, not a claimed frozen baseline-product RED. The final fixture grew as deadline, cycle and fairness cases were added; the final count is371. No repeated provider inference was performed.

`proof.json` binds all source files, logs, migration comparison and installed-member census. The archive remains at its private absolute pointer. Runtime funding/deployment and the exact Jev route/privacy reviews remain separate requirements.
