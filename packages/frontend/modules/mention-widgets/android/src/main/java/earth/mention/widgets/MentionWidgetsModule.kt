package earth.mention.widgets

<<<<<<< HEAD
import android.content.Context
import android.util.Log
import earth.mention.widgets.feedcard.FeedHandoff
import earth.mention.widgets.feedcard.accountFeedHandoff
import earth.mention.widgets.feedcard.anonymousFeedHandoff
import earth.mention.widgets.feedcard.anyPlaced
import earth.mention.widgets.feedcard.handoffPrefetchWanted
import earth.mention.widgets.feedcard.logHandoff
import earth.mention.widgets.feedcard.parseHandoffPosts
import earth.mention.widgets.feedcard.publishHandoff
import earth.mention.widgets.following.FollowingImages
import earth.mention.widgets.following.FollowingStore
import earth.mention.widgets.following.FollowingWidget
import earth.mention.widgets.following.FollowingWidgetReceiver
import earth.mention.widgets.posts.PostsImages
import earth.mention.widgets.posts.PostsStore
import earth.mention.widgets.posts.PostsWidget
import earth.mention.widgets.posts.PostsWidgetReceiver
import earth.mention.widgets.trends.TrendsRefreshScheduler
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONException
import so.oxy.session.OxyBackgroundSession
=======
import earth.mention.widgets.trends.TrendsRefreshScheduler
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)

/**
 * JS side of Mention's home-screen widgets.
 *
<<<<<<< HEAD
 * Deliberately small, and it will stay that way. A widget has to work while the app is not
 * running, so every widget owns its own data end to end in Kotlin — fetch, store, render,
 * deep link. Anything JS also did would be a second copy of that path, correct only for as
 * long as both stayed in step.
 *
 * What is left for JS is the one thing only a RUNNING app can know: what it is looking at
 * right now.
 *
 *  - `refreshTrends` — the trending batch rotated while the user was reading it, so fetch
 *    now instead of at the end of the schedule. Control, not data.
 *  - `publishTrendingFeed` / `publishFollowingFeed` — the app has just downloaded the very
 *    feed a card draws, so hand it over rather than making a worker fetch it again half an
 *    hour later. Data, and the ONE case where JS supplying it is cheaper than the widget
 *    fetching it: the request has already happened.
 *  - `followingWidgetNeedsFeed` — the one function here that leads to a request being
 *    SPENT rather than saved. It exists because the handoff only ever covers the feed the
 *    reader opened, and home defaults to For You; it answers `false` unless a following
 *    widget is placed AND its batch is stale, so almost every caller pays nothing.
 *
 * The `publish*` pair is not a second implementation of the fetch path. JS supplies raw
 * strings; every rule about what a card shows, and the account stamp that decides whether a
 * rotation may be drawn at all, stays in `feedcard` — see `FeedHandoff.kt`.
 */
class MentionWidgetsModule : Module() {

