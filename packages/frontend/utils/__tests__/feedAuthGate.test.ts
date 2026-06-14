/**
 * Tests for the feed auth-gating decisions (utils/feedAuthGate).
 *
 * These pure helpers are the single source of truth shared by the home screen's
 * feed-identity remount key (`app/(app)/index.tsx`) and useFeedState's
 * loading/spinner gate (`hooks/useFeedState.ts`). They must agree so a cold-boot
 * reload with an existing session never strands the feed on the empty
 * "No posts yet" placeholder or mounts it in an anonymous configuration.
 *
 * Regression context: after the `isAuthResolved` gating landed, an authenticated
 * user's feed could strand on the empty placeholder during the sub-window where
 * auth has resolved + the viewer is authenticated but the full user id has not
 * landed yet. The gate must report "settling" (spinner) through that window.
 */

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import {
    isAuthUndetermined,
    isAuthedIdentityPending,
    isAuthIdentitySettling,
    resolveFeedIdentity,
    PENDING_FEED_IDENTITY,
    ANON_FEED_IDENTITY,
} from '../feedAuthGate';

// The four canonical auth lifecycle states the home feed must handle.
const UNDETERMINED = { isAuthResolved: false, isAuthenticated: false, currentUserId: undefined };
const COLD_BOOT_AUTHED_RESTORING = { isAuthResolved: false, isAuthenticated: true, currentUserId: undefined };
const AUTHED_ID_PENDING = { isAuthResolved: true, isAuthenticated: true, currentUserId: undefined };
const AUTHED_RESOLVED = { isAuthResolved: true, isAuthenticated: true, currentUserId: 'user-123' };
const ANON_RESOLVED = { isAuthResolved: true, isAuthenticated: false, currentUserId: undefined };
// Ungated caller (profile feeds, etc.): isAuthResolved omitted.
const UNGATED_AUTHED = { isAuthResolved: undefined, isAuthenticated: true, currentUserId: 'user-9' };
const UNGATED_ANON = { isAuthResolved: undefined, isAuthenticated: false, currentUserId: undefined };

describe('isAuthUndetermined', () => {
    it('is true only when isAuthResolved is explicitly false', () => {
        expect(isAuthUndetermined({ isAuthResolved: false })).toBe(true);
    });

    it('is false when resolved', () => {
        expect(isAuthUndetermined({ isAuthResolved: true })).toBe(false);
    });

    it('is false when ungated (undefined) — profile feeds behave as resolved', () => {
        expect(isAuthUndetermined({ isAuthResolved: undefined })).toBe(false);
    });
});

describe('isAuthedIdentityPending', () => {
    it('is true when resolved + authenticated but the user id has not landed', () => {
        expect(isAuthedIdentityPending(AUTHED_ID_PENDING)).toBe(true);
    });

    it('is false once the user id has landed', () => {
        expect(isAuthedIdentityPending(AUTHED_RESOLVED)).toBe(false);
    });

    it('is false while still undetermined (that window is handled separately)', () => {
        expect(isAuthedIdentityPending(COLD_BOOT_AUTHED_RESTORING)).toBe(false);
    });

    it('is false for a genuinely-anonymous visitor', () => {
        expect(isAuthedIdentityPending(ANON_RESOLVED)).toBe(false);
    });
});

describe('isAuthIdentitySettling — feed must show a spinner, never the empty placeholder', () => {
    it('settles (true) while undetermined', () => {
        expect(isAuthIdentitySettling(UNDETERMINED)).toBe(true);
    });

    it('settles (true) during cold-boot authed restore (no id yet)', () => {
        expect(isAuthIdentitySettling(COLD_BOOT_AUTHED_RESTORING)).toBe(true);
    });

    it('settles (true) in the authed-but-id-pending sub-window — the regression', () => {
        expect(isAuthIdentitySettling(AUTHED_ID_PENDING)).toBe(true);
    });

    it('is settled (false) once authenticated with a known id', () => {
        expect(isAuthIdentitySettling(AUTHED_RESOLVED)).toBe(false);
    });

    it('is settled (false) for a genuinely-anonymous visitor — anon feed loads promptly', () => {
        expect(isAuthIdentitySettling(ANON_RESOLVED)).toBe(false);
    });

    it('is settled (false) for ungated callers (profile feeds) regardless of id', () => {
        expect(isAuthIdentitySettling(UNGATED_AUTHED)).toBe(false);
        expect(isAuthIdentitySettling(UNGATED_ANON)).toBe(false);
    });
});

describe('resolveFeedIdentity — remount key never collapses to anon while settling', () => {
    it('is the neutral pending sentinel while undetermined', () => {
        expect(resolveFeedIdentity(UNDETERMINED)).toBe(PENDING_FEED_IDENTITY);
    });

    it('is pending (NOT anon) during the authed-but-id-pending sub-window', () => {
        // The crux of the fix: this MUST NOT be 'anon', or the Feed mounts in an
        // anonymous configuration and strands on the empty placeholder.
        const identity = resolveFeedIdentity(AUTHED_ID_PENDING);
        expect(identity).toBe(PENDING_FEED_IDENTITY);
        expect(identity).not.toBe(ANON_FEED_IDENTITY);
    });

    it('is pending during cold-boot authed restore', () => {
        expect(resolveFeedIdentity(COLD_BOOT_AUTHED_RESTORING)).toBe(PENDING_FEED_IDENTITY);
    });

    it('is the user id once authenticated with a known id (remounts per account)', () => {
        expect(resolveFeedIdentity(AUTHED_RESOLVED)).toBe('user-123');
    });

    it('flips to a different user id on account switch', () => {
        expect(resolveFeedIdentity({ ...AUTHED_RESOLVED, currentUserId: 'user-456' })).toBe('user-456');
    });

    it('is anon for a genuinely-anonymous visitor', () => {
        expect(resolveFeedIdentity(ANON_RESOLVED)).toBe(ANON_FEED_IDENTITY);
    });

    it('keeps the remount key in lockstep with the settling gate across all states', () => {
        // While settling, identity must be the pending sentinel; once settled it
        // must be a concrete identity (user id or anon) — never pending.
        const cases = [
            UNDETERMINED,
            COLD_BOOT_AUTHED_RESTORING,
            AUTHED_ID_PENDING,
            AUTHED_RESOLVED,
            ANON_RESOLVED,
        ];
        for (const c of cases) {
            const settling = isAuthIdentitySettling(c);
            const identity = resolveFeedIdentity(c);
            if (settling) {
                expect(identity).toBe(PENDING_FEED_IDENTITY);
            } else {
                expect(identity).not.toBe(PENDING_FEED_IDENTITY);
            }
        }
    });
});
