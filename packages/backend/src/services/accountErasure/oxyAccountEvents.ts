/**
 * THE ONE PLACE Mention touches Oxy's account-event contract (OxyHQ/Mention#1169).
 *
 * Oxy signs an `account.deleted` Security Event Token for every relying
 * application when a person deletes their account. It pushes the token to
 * `POST /webhooks/oxy/account-events` and also serves it from a pull feed. Both
 * paths come through here, so this module is the only file that knows the SDK's
 * method names and result shapes.
 *
 * `@oxy.so/core` 1.13.0 ships `verifyAccountEvent` and `listAccountEvents`. Until
 * that version is installed, the methods are reached through the structural
 * {@link AccountEventClient} below, and a client without them throws
 * {@link AccountEventsUnsupportedError}. It never degrades to "accept".
 * Swapping to the SDK's own types is a change to this file alone.
 */

import { getServiceOxyClient } from '../../utils/oxyHelpers';

/** The SET `events` member Oxy uses for an account deletion. */
export const OXY_ACCOUNT_DELETED_EVENT_URI = 'https://oxy.so/events/account.deleted';

/** A VERIFIED account event: the signature, `typ`, issuer and audience all checked out. */
export interface OxyAccountEvent {
  /** The event id (`jti`). Stable across webhook retries and the pull feed. */
  eventId: string;
  type: 'account.deleted';
  /** The deleted Oxy account. */
  userId: string;
  /** The handle at deletion time. `null` when unknown; Mention then cannot address a `Delete`. */
  username: string | null;
  /** ISO-8601 time the deletion committed. */
  occurredAt: string;
  /** `true` when Oxy archived the row for financial records. Erase either way. */
  retained: boolean;
  applicationId: string;
  issuedAt: number;
}

/** One entry of the pull feed. `token` is re-verified before anything acts on it. */
export interface OxyAccountEventFeedItem {
  eventId: string;
  type: 'account.deleted';
  userId: string;
  username?: string | null;
  occurredAt: string;
  retained: boolean;
  token: string;
}

export interface OxyAccountEventFeedPage {
  events: OxyAccountEventFeedItem[];
  /** Pass back as `after`. Unchanged (or null) when the page is empty. */
  nextCursor: string | null;
}

/**
 * The two SDK methods, structurally. `@oxy.so/core` 1.13.0's `OxyServices` has
 * both; an older client has neither, which {@link accountEventClient} refuses.
 */
interface AccountEventClient {
  verifyAccountEvent(token: string, options?: { audience?: string }): Promise<OxyAccountEvent>;
  listAccountEvents(options?: { after?: string; limit?: number }): Promise<OxyAccountEventFeedPage>;
}

/** The installed `@oxy.so/core` predates the account-event contract. */
export class AccountEventsUnsupportedError extends Error {
  constructor() {
    super(
      'The installed @oxy.so/core has no account-event support (needs >= 1.13.0); ' +
        'account events cannot be verified, so none is accepted.',
    );
    this.name = 'AccountEventsUnsupportedError';
  }
}

function hasAccountEventMethods(client: unknown): client is AccountEventClient {
  if (typeof client !== 'object' || client === null) return false;
  return (
    typeof Reflect.get(client, 'verifyAccountEvent') === 'function' &&
    typeof Reflect.get(client, 'listAccountEvents') === 'function'
  );
}

function accountEventClient(): AccountEventClient {
  const client: unknown = getServiceOxyClient();
  if (!hasAccountEventMethods(client)) throw new AccountEventsUnsupportedError();
  return client;
}

/**
 * True for the SDK's refusal of a token: bad signature, unknown key, wrong `typ`,
 * wrong audience, malformed payload. Matched by NAME because the class is exported
 * by a package version this file may not have installed. A refusal is final (401),
 * while any other failure (JWKS unreachable, the SDK too old) is worth a retry.
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
  const event = await accountEventClient().verifyAccountEvent(token);
  return { ...event, username: normalizeUsername(event.username) };
}

/** One page of the pull feed, strictly after `after`. */
export async function listAccountEvents(options: {
  after?: string;
  limit?: number;
}): Promise<OxyAccountEventFeedPage> {
  return accountEventClient().listAccountEvents(options);
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
