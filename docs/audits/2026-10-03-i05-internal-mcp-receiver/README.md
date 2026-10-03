# Mention common internal MCP receiver

The dedicated /_oxy/mcp route delegates to the shared catalogue transport before the external body parser. It accepts only Capability tickets with matching signature, live authority, audience, tool, catalogue and account resource. The canonical Mention handlers forward the same proof and caller operation key to the backend. OAuth and legacy HTTP remain available as before.

Eight signed HTTP/SQL fixtures pass: real savePost/bookmarks/effect receipts, duplicate/conflict/new operation, direct Capability HTTP parity, missing key, forged/Bearer/catalog/account/tool rejection, authority withdrawal between transport and backend, and a read withdrawn during audit. Writes already committed remain successful if audit delivery is unavailable; their durable receipt prevents replay effects. Reads have a final fresh authority check after audit. Removing only that check fails the same selected fixture; restoring the exact bytes passes all eight.

The own MCP package suite passes 121 tests. The two existing Bun server tests additionally verify that an unconfigured internal lane answers 503 before parsing a malformed body and does not fall back to external OAuth. Both package TypeScript checks pass. Owned PostgreSQL processes were freshly initialized, validated before database creation and stopped in finally. No production database, authority change or provider operation was used.

The remote Oxy mutable state is synthetic. The SQL read route is a fixture projection, while the write uses the actual domain controller. Positive deployed server configuration, real registry packages, Alia consumer parity and rollout remain separate acceptance work.