    private val context: Context
        get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

=======
 * Deliberately tiny, and it will stay that way. A widget has to work while the
 * app is not running, so every widget owns its own data end to end in Kotlin —
 * fetch, store, render, deep link. Anything JS also did would be a second copy
 * of that path, correct only for as long as both stayed in step.
 *
 * What is left for JS is CONTROL, not data: the app is the one thing that can
 * know a trending batch rotated while the user was looking at it, and telling
 * the widget so turns a wait of up to half an hour into a few seconds. The
 * decision of WHEN that is worth doing is in `trendsWidgetSync.ts`.
 */
class MentionWidgetsModule : Module() {
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    override fun definition() = ModuleDefinition {
        Name("MentionWidgets")

        /**
         * Fetch the trending batch now, for whichever trends widgets are placed.
         *
<<<<<<< HEAD
         * Returns as soon as the work is enqueued; the fetch itself runs in WorkManager
         * under the same network constraint as the periodic refresh, and is a no-op when no
         * trends widget of any variant is on the home screen. One fetch serves all three —
         * they read the same store.
         */
        AsyncFunction("refreshTrends") {
            TrendsRefreshScheduler.refreshNow(context)
        }

        /**
         * Hand the trending-posts widget the Explore page the app just downloaded.
         *
         * Anonymous: this rotation carries no identity and is stamped with none. See
         * [anonymousFeedHandoff] for why the reader's own bearer having fetched the page
         * does not make it private.
         *
         * A no-op when the widget is not placed, so JS never has to ask — and that check
         * comes first, before the body is even parsed.
         */
        AsyncFunction("publishTrendingFeed") Coroutine { body: String ->
            if (!anyPlaced(context, PostsWidgetReceiver::class.java)) return@Coroutine

            val posts = readHandoff(body, TRENDING_FEED) ?: return@Coroutine
            val outcome = anonymousFeedHandoff(posts.size)
            logHandoff(TAG, TRENDING_FEED, outcome, posts.size)
            if (outcome !is FeedHandoff.Write) return@Coroutine

            publishHandoff(
                context = context,
                store = PostsStore,
                images = PostsImages,
                widget = PostsWidget(),
                accountId = outcome.accountId,
                posts = posts,
                nowMs = System.currentTimeMillis(),
            )
        }

        /**
         * Whether the following widget would be worth a REQUEST right now.
         *
         * Both gates are facts only this side knows — whether a widget is on a home screen,
         * how old its stored batch is, and whether there is a credential to stamp a new one
         * with — so they are answered here rather than mirrored into JS, where the store's
         * age would have to be a second copy of `FETCH_INTERVAL_MS`.
         *
         * `false` for the overwhelmingly common case of no widget placed, which is what
         * makes this affordable: the caller spends a request only for readers who asked for
         * the card by putting it on their home screen. See [handoffPrefetchWanted].
         */
        // The explicit empty parameter list is required, not stylistic: a bare `{ ... }`
        // could be a lambda taking one implicit `it`, and `Coroutine` has an overload for
        // each arity, so resolution is ambiguous without it.
        AsyncFunction("followingWidgetNeedsFeed") Coroutine { ->
            val deviceAccountId = OxyBackgroundSession.activeAccountId(context)
            handoffPrefetchWanted(
                placed = anyPlaced(context, FollowingWidgetReceiver::class.java),
                deviceAccountId = deviceAccountId,
                // Read for the account the store would be stamped with, so a rotation left
                // by a PREVIOUS account reads as empty here and is correctly called stale
                // rather than mistaken for fresh content.
                stored = FollowingStore.read(context, deviceAccountId),
                nowMs = System.currentTimeMillis(),
            )
        }

        /**
         * Hand the following widget the timeline the app just downloaded, as [accountId].
         *
         * [accountId] is a CLAIM about which account the page was fetched as, and its only
         * power is to refuse: the rotation is stamped with what the device credential says,
         * and a page whose claim does not match it is dropped. See `FeedHandoff.kt`.
         *
         * A no-op when the widget is not placed, so a reader who never put one on a home
         * screen pays nothing for this — not even the parse.
         */
        AsyncFunction("publishFollowingFeed") Coroutine { accountId: String, body: String ->
            if (!anyPlaced(context, FollowingWidgetReceiver::class.java)) return@Coroutine

            val posts = readHandoff(body, FOLLOWING_FEED) ?: return@Coroutine
            val outcome = accountFeedHandoff(
                claimedAccountId = accountId,
                // Read with no network and no mint — the same value the widget's own
                // composition reads the store with.
                deviceAccountId = OxyBackgroundSession.activeAccountId(context),
                postCount = posts.size,
            )
            logHandoff(TAG, FOLLOWING_FEED, outcome, posts.size)
            if (outcome !is FeedHandoff.Write) return@Coroutine

            publishHandoff(
                context = context,
                store = FollowingStore,
                images = FollowingImages,
                widget = FollowingWidget(),
                accountId = outcome.accountId,
                posts = posts,
                nowMs = System.currentTimeMillis(),
            )
        }
    }

    /**
     * Parse a handoff body, or `null` when it is not one this build can read.
     *
     * A malformed body is a JS-side bug rather than anything a user did, and the widget's
     * standing rule is that a bad payload leaves the last good rotation exactly as it was —
     * so it is logged and dropped rather than raised across the bridge, where the caller
     * fires and forgets and nothing would catch it.
     */
    private fun readHandoff(body: String, feed: String) =
        try {
            parseHandoffPosts(body)
        } catch (cause: JSONException) {
            Log.e(TAG, "The app sent a $feed handoff the widget cannot read", cause)
            null
        }

    private companion object {
        const val TAG = "MentionFeedWidget"

        /** Names the two handoffs log under. Not shown to anyone; they read a logcat. */
        const val TRENDING_FEED = "trending"
        const val FOLLOWING_FEED = "following"
=======
         * Returns as soon as the work is enqueued; the fetch itself runs in
         * WorkManager under the same network constraint as the periodic refresh,
         * and is a no-op when no trends widget of any variant is on the home
         * screen. One fetch serves all three — they read the same store.
         */
        AsyncFunction("refreshTrends") {
            val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
            TrendsRefreshScheduler.refreshNow(context)
        }
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
    }
}
