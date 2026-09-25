/**
 * THE ONE PLACE Mention touches Oxy's account-event contract (OxyHQ/Mention#1169).
 *
 * Oxy signs an `account.deleted` Security Event Token for every relying
 * application when a person deletes their account. It pushes the token to
 * `POST /webhooks/oxy/account-events` and also serves it from a pull feed. Both
 * paths come through here, so this module is the only file that knows the SDK's
 * method names and result shapes.
 *
 * The verification itself (signature against Oxy's JWKS, `typ: secevent+jwt`,
 * issuer, audience = this application's service credential) is
 * `@oxy.so/core`'s `verifyAccountEvent` (>= 1.13.0). This file only narrows the
 * handle and names the SDK's refusal.
 */

import type { OxyAccountEvent, OxyAccountEventFeedItem, OxyAccountEventFeedPage } from '@oxy.so/core';
import { getServiceOxyClient } from '../../utils/oxyHelpers';

export type { OxyAccountEvent, OxyAccountEventFeedItem, OxyAccountEventFeedPage };

/**
 * True for the SDK's refusal of a token: bad signature, unknown key, wrong `typ`,
 * wrong audience, malformed payload. Matched by NAME rather than `instanceof`, so a
 * second copy of the SDK in the tree cannot turn a refusal into a retry. A refusal
 * is final (401); any other failure (JWKS unreachable) is worth a retry.
 */
export function isAccountEventRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === 'OxyAccountEventError';
}

/**
 * Verify a token and return the event. Throws on anything but a valid,
 * Oxy-signed `account.deleted` addressed to this application. The audience
 * defaults to the application id of Mention's own service credential.
 */
export async function verifyAccountEvent(token: string): Promise<OxyAccountEvent> {
  const event = await getServiceOxyClient().verifyAccountEvent(token);
  return { ...event, username: normalizeUsername(event.username) };
}

/** One page of the pull feed, strictly after `after`. */
export async function listAccountEvents(options: {
  after?: string;
  limit?: number;
}): Promise<OxyAccountEventFeedPage> {
  return getServiceOxyClient().listAccountEvents(options);
}

/**
 * A handle is used to build ActivityPub URLs, so anything that is not a plain
 * handle is treated as absent rather than trusted into a URL.
 */
export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.-]{1,64}$/.test(trimmed) ? trimmed : null;
}
