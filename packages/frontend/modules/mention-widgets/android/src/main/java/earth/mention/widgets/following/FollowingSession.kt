package earth.mention.widgets.following

import so.oxy.session.OxyBackgroundToken

/**
 * WHAT A REFRESH DOES ABOUT THE SESSION IT WAS HANDED — the privacy contract of this widget,
 * as one pure function.
 *
 * ## Why the following widget needs this and the trending one does not
 *
 * Explore answers an unauthenticated request, so the trending-posts card carries no identity
 * and nothing it draws is private. A following timeline is the opposite: it is one person's
 * private reading, rendered on a home screen — a surface a stranger can see over a shoulder,
 * beside a lock screen, in a photo. So this widget needs an explicit answer to three
 * questions, and they are answered HERE rather than scattered through the worker:
 *
 *  - **There is no session.** Render the signed-out state and DELETE the stored rotation.
 *    Not hide it, delete it: a session that has ended must take its timeline off the home
 *    screen, and a rotation left on disk would be drawn again by any composition that ran
 *    before the next refresh. This is [SignedOut], and it is a SUCCESS — nothing went wrong,
 *    and retrying cannot change the answer.
 *  - **The credential was rejected.** Identical treatment, and deliberately indistinguishable
 *    to the reader. The SDK has already deleted the credential by the time we see this, and
 *    `account_not_on_device` — the verdict for a credential whose account is no longer the
 *    device's active one — arrives on this same path. So an account switch degrades to
 *    signed-out immediately and quietly rather than showing an error, and CANNOT show the
 *    other account's posts.
 *  - **The network failed.** Keep the last known content and try again ([RetryLater]). A
 *    signed-in user must never be told they are signed out because a request timed out; that
 *    is the mistake that logged people out of this ecosystem once already, which is why the
 *    SDK classifies any ambiguous 401 as transient and why this function trusts that
 *    classification rather than re-deriving it.
 *
 * ## Why it is pure
 *
 * Given a token it returns a decision and touches nothing, so all four branches are unit
 * tested on a plain JVM. The alternative — reading the token inside the worker and branching
 * there — puts the widget's whole privacy behaviour somewhere a test cannot reach.
 */
internal sealed interface FollowingRefreshAuth {

    /** Fetch with this bearer, and stamp the stored rotation with [accountId]. */
    data class Authorized(val accessToken: String, val accountId: String) : FollowingRefreshAuth

    /**
     * Draw the signed-out card and forget the stored rotation.
     *
     * Final for this run: the user is genuinely signed out (or was switched away), and only
     * opening the app can change that.
     */
    data object SignedOut : FollowingRefreshAuth

    /**
     * Keep the last known content and back off — the user is NOT signed out.
     *
     * [cause] is the SDK's own exception, carried rather than discarded so the refresh worker can
     * log WHY a widget is not updating. Dropping it made a mint failure indistinguishable from a
     * worker that never ran, which cost real debugging time.
     */
    data class RetryLater(val cause: Exception) : FollowingRefreshAuth

    /**
     * Keep the last known content and stop asking.
     *
     * The server answered in a shape this build cannot read, so the same request would
     * return the same body. Nothing proves the credential is bad, so it is kept and the
     * widget keeps its content; this needs an app update, not a retry.
     */
    data class GiveUp(val cause: Exception) : FollowingRefreshAuth
}

/**
 * Map the SDK's token outcome onto what this refresh should do.
 *
 * The mapping is 1:1 with `OxyBackgroundToken`'s four cases on purpose — the SDK has already
 * made the hard call about which failures prove a credential is dead (only an explicit server
 * verdict) and which do not (everything else, including an unrecognised 401). Re-deciding that
 * here would be a second, divergent policy for the same question.
 */
internal fun classifyBackgroundToken(token: OxyBackgroundToken): FollowingRefreshAuth =
    when (token) {
        is OxyBackgroundToken.Available -> FollowingRefreshAuth.Authorized(
            accessToken = token.accessToken,
            // The SERVER's answer, echoed back by the mint — never a local guess. It is what
            // the rotation is stamped with, so a rotation can only ever be drawn for the
            // account the server actually authorized.
            accountId = token.accountId,
        )

        OxyBackgroundToken.SignedOut -> FollowingRefreshAuth.SignedOut

        is OxyBackgroundToken.Transient -> FollowingRefreshAuth.RetryLater(token.cause)

        is OxyBackgroundToken.Malformed -> FollowingRefreshAuth.GiveUp(token.cause)
    }
