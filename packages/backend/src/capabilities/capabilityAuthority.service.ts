import { createPublicKey, type KeyObject } from 'node:crypto';
import {
  capabilityTicketClaimsSchema,
  policyDecisionSchema,
  type CapabilityTicketClaims,
} from '@oxyhq/contracts';
import {
  CapabilityTicketError,
  verifyCapabilityTicket,
} from '@oxyhq/core/server';
import { z } from 'zod';
import { MENTION_CAPABILITY_AUDIENCE } from '@mention/shared-types/mcpCapabilities';
import { config } from '../config';
import { getServiceOxyClient } from '../utils/oxyHelpers';

const JWKS_TTL_MS = 5 * 60 * 1_000;

const publicJwkSchema = z.object({
  kty: z.string(),
  crv: z.string(),
  x: z.string(),
  kid: z.string().min(1),
  use: z.string().optional(),
  alg: z.string().optional(),
});
const jwksSchema = z.object({ keys: z.array(publicJwkSchema) });
const introspectionEnvelopeSchema = z.object({
  active: z.boolean(),
  claims: z.unknown().optional(),
  decision: z.unknown().optional(),
});

let cachedKeys = new Map<string, KeyObject>();
let keysExpireAt = 0;

async function loadPublicKeys(force = false): Promise<void> {
  if (!force && cachedKeys.size > 0 && Date.now() < keysExpireAt) return;
  const response = await fetch(
    `${config.oxyApiUrl}/capabilities/.well-known/jwks.json`,
    { signal: AbortSignal.timeout(5_000) },
  );
  if (!response.ok) throw new Error(`Oxy capability JWKS returned ${response.status}`);
  const body = jwksSchema.parse(await response.json());
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys) {
    keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
  }
  if (keys.size === 0) throw new Error('Oxy capability JWKS contains no keys');
  cachedKeys = keys;
  keysExpireAt = Date.now() + JWKS_TTL_MS;
}

export async function verifyMentionCapabilityTicket(
  token: string,
): Promise<CapabilityTicketClaims> {
  await loadPublicKeys();
  const options = {
    audience: MENTION_CAPABILITY_AUDIENCE,
    issuer: config.oxyApiUrl,
    resolvePublicKey: (keyId: string) => cachedKeys.get(keyId),
  };
  try {
    return verifyCapabilityTicket(token, options);
  } catch (error) {
    if (!(error instanceof CapabilityTicketError) || error.code !== 'unknown_key') throw error;
    await loadPublicKeys(true);
    return verifyCapabilityTicket(token, options);
  }
}

async function introspectAtOxy(token: string): Promise<unknown> {
  const oxy = getServiceOxyClient();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const serviceToken = await oxy.getServiceToken();
    const response = await fetch(`${config.oxyApiUrl}/capabilities/tickets/introspect`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ticket: token }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 && attempt === 0) {
      oxy.invalidateServiceToken();
      continue;
    }
    if (!response.ok) {
      throw new Error(`Oxy capability authority returned ${response.status}`);
    }
    return response.json();
  }
  throw new Error('Oxy capability authority rejected refreshed service credentials');
}

/** Recalculate mutable account, grant, automation, credential and app authority. */
export async function introspectMentionCapabilityTicket(
  token: string,
  localClaims: CapabilityTicketClaims,
): Promise<boolean> {
  const envelope = introspectionEnvelopeSchema.parse(await introspectAtOxy(token));
  const claims = envelope.claims === undefined
    ? undefined
    : capabilityTicketClaimsSchema.parse(envelope.claims);
  const decision = envelope.decision === undefined
    ? undefined
    : policyDecisionSchema.parse(envelope.decision);
  return envelope.active === true
    && decision?.allowed === true
    && claims?.jti === localClaims.jti
    && claims.aud === localClaims.aud
    && claims.tool === localClaims.tool
    && claims.resource.effectiveAccountId === localClaims.resource.effectiveAccountId;
}
