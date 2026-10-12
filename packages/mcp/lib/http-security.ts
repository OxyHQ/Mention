import { createHash, timingSafeEqual } from 'node:crypto';

export interface AuthenticatedMcpToken {
  sub: string;
  jti: string;
  client_id: string;
  scope: string;
  scopes: ReadonlySet<string>;
  accountId: string;
  authMode: 'central';
}

/**
 * Bind a session to the token family (`jti`), subject and OAuth client. A token
 * refresh rotates `jti`, so the client must initialize a fresh transport; this
 * prevents a new/relinked bundle owned by the same subject and client from
 * taking over a leaked session id.
 */
export function fingerprintMcpPrincipal(
  claims: Pick<AuthenticatedMcpToken, 'sub' | 'client_id' | 'jti' | 'accountId'>,
): string {
  return createHash('sha256')
    .update(`${claims.jti}\0${claims.sub}\0${claims.client_id}\0${claims.accountId}`, 'utf8')
    .digest('hex');
}

/** Constant-time comparison prevents a session from being reused with another token. */
export function mcpPrincipalMatchesFingerprint(
  claims: Pick<AuthenticatedMcpToken, 'sub' | 'client_id' | 'jti' | 'accountId'>,
  expectedFingerprint: string | undefined,
): boolean {
  if (!expectedFingerprint) return false;

  const actual = Buffer.from(fingerprintMcpPrincipal(claims), 'hex');
  const expected = Buffer.from(expectedFingerprint, 'hex');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
