/**
 * The feed's ONE retry policy, and the classification it is built on.
 *
 * ## Why it lives here
 *
 * A feed read used to be retried twice over: `useFeedState` wrapped every fetch
 * in four attempts, and each of those went through `@oxy.so/core`'s linked
 * client (`utils/api.ts`), which retries a 5xx or a transport failure three more
 * times with 1s/2s/4s backoff. Four times four is up to **16 requests for one
 * failed feed load**, and home plus profile load in parallel — which is how a
 * single unhappy backend produced ten identical 500s in one reader's console.
 * The retry storm also *was* part of the outage: the backend was failing because
 * Oxy had rate-limited it, and each retry asked again.
 *
 * So the transport's retry is turned OFF for feed reads (`retry: false`) and the
 * policy lives here, in front of the transport, for three reasons:
 *
 * 1. **One policy, one place.** Both feed paths share it — the memory-mode hook
 *    (`useFeedState`, web and scoped feeds) and the SQLite store (`postsStore`,
 *    native) — because both read through `services/feedService`.
 * 2. **It covers the anonymous transport too.** A signed-out reader's feed goes
 *    out over plain axios (`publicClient`), which has no retry of its own; a
 *    policy expressed as transport config would have left them with none.
 * 3. **It can retry what the transport won't.** The SDK never retries a 4xx, so
 *    a 429 — the status that started this — was the one failure it gave up on.
 *
 * ## The budget
 *
 * {@link FEED_MAX_ATTEMPTS} requests per failed feed load, total: the first one
 * plus two retries, ~500ms then ~1s apart with jitter. Worst case a reader waits
 * about two seconds before the feed says it couldn't load, and a rate-limited
 * backend sees three requests where it used to see sixteen.
 */

import { createLogger, type LogContext, type Logger } from '@oxy.so/core/logger';
import { normalizeApiError } from './apiError';

/** Requests per failed feed load, first attempt included. */
export const FEED_MAX_ATTEMPTS = 3;

/** Backoff base: retries land ~500ms and ~1s after the failure, plus jitter. */
const FEED_RETRY_BASE_DELAY_MS = 500;

/**
 * Jitter added to every delay. Home and profile feeds fail together, so without
 * it their retries would arrive together too — three synchronized volleys at a
 * backend that is already struggling.
 */
const FEED_RETRY_JITTER_MS = 250;

const logger = createLogger('feedRetry');

/**
 * How a failed feed read should be treated.
 *
 * - `offline` — the request never reached a server. Retrying helps only if the
 *   connection comes back, and the reader is the one who can fix it, so this is
 *   the single case the UI names.
 * - `transient` — the server answered, but with "not now": a 5xx, a 429, a 408.
 *   Worth retrying, and not a defect in the client.
 * - `client` — the server answered that the request itself was wrong (any other
 *   4xx). Retrying it would only repeat the same rejection, and it is the one
 *   kind that points at a bug worth an error-level log.
 */
export type FeedFailureKind = 'offline' | 'transient' | 'client';

/** A caught feed failure, reduced to the few facts worth acting or logging on. */
export interface FeedFailure {
    kind: FeedFailureKind;
    /** HTTP status, when the server answered. `0`/absent for a transport failure. */
    status?: number;
    /** Machine-readable code from the body or the transport (`NETWORK`, `TIMEOUT`, …). */
    code?: string;
    /** Best available message. For logs — never for the UI, which owns its own copy. */
    message: string;
}

/**
 * Classify a caught feed failure by the HTTP status it carries.
 *
 * Status, never message text: the check this replaced was
 * `message.includes('4')`, which treated "Request failed with status 502" and
 * "Error 40 of 400" alike and so refused to retry the very failures that were
 * worth retrying.
 */
export function classifyFeedFailure(error: unknown): FeedFailure {
    const { status, code, message } = normalizeApiError(error);

    // No status means nothing answered. `@oxy.so/core` stamps `status: 0` on its
    // transport failures while axios leaves it undefined — both say the same
    // thing. A TIMEOUT did reach something that then went quiet, so it is the
    // server's problem, not the reader's connection.
    if (status === undefined || status === 0) {
        return { kind: code === 'TIMEOUT' ? 'transient' : 'offline', status, code, message };
    }

    // 5xx, plus the two 4xx that mean "ask again later" rather than "your
    // request is wrong": 408 Request Timeout and 429 Too Many Requests.
    if (status >= 500 || status === 408 || status === 429) {
        return { kind: 'transient', status, code, message };
    }

    return { kind: 'client', status, code, message };
}

/** `true` for a failure worth asking again about. */
export function isRetryableFeedFailure(failure: FeedFailure): boolean {
    return failure.kind !== 'client';
}

/**
 * Log a feed failure at the level it deserves.
 *
 * `logger.error` writes `console.error`, which raises a LogBox pop-up on native
 * and fills the console with red on web. A backend hiccup the app has already
 * retried and recovered from — or has just told the reader about calmly — is not
 * that, so it logs as a `warn` with a bounded context instead of dumping a whole
 * error object. A `client` failure keeps error level: that one is a bug.
 */
export function logFeedFailure(
    log: Logger,
    message: string,
    failure: FeedFailure,
    context?: LogContext,
): void {
    const merged: LogContext = {
        ...context,
        status: failure.status,
        code: failure.code,
        reason: failure.message,
    };
    if (failure.kind === 'client') {
        log.error(message, undefined, merged);
        return;
    }
    log.warn(message, merged);
}

/**
 * The platform's own answer to "is this device on a network", where there is
 * one. React Native has no `navigator.onLine`, so this is `false` there and the
 * retries below run as usual — a mobile connection that drops for a moment
 * usually comes back, and two bounded retries are how it recovers.
 */
function deviceReportsOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function retryDelayMs(attempt: number): number {
    return FEED_RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * FEED_RETRY_JITTER_MS;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one feed read under the policy: at most {@link FEED_MAX_ATTEMPTS}
 * attempts, exponential backoff with jitter, and never a retry of a failure that
 * would only be rejected the same way again.
 *
 * `signal` is the caller's own lifecycle (a remount, a newer first-page request).
 * Once it aborts, the read is not a failure at all and retrying it would race
 * whatever superseded it.
 */
export async function withFeedRetry<T>(
    read: () => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await read();
        } catch (error) {
            if (signal?.aborted) throw error;

            const failure = classifyFeedFailure(error);
            const isLastAttempt = attempt >= FEED_MAX_ATTEMPTS - 1;
            if (isLastAttempt || !isRetryableFeedFailure(failure)) throw error;

            // Retrying a request the platform already knows cannot leave the
            // device only delays the offline state the reader needs to see.
            if (failure.kind === 'offline' && deviceReportsOffline()) throw error;

            logger.debug('Retrying feed read', {
                attempt: attempt + 1,
                of: FEED_MAX_ATTEMPTS,
                status: failure.status,
                code: failure.code,
            });
            await sleep(retryDelayMs(attempt));
            if (signal?.aborted) throw error;
        }
    }
}
