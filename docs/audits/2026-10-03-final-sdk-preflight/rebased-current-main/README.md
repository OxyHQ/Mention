# Mention candidate composition on current main

Rebased the accepted I05 sources and mechanical preflight onto `80b03fb2d`.
The rebase preserves the current retirement of Mention-issued OAuth; historical
proofs remain dated evidence and do not claim that retired surface still exists.
No product conflict required manual resolution.

The full shared/backend/MCP build passed. MCP tests passed 119 tests in 19 files;
the seven backend authority/catalog/foreground focals passed 50 tests, including
real domain SQL under the existing fixture boundaries. This is candidate SDK
compatibility, not final registry, full backend-suite or deployment acceptance.

The PostgreSQL cluster belonged to this agent at 127.0.0.1:5593. The suite created
and dropped its own database, readback showed only postgres/template0/template1,
and the cluster was stopped. No shared database or production access was used.

Manifests and lock currently point to private candidate tarballs and remain
uncommitted. Final registry installation and lock generation are still required.
