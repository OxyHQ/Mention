package earth.mention.widgets.feedcard

import android.content.Context
import android.util.Log
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.updateAll

/**
 * WHAT HAPPENS WHEN THE RUNNING APP HANDS ITS FEED TO A WIDGET.
 *
 * ## Why this exists
 *
 * A widget refreshes on WorkManager's floor of fifteen minutes and only goes to the network
 * once its batch is half an hour old, so the posts on a home screen can be thirty minutes
 * behind — further under Doze. Meanwhile the app, whenever it is opened, downloads that
 * same feed anyway. Handing the page it already has to the widget's store costs ZERO extra
 * requests and makes the card current at the moment its owner was demonstrably engaged.
 *
 * That is true of the HANDOFF and only of the handoff. [handoffPrefetchWanted] below governs
 * a second path that does spend a request — see its own doc, and do not carry the sentence
 * above onto it.
 *
 * The worker is not replaced by this and must not be: the app is opened irregularly, and a
 * widget on a phone nobody has opened for a day still has to update itself.
 *
 * ## The account stamp is the whole safety property, and JS does not get to set it
 *
 * The following widget draws one person's private reading on a surface a stranger can see.
 * [FeedRotationStore.saveFetched] stamps the rotation with the account it was fetched for
 * and [rotationFor] reports a rotation stamped with any OTHER account as EMPTY — that pair
 * is what stops a previous account's timeline surfacing after a switch.
 *
 * So a handoff is only ever stamped with the account the DEVICE CREDENTIAL says it is
 * provisioned for (`OxyBackgroundSession.activeAccountId`) — the same value the widget's
 * own composition reads the store with, and the server's answer rather than anything JS
 * asserted. What JS sends is a CLAIM about which account it fetched the page as, and the
 * claim's only power is to REFUSE: it has to match, or nothing is written. A page fetched
 * as A while the device has moved to B is dropped rather than reconciled.
 */

/** What [accountFeedHandoff] and [anonymousFeedHandoff] decided about a handed-over page. */
internal sealed interface FeedHandoff {

    /**
     * Store the page, stamped with [accountId] — `null` for an anonymous feed, which is a
     * decision (this feed carries no identity) and not a missing value.
     */
    data class Write(val accountId: String?) : FeedHandoff

    /** Store nothing. [reason] is logged; it is never shown. */
    data class Refuse(val reason: HandoffRefusal) : FeedHandoff
}

/**
 * Why a handoff was dropped.
 *
 * An enum rather than a message string because these are branches a test pins, and a
 * refusal that reads "different account" has to be distinguishable from one that reads
 * "no credential" — the first means an account switch raced the feed request, the second
 * means background auth was never provisioned, and they are diagnosed differently.
 */
internal enum class HandoffRefusal {

    /** The page was empty, or every post in it was dropped by the card's own rules. */
    NOTHING_TO_WRITE,

    /** An authenticated handoff arrived without naming the account it was fetched for. */
    NO_ACCOUNT_CLAIMED,

    /**
     * There is no background credential on this device, so there is no account to stamp
     * with — and a rotation stamped with anything else would read back as empty anyway.
     */
    NO_CREDENTIAL,

    /**
     * The page was fetched as one account and the device is provisioned for another.
     *
     * The switch happened while the request was in flight, or JS and the credential store
     * disagree. Either way this page belongs to somebody else and is dropped.
     */
    DIFFERENT_ACCOUNT,
}

/**
 * The decision for an AUTHENTICATED feed — the following widget's.
 *
 * Pure, and separated from the write for the same reason the sign-out classification is
 * (`FollowingSession.kt`): this is the one comparison standing between one account's
 * private timeline and another account's home screen, and inside a suspend function that
 * touches a keystore and a DataStore it would be reachable only from an instrumented test.
 * Here every direction of it is pinned on a plain JVM.
 *
 * [claimedAccountId] is the account JS says it fetched the page as; [deviceAccountId] is
 * what the background credential says this device is provisioned for, or `null` when there
 * is none. The account rules are checked BEFORE emptiness so a mismatch is reported as a
 * mismatch rather than as an empty page.
 */
internal fun accountFeedHandoff(
    claimedAccountId: String,
    deviceAccountId: String?,
    postCount: Int,
): FeedHandoff {
    if (claimedAccountId.isBlank()) return FeedHandoff.Refuse(HandoffRefusal.NO_ACCOUNT_CLAIMED)
    if (deviceAccountId == null) return FeedHandoff.Refuse(HandoffRefusal.NO_CREDENTIAL)
    if (deviceAccountId != claimedAccountId) {
        return FeedHandoff.Refuse(HandoffRefusal.DIFFERENT_ACCOUNT)
    }
    if (postCount <= 0) return FeedHandoff.Refuse(HandoffRefusal.NOTHING_TO_WRITE)
    // The DEVICE's answer, not the claim — they are equal here, and writing the one the
    // composition will read the store back with is the version that stays correct if these
    // two ever stop being the same string.
    return FeedHandoff.Write(deviceAccountId)
}

