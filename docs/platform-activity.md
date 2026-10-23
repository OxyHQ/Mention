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
Oxy service token, which Mention's deployment obtains by attesting its ECS task
role. Customer service-key fallback is retired; local development uses temporary
AWS role/SSO credentials. Producer configuration is validated before listening. Each process registers a fresh instance, refreshes its lease,
and removes it during graceful shutdown. Crashed instances disappear when their
lease expires. Oxy broadcasts authoritative snapshots over Socket.IO.

Counters describe observed application operations, not network bytes. Direct
object-storage downloads, media transports, database wire protocols and third
party runtime internals require instrumentation at their owning services.

## Static web traffic

This app's web traffic is measured keylessly by Oxy from Cloudflare's own
analytics (see [Cloudflare web activity](https://github.com/OxyHQ/oxy/blob/main/docs/operations/cloudflare-web-activity.md)
in OxyHQ/oxy). The
frontend Worker holds no Oxy activity secret and runs no activity code: it only
applies the shell access gate and serves its ASSETS binding. The
`OXY_EDGE_ACTIVITY_*` bindings were never provisioned and nothing reads them now;
if an operator ever finds one on a deployment it can simply be deleted.

The gate itself is covered by `scripts/shell-worker.test.mjs`
(`bun run test:shell-worker`, part of `check:workspace`).

## Package versions

Core and contracts are aligned through workspace overrides so browser and server packages share one version.
