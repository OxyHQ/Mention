# Homiio SDK review artifacts

These two tarballs make the integration installable before Homiio's first SDK release.
They were built using `bun pm pack` from Homiio commit
`ee9c1aa201ed4ca8bd17cdf1f8394a0b05ddac78` (`codex/confirmed-sdk`):

- `homiio-contracts-0.1.0.tgz`: canonical Zod public-case contract and URL helpers.
- `homiio-sdk-0.1.0.tgz`: validated, cancellable public batch client.

The root contracts override resolves the SDK's `0.1.0` dependency to the same
review artifact. Both Docker manifest stages copy these files before installation.
No absolute filesystem paths, provider content, credentials, or runtime database
copies are needed.

Release order: merge and publish Homiio contracts, publish SDK, deploy Homiio's
public batch API with Mention's web origin permitted by CORS, then replace the
relative file dependencies and root override with the published package versions
and regenerate `bun.lock`. Do not consider the cards operational until that API
is deployed. An unavailable provider currently produces the unavailable card.

Artifact SHA-256:

```text
af24ab13dd786180484731030dcf219dcf669f4ed5830b2015d1ae66272a29ec  homiio-contracts-0.1.0.tgz
2cc359a18fc874b3264934f943dc979cd6aadf499e869315c92483d901abfd3e  homiio-sdk-0.1.0.tgz
```
