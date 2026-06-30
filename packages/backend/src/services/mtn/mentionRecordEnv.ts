/**
 * MTN custodial-signing environment.
 *
 * Mention signs `app.mention.feed.*` records on the WEB/SERVER path with a
 * CUSTODIAL key (the browser/native client does not yet co-sign — that is a
 * later seam, LWW-superseded by a native signature). Three env vars configure
 * the custodial issuer:
 *
 *  - `MENTION_DID`         — the issuer DID for custodial records (a `did:web`
 *                            Mention controls). Equals the `issuer` field on the
 *                            envelope and the `custodialIssuer` the resolver
 *                            returns.
 *  - `MENTION_PRIVATE_KEY` — the secp256k1 private key (hex) that signs custodial
 *                            envelopes. SECRET (ECS-injected); never logged.
 *  - `MENTION_PUBLIC_KEY`  — the matching secp256k1 public key (hex). PUBLIC (a
 *                            verification method of `MENTION_DID`); used by the
 *                            resolver as `custodialPublicKey` for the plain-equality
 *                            authorization check.
 *
 * INERT-WITHOUT-ENV: when ANY of the three is missing the service is disabled —
 * {@link isMentionRecordSigningEnabled} returns `false` and the dual-write
 * emission is a logged no-op. This lets the feature ship dark and be enabled by
 * setting the env vars on the ECS task, with the rest of the system unchanged.
 */

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** The custodial issuer DID, or `undefined` when unconfigured. */
export function getMentionCustodialIssuer(): string | undefined {
  return readEnv('MENTION_DID');
}

/** The custodial signing private key (hex), or `undefined` when unconfigured. */
export function getMentionCustodialPrivateKey(): string | undefined {
  return readEnv('MENTION_PRIVATE_KEY');
}

/** The custodial public key (hex), or `undefined` when unconfigured. */
export function getMentionCustodialPublicKey(): string | undefined {
  return readEnv('MENTION_PUBLIC_KEY');
}

/**
 * Whether MTN custodial record signing is fully configured. All three env vars
 * must be present; otherwise the dual-write emission is skipped (logged no-op).
 */
export function isMentionRecordSigningEnabled(): boolean {
  return Boolean(
    getMentionCustodialIssuer() &&
      getMentionCustodialPrivateKey() &&
      getMentionCustodialPublicKey(),
  );
}
