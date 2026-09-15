/**
 * The feed's retry policy and its classification.
 *
 * The numbers in `withFeedRetry` are the point of the file it tests: before it,
 * a failed feed load cost up to 16 requests (four app-level attempts, each
 * retried three more times by the SDK client), and the predicate deciding all of
 * that was `message.includes('4')`. Both halves are asserted here — the request
 * BUDGET, exactly, and the classification by status rather than by message text.
 */

import { AxiosError, AxiosHeaders } from 'axios';
import {
    FEED_MAX_ATTEMPTS,
    classifyFeedFailure,
    isRetryableFeedFailure,
    logFeedFailure,
    withFeedRetry,
    type FeedFailure,
} from '../feedRetry';

/** An error in the shape `@oxy.so/core`'s `handleHttpError` throws. */
function sdkError(status: number, code = 'INTERNAL_ERROR'): unknown {
    return { message: `HTTP ${status} error`, code, status };
}

/** The shape a service rethrows: a message-only wrapper over the real failure. */
function wrapped(cause: unknown): Error {
    return new Error('Failed to fetch feed', { cause });
}

function axiosWithoutResponse(): AxiosError {
    const config = { headers: new AxiosHeaders() };
    return new AxiosError('Network Error', undefined, config as never);
}

describe('classifyFeedFailure', () => {
    it('treats every 5xx as transient', () => {
        for (const status of [500, 502, 503, 504]) {
            expect(classifyFeedFailure(sdkError(status)).kind).toBe('transient');
        }
    });

    it('treats the two "ask again later" 4xx as transient', () => {
        expect(classifyFeedFailure(sdkError(429)).kind).toBe('transient');
        expect(classifyFeedFailure(sdkError(408)).kind).toBe('transient');
    });

    it('treats every other 4xx as a client failure', () => {
        for (const status of [400, 401, 403, 404, 422]) {
            expect(classifyFeedFailure(sdkError(status)).kind).toBe('client');
        }
    });

    it('reads the status off a wrapped cause, not the wrapper message', () => {
        // The bug this replaces: a wrapper's message decided retryability, so
        // "Request failed with status 502" was refused (it contains a '4') while
        // "Error 404" was retried.
        expect(classifyFeedFailure(wrapped(sdkError(502))).kind).toBe('transient');
        expect(classifyFeedFailure(wrapped(sdkError(404))).kind).toBe('client');
    });

    it('calls a request that never reached a server offline', () => {
        // `@oxy.so/core` stamps status 0; axios leaves it undefined.
        expect(classifyFeedFailure(sdkError(0, 'NETWORK_ERROR')).kind).toBe('offline');
        expect(classifyFeedFailure(axiosWithoutResponse()).kind).toBe('offline');
    });

    it('calls a timeout transient — something answered, then went quiet', () => {
        expect(classifyFeedFailure(sdkError(0, 'TIMEOUT')).kind).toBe('transient');
    });

    it('retries everything but a client failure', () => {
        expect(isRetryableFeedFailure(classifyFeedFailure(sdkError(503)))).toBe(true);
        expect(isRetryableFeedFailure(classifyFeedFailure(sdkError(429)))).toBe(true);
        expect(isRetryableFeedFailure(classifyFeedFailure(sdkError(0, 'NETWORK_ERROR')))).toBe(true);
        expect(isRetryableFeedFailure(classifyFeedFailure(sdkError(404)))).toBe(false);
    });
});

describe('withFeedRetry', () => {
    it('spends one request when the read succeeds', async () => {
        const read = jest.fn().mockResolvedValue('page');
        await expect(withFeedRetry(read)).resolves.toBe('page');
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('recovers a transient failure without the caller seeing it', async () => {
        const read = jest
            .fn()
            .mockRejectedValueOnce(sdkError(500))
            .mockResolvedValue('page');
        await expect(withFeedRetry(read)).resolves.toBe('page');
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('spends at most FEED_MAX_ATTEMPTS requests on a failed load', async () => {
        const read = jest.fn().mockRejectedValue(sdkError(500));
        await expect(withFeedRetry(read)).rejects.toBeDefined();
        expect(read).toHaveBeenCalledTimes(FEED_MAX_ATTEMPTS);
        expect(FEED_MAX_ATTEMPTS).toBeLessThanOrEqual(3);
    });

    it('never retries a rate limit into the same limiter more than the budget', async () => {
        const read = jest.fn().mockRejectedValue(sdkError(429, 'RATE_LIMITED'));
        await expect(withFeedRetry(read)).rejects.toBeDefined();
        expect(read).toHaveBeenCalledTimes(FEED_MAX_ATTEMPTS);
    });

    it('does not retry a client failure at all', async () => {
        const read = jest.fn().mockRejectedValue(sdkError(404, 'NOT_FOUND'));
        await expect(withFeedRetry(read)).rejects.toBeDefined();
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('does not retry once the caller has aborted', async () => {
        const controller = new AbortController();
        const read = jest.fn().mockImplementation(() => {
            controller.abort();
            return Promise.reject(sdkError(500));
        });
        await expect(withFeedRetry(read, controller.signal)).rejects.toBeDefined();
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('fails fast when the platform says the device has no network', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperty(globalThis, 'navigator', {
            value: { onLine: false },
            configurable: true,
        });
        try {
            const read = jest.fn().mockRejectedValue(sdkError(0, 'NETWORK_ERROR'));
            await expect(withFeedRetry(read)).rejects.toBeDefined();
            expect(read).toHaveBeenCalledTimes(1);
        } finally {
            if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
            else delete (globalThis as { navigator?: unknown }).navigator;
        }
    });
});

describe('logFeedFailure', () => {
    function spyLogger() {
        return { warn: jest.fn(), error: jest.fn() } as unknown as Parameters<typeof logFeedFailure>[0] & {
            warn: jest.Mock;
            error: jest.Mock;
        };
    }

    it('warns for an expected transient failure instead of writing console.error', () => {
        const log = spyLogger();
        logFeedFailure(log, 'Feed read failed', classifyFeedFailure(sdkError(503)), { feedType: 'for_you' });
        expect(log.warn).toHaveBeenCalledWith('Feed read failed', expect.objectContaining({
            status: 503,
            feedType: 'for_you',
        }));
        expect(log.error).not.toHaveBeenCalled();
    });

    it('warns for an offline device too — the reader is already being told', () => {
        const log = spyLogger();
        logFeedFailure(log, 'Feed read failed', classifyFeedFailure(sdkError(0, 'NETWORK_ERROR')));
        expect(log.warn).toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
    });

    it('keeps error level for a client failure, which is a bug', () => {
        const log = spyLogger();
        const failure: FeedFailure = classifyFeedFailure(sdkError(400, 'BAD_REQUEST'));
        logFeedFailure(log, 'Feed read failed', failure);
        expect(log.error).toHaveBeenCalledWith('Feed read failed', undefined, expect.objectContaining({
            status: 400,
        }));
        expect(log.warn).not.toHaveBeenCalled();
    });
});
