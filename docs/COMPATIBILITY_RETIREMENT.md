# Compatibility retirement register

Mention does not keep compatibility code without an observable reason to
remove it. This register covers the remaining transitional surfaces that cannot
yet be deleted safely. A retirement must land with the evidence named below;
absence of a completion marker is not evidence that old data or clients are
gone.

## HTTP and deployment surfaces

| Surface | Why it remains | Evidence required before deletion |
| --- | --- | --- |
| API `GET /` readiness response | The current ALB target group still probes `/`; the application deploy role cannot mutate ELB configuration. | `oxy-infra` changes the target-group health check to `/health/ready`, production confirms healthy targets, and normalized route telemetry shows no operational dependency on the root response. |
| MCP `/sse` and `/messages` | Released MCP clients may still use the pre-Streamable-HTTP transport. It is authenticated, session-bound, and emits a deprecation header. | Thirty consecutive days with zero normalized `/legacy-sse` requests across a representative deployment window, plus confirmation that supported connector versions use `/mcp`. |
| `POST /hashtags/search` | Older released app builds use the tag-only response; current clients use `GET /hashtags/search`. | Thirty consecutive days with zero calls from supported clients, then removal in the backend and shared client contract in the same release. |
| Legacy post-create payload aliases | Released clients may still send `content.images`, top-level media, or the old location object. Reads and stored DTOs are canonical. | The minimum supported mobile build emits only the canonical request, and normalized route/version telemetry records no legacy payloads for thirty days. |
| Static `OXY_SERVICE_TOKEN` credential fallback | Some non-production and recovery environments have not migrated to short-lived service credentials. Production prefers client ID/secret token acquisition. | Every environment has a verified client credential, token-acquisition failures alert, and the static token is absent for one normal release window. |

## Persisted data transitions

| Surface | Why it remains | Evidence required before deletion |
| --- | --- | --- |
| CustomFeed legacy fields and `legacyCustomFeedToDefinition` | Historical rows can lack a stored composable definition. The fallback preserves those feeds without changing new writes. | A production backfill completion marker, a reconciliation query reporting zero rows without valid definitions, and one release reading only the stored definition. |
| Historical federation repair scripts and orphan read backstops | Remote objects imported by older revisions can lack canonical actor or media fields. Dropping the backstops would make valid posts disappear. | The corresponding one-shot completion marker and production reconciliation both report zero unresolved rows. Scripts are removed only after that evidence is committed to the infrastructure/runbook repository. |
| Legacy MTN record readers | Signed records are append-only protocol data and older nodes can legitimately serve earlier schemas. | A versioned protocol decision that removes the schema from the supported read window; ordinary application migration is insufficient. |
| Engagement revision defaults | Pre-transaction Like/Bookmark rows do not have a revision until their next idempotent transition. | Reconciliation reports zero revisionless relationships after the expand/dual-write/backfill/read-switch sequence. |

## Client persistence cleanup

The frontend still deletes a small set of unscoped AsyncStorage keys when a
viewer session initializes. These are cleanup guards, not read fallbacks: their
contents are never admitted into the active viewer cache. Keep the removals
until the minimum supported native build post-dates the viewer-scoped storage
release. Removing them earlier can preserve private data from an older account
on a shared device.

## Retirement procedure

1. Capture production evidence using normalized routes and aggregate counts;
   never add user IDs, post IDs, handles, or free-form values to metrics.
2. Record the migration/backfill marker where the production operation is
   owned.
3. Remove the compatibility branch, its tests, stale documentation, and any
   one-shot workflow together.
4. Run the full workspace checks and post-deploy smoke suite.
5. Observe one normal release window before deleting recoverability tooling.
