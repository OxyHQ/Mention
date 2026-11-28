package earth.mention.widgets.following

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import so.oxy.session.OxyBackgroundToken
import java.io.IOException

/**
 * The following widget's PRIVACY CONTRACT.
 *
 * Every case here is one the widget will really meet, and each one fails in a way that looks like
 * a working widget from the outside:
 *
 *  - treat a network failure as a sign-out and a signed-in reader's timeline vanishes off their
 *    home screen whenever their train enters a tunnel;
 *  - treat a sign-out as a network failure and a signed-out reader's private posts stay on the
 *    home screen indefinitely, which is the one outcome this widget must never produce;
 *  - retry a malformed response and the device wakes to re-fetch a body it cannot read.
 *
 * None of those is visible in a screenshot, which is exactly why they are pinned here.
 */
class FollowingSessionTest {

    @Test
    fun `an available token authorizes a fetch with the server's own account id`() {
        val token = OxyBackgroundToken.Available(
            accessToken = "at_live_token",
            expiresAt = 1_900_000_000_000L,
            accountId = "6981c9178fcdefaf81988ffb",
            baseUrl = "https://api.oxy.so",
        )

        assertEquals(
            FollowingRefreshAuth.Authorized(
                accessToken = "at_live_token",
                accountId = "6981c9178fcdefaf81988ffb",
            ),
            classifyBackgroundToken(token),
        )
    }

    /**
     * The account id carried forward is the SERVER's, not a local guess — it is what the rotation
     * gets stamped with, so a wrong one here would let a rotation be stored under an account that
     * never authorized it.
     */
    @Test
    fun `the authorized account id is taken from the token, not from anywhere else`() {
        val token = OxyBackgroundToken.Available(
            accessToken = "at",
            expiresAt = 1L,
            accountId = "switched_to_this_account",
            baseUrl = "https://api.oxy.so",
        )

        val auth = classifyBackgroundToken(token) as FollowingRefreshAuth.Authorized

        assertEquals("switched_to_this_account", auth.accountId)
    }

    @Test
    fun `no session means signed out, which is what empties the store`() {
        assertEquals(
            FollowingRefreshAuth.SignedOut,
            classifyBackgroundToken(OxyBackgroundToken.SignedOut),
        )
    }

    /**
     * The one that protects a signed-IN reader. `Transient` covers no network, a timeout, a 5xx, a
     * rate limit and ANY ambiguous 401 — the SDK deliberately lands an unrecognised 401 here rather
     * than in `SignedOut`, because treating an ambiguous 401 as revocation is what logged users out
     * of this ecosystem once already.
     */
    @Test
    fun `a transient failure keeps the content and retries`() {
        val cause = IOException("connection reset")

        assertEquals(
            FollowingRefreshAuth.RetryLater(cause),
            classifyBackgroundToken(OxyBackgroundToken.Transient(cause)),
        )
    }

    /**
     * The SDK's exception is carried through, not discarded.
     *
     * It is the ONLY account of why a widget stopped updating: this surface has no way to show an
     * error, so the log is the whole diagnosis, and a failure that arrives without its cause reads
     * exactly like a worker that never ran. That confusion happened during this widget's own
     * verification, which is why it is pinned.
     */
    @Test
    fun `the failure carries its cause, so the worker can say why`() {
        val transientCause = IOException("dns failure")
        val malformedCause = IOException("expiresAt was not an instant")

        val retry = classifyBackgroundToken(OxyBackgroundToken.Transient(transientCause))
        val stop = classifyBackgroundToken(OxyBackgroundToken.Malformed(malformedCause))

        assertSame(transientCause, (retry as FollowingRefreshAuth.RetryLater).cause)
        assertSame(malformedCause, (stop as FollowingRefreshAuth.GiveUp).cause)
    }

    /**
     * Malformed is NOT retryable: the same request would return the same unreadable body. The
     * credential is kept because nothing proves it is bad, so the widget keeps its content — this
     * needs an app update, not a wake-up.
     */
    @Test
    fun `a malformed response stops without signing the reader out`() {
        val cause = IOException("expiresAt was not an instant")

        assertEquals(
            FollowingRefreshAuth.GiveUp(cause),
            classifyBackgroundToken(OxyBackgroundToken.Malformed(cause)),
        )
    }

    /**
     * The two failure modes must stay DISTINGUISHABLE.
     *
     * Collapsing them is the tempting simplification — both "keep the content and do not fetch" —
     * and it would cost the retry on the case that deserves one. This is the assertion that fails
     * if someone maps them onto a single outcome.
     */
    @Test
    fun `transient and malformed are not the same answer`() {
        val cause = IOException("x")

        assertEquals(
            FollowingRefreshAuth.RetryLater(cause),
            classifyBackgroundToken(OxyBackgroundToken.Transient(cause)),
        )
        assertEquals(
            FollowingRefreshAuth.GiveUp(cause),
            classifyBackgroundToken(OxyBackgroundToken.Malformed(cause)),
        )
    }

    /**
     * And neither failure may be confused with a sign-out, in EITHER direction.
     *
     * This is the assertion that would catch the most damaging single-character mistake available
     * in `classifyBackgroundToken` — mapping a `Transient` to `SignedOut` (a tunnel wipes the
     * widget) or a `SignedOut` to `RetryLater` (private posts outlive the session).
     */
    @Test
    fun `only a proven end of session is signed out`() {
        val offline = IOException("offline")
        val badShape = IOException("bad shape")

        assertEquals(
            FollowingRefreshAuth.SignedOut,
            classifyBackgroundToken(OxyBackgroundToken.SignedOut),
        )
        assertEquals(
            FollowingRefreshAuth.RetryLater(offline),
            classifyBackgroundToken(OxyBackgroundToken.Transient(offline)),
        )
        assertEquals(
            FollowingRefreshAuth.GiveUp(badShape),
            classifyBackgroundToken(OxyBackgroundToken.Malformed(badShape)),
        )
    }
}
