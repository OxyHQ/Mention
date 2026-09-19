# Ecosystem activity

Each deployed API process publishes bounded activity aggregates to Oxy, whether
or not anyone has opened the dashboard. HTTP middleware observes requests and
completed responses, including errors; the shared outgoing observer covers fetch
and Node HTTP clients. Requests and responses have independent directions.
Socket.IO application events and observed raw WebSocket messages are counted
separately from HTTP. Ping/pong frames and Socket.IO acknowledgements are not
application events.

The publisher sends only service identities, infrastructure regions, coarse edge
PoPs, direction, scope, category and aggregate counts. It never sends payloads,
paths, query strings, IPs, user IDs, credentials or socket IDs. A Cloudflare PoP
is a network ingress location, not a visitor's physical location.

There is no variable that switches the producer on. It publishes where it is
deployed and stays quiet everywhere else, because "am I a deployed process or
somebody's laptop" is a fact about the environment rather than something to
type: ECS sets the container credentials endpoint on every task and nothing
else does, which is the same signal the credential-free service token uses to
prove what the process IS (oxy ADR 0026). A local checkout with AWS storage
configured therefore publishes nothing, which is what the old
`OXY_ECOSYSTEM_ACTIVITY_ENABLED=false` was there to ask for.

`AWS_REGION` supplies the process location. Publication authenticates with the
Oxy service token — from `OXY_SERVICE_API_KEY`/`OXY_SERVICE_API_SECRET` where
they are still configured, and from the task role's attestation where they are
not. Producer configuration is validated before listening. Each process registers a fresh instance, refreshes its lease,
and removes it during graceful shutdown. Crashed instances disappear when their
lease expires. Oxy broadcasts authoritative snapshots over Socket.IO.

Counters describe observed application operations, not network bytes. Direct
object-storage downloads, media transports, database wire protocols and third
party runtime internals require instrumentation at their owning services.

## Static edge requests

The deployed frontend Worker observes requests before its ASSETS binding, including static files and navigations. Enable with private Worker bindings `OXY_EDGE_ACTIVITY_ENABLED=true`, `OXY_EDGE_ACTIVITY_API_KEY`, `OXY_EDGE_ACTIVITY_API_SECRET`, and optional `OXY_EDGE_ACTIVITY_API_URL`. These credentials are separate from backend credentials and must never use a public frontend environment prefix. Disabled or unavailable telemetry leaves the response unchanged; publication runs in `ctx.waitUntil`.

The serving Cloudflare PoP appears as a pulse for external edge activity. It does not fabricate an arc to a visitor location. Verified internal peers may supply a known source region.

## Package versions

Core and contracts are aligned through workspace overrides so browser and server packages share one version. Edge activity uses the published telemetry package; the lockfile records registry artifacts. Run the edge observer checks in `scripts/edge-activity.test.mjs` alongside the existing package checks.
