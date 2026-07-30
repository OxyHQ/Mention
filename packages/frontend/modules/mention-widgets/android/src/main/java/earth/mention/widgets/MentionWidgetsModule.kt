package earth.mention.widgets

import android.content.Context
import android.util.Log
import earth.mention.widgets.feedcard.FeedHandoff
import earth.mention.widgets.feedcard.accountFeedHandoff
import earth.mention.widgets.feedcard.anonymousFeedHandoff
import earth.mention.widgets.feedcard.anyPlaced
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

/**
 * JS side of Mention's home-screen widgets.
 *
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
 *
 * The `publish*` pair is not a second implementation of the fetch path. JS supplies raw
 * strings; every rule about what a card shows, and the account stamp that decides whether a
 * rotation may be drawn at all, stays in `feedcard` — see `FeedHandoff.kt`.
 */
class MentionWidgetsModule : Module() {

    private val context: Context
        get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

    override fun definition() = ModuleDefinition {
        Name("MentionWidgets")

        /**
         * Fetch the trending batch now, for whichever trends widgets are placed.
         *
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
    }
}
