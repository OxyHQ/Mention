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

`OXY_ECOSYSTEM_ACTIVITY_ENABLED=true` explicitly enables the deployed producer; it is disabled by default. Keep it false in local environments, even when using AWS storage.

`AWS_REGION` supplies the process location. `OXY_SERVICE_API_KEY` and
`OXY_SERVICE_API_SECRET` authenticate publication. Enabled producer configuration is validated before
listening. Each process registers a fresh instance, refreshes its lease,
and removes it during graceful shutdown. Crashed instances disappear when their
lease expires. Oxy broadcasts authoritative snapshots over Socket.IO.

Counters describe observed application operations, not network bytes. Direct
object-storage downloads, media transports, database wire protocols and third
party runtime internals require instrumentation at their owning services.

## Static edge requests

The deployed frontend Worker observes requests before its ASSETS binding, including static files and navigations. Enable with private Worker bindings `OXY_EDGE_ACTIVITY_ENABLED=true`, `OXY_EDGE_ACTIVITY_API_KEY`, `OXY_EDGE_ACTIVITY_API_SECRET`, and optional `OXY_EDGE_ACTIVITY_API_URL`. These credentials are separate from backend credentials and must never use a public frontend environment prefix. Disabled or unavailable telemetry leaves the response unchanged; publication runs in `ctx.waitUntil`.

The serving Cloudflare PoP appears as a pulse for external edge activity. It does not fabricate an arc to a visitor location. Verified internal peers may supply a known source region.