/**
 * The decision for an ANONYMOUS feed — the trending-posts widget's.
 *
 * It deliberately never consults the device credential. Explore answers an unauthenticated
 * request with a full page (see `PostsApi`), so this rotation carries no identity and must
 * be stamped with none: asking who is signed in would make a public discovery feed stop
 * working for a signed-out reader, and stamping it with an account would make the store
 * unreadable to the widget, which reads it anonymously.
 *
 * The page the app hands over is fetched with the reader's own bearer, so it can be a
 * narrower selection than the widget's own anonymous fetch — an author they blocked is
 * missing from it. It cannot be a WIDER one: `exploreSource` applies `DISCOVERY_SAFE_MATCH`
 * unconditionally rather than per viewer, so nothing gated reaches this store by this door
 * that could not reach it by the worker's.
 */
internal fun anonymousFeedHandoff(postCount: Int): FeedHandoff =
    if (postCount <= 0) {
        FeedHandoff.Refuse(HandoffRefusal.NOTHING_TO_WRITE)
    } else {
        FeedHandoff.Write(null)
    }

/**
 * Whether it is worth the app spending a REQUEST to fill this widget — the one path here
 * that is not free, and the gate that keeps it affordable.
 *
 * ## Why a request is on the table at all
 *
 * The handoff above rides on a feed the app was fetching anyway, so it costs nothing — but
 * it only fires for the feed the reader actually opened, and Mention's home defaults to For
 * You. So the FOLLOWING widget is fed only when someone visits a tab they may rarely visit,
 * which for most readers means a widget that does not update. That is the card whose
 * staleness shows most, because it is their own people on it.
 *
 * ## Three conditions, all required
 *
 *  - **A widget is placed.** A reader who never put one on a home screen must not pay a
 *    request for it, ever. This is the condition that makes the feature cost nothing for
 *    almost everyone.
 *  - **There is a credential.** With no background session there is no account to stamp a
 *    rotation with, so a fetched page could not be stored even if it arrived — and the card
 *    is drawing its signed-out state regardless.
 *  - **The stored batch is stale**, by [shouldFetchRotation] — the SAME rule the refresh
 *    worker applies, so the app and the worker cannot disagree about what "stale" means.
 *    Without this the app would spend a request on every cold start; with it the ceiling is
 *    one per [FETCH_INTERVAL_MS] of app usage, and a reader who opens the app five times an
 *    hour pays for two.
 *
 * Pure, so all four branches are pinned on a plain JVM — including the two that cost a
 * request when they should not.
 */
internal fun handoffPrefetchWanted(
    placed: Boolean,
    deviceAccountId: String?,
    stored: FeedRotation,
    nowMs: Long,
): Boolean {
    if (!placed) return false
    if (deviceAccountId == null) return false
    return shouldFetchRotation(stored, nowMs)
}

/**
 * Store a handed-over rotation and bring the card up to date.
 *
 * Ordered as the refresh workers order it, and for the same reasons: the pictures are on
 * disk before the redraw, or the card paints a byline with no avatar; the prune runs
 * against the new rotation, so what the cache keeps is what the widget can now draw.
 *
 * The REDRAW is conditional on the content having actually changed, and the store write is
 * not. That split is the point of the whole feature — writing `fetchedAt` is what tells the
 * next worker tick it has nothing to fetch, and it is worth doing on every handoff even
 * when the same five posts come back; re-serialising this widget's decoded bitmaps across
 * the process boundary to paint an identical card is not. A Glance session that is already
 * running still recomposes, because the store write emits on its flow.
 *
 * The images are fetched HERE, on the app's foreground network, rather than left to the
 * worker: at most ten small files (five avatars of about 1.6KB and up to five thumbnails),
 * already warm in the app's own image cache upstream, and the alternative is waking a radio
 * later to fetch what we could have taken now. Failures are per-file and silent by design —
 * a picture that will not download costs that card its picture, never the card.
 */
internal suspend fun publishHandoff(
    context: Context,
    store: FeedRotationStore,
    images: FeedImageCache,
    widget: GlanceAppWidget,
    accountId: String?,
    posts: List<WidgetPost>,
    nowMs: Long,
) {
    val previousIds = store.read(context, accountId).posts.map { post -> post.id }
    store.saveFetched(context, posts, nowMs, accountId)

    val urls = rotationImageUrls(context, posts)
    images.prune(context, urls)
    urls.forEach { url -> images.ensureCached(context, url) }

    if (previousIds != posts.map { post -> post.id }) {
        widget.updateAll(context)
    }
}

/**
 * Report what a handoff did.
 *
 * Logged rather than returned to JS, on the same reasoning as the refresh workers: a widget
 * that quietly stops updating is the hardest thing to diagnose on this surface — there is
 * no UI to show an error in, by design — so the log is the only account of why. The caller
 * fires and forgets, so a rejection surfaced across the bridge would be dropped anyway.
 */
internal fun logHandoff(tag: String, feed: String, outcome: FeedHandoff, postCount: Int) {
    when (outcome) {
        is FeedHandoff.Write -> Log.i(tag, "The app handed the $feed widget $postCount posts")
        is FeedHandoff.Refuse ->
            Log.w(tag, "Ignored a $feed handoff from the app: ${outcome.reason}")
    }
}
