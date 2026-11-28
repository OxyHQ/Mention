package earth.mention.widgets.following

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStore
import earth.mention.widgets.R
import earth.mention.widgets.feedcard.FeedCardSpec
import earth.mention.widgets.feedcard.FeedImageCache
import earth.mention.widgets.feedcard.FeedRotationStore
import earth.mention.widgets.feedcard.webBaseUrl

/**
 * How the following widget is configured — its store, and the four things about it that the
 * shared card cannot know.
 *
 * The card, its breakpoints, its bitmap budget and its rotation are the SAME CODE the
 * trending-posts widget draws (`earth.mention.widgets.feedcard`). What is here is this
 * widget's identity: where its rotation is kept, what the brand row says, and which callbacks
 * its chevrons run.
 */

/**
 * This widget's own preferences file, separate from the trending widget's.
 *
 * Separate for the usual reason — two feeds on two schedules, placed independently — and for
 * one specific to this widget: this store holds PRIVATE content stamped with an account id,
 * and `FeedRotationStore.clear` wipes it on sign-out. Sharing a file with the anonymous
 * Explore rotation would mean a sign-out either blanking a widget that has nothing to hide or
 * leaving private posts behind to avoid doing so.
 */
private val Context.followingDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "mention_widget_following",
)

/** The following rotation. Always stamped with the account it was fetched for. */
internal val FollowingStore = FeedRotationStore { followingDataStore }

/**
 * This widget's image cache — its own directory, for the reason given on `FeedImageCache`.
 *
 * It is NOT wiped on sign-out, and that is a deliberate limit rather than an oversight: the
 * files are keyed by URL, so what survives is a handful of thumbnails with no post, no author
 * and no account attached to them, in the app's own private cache directory which the system
 * may clear at any time. Deleting them on sign-out would also be exact enough to be worth
 * doing — but it is the ROTATION that names who follows whom, and that is what `signOut`
 * destroys.
 */
internal val FollowingImages = FeedImageCache("mention_widget_following_images")

internal object FollowingCardSpec : FeedCardSpec {

    override val eyebrow: Int = R.string.mention_following_widget_eyebrow

    override val emptyMessage: Int = R.string.mention_following_widget_empty

    /**
     * The app's home feed, which is the following timeline at full size.
     *
     * `/` rather than a `/following` path: the following feed is the home screen's own tab in
     * the app, not a route of its own. This is also where the signed-out card's button goes —
     * opening the app is exactly what re-provisions the credential, so the one action offered
     * to a signed-out reader is the action that fixes their widget.
     */
    override fun feedScreenUrl(context: Context): String = webBaseUrl(context)

    override val images: FeedImageCache = FollowingImages
}
