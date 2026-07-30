package earth.mention.widgets.posts

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStore
import androidx.glance.action.Action
import androidx.glance.appwidget.action.actionRunCallback
import earth.mention.widgets.R
import earth.mention.widgets.feedcard.FeedCardSpec
import earth.mention.widgets.feedcard.FeedImageCache
import earth.mention.widgets.feedcard.FeedRotationStore
import earth.mention.widgets.feedcard.webBaseUrl

/**
 * How the trending-posts widget is configured — its store, and the four things about it that
 * the shared card cannot know.
 *
 * The card itself, its breakpoints, its bitmap budget and its rotation live in
 * `earth.mention.widgets.feedcard` and are shared with the following widget. What is left
 * here is this widget's identity: where its rotation is kept, what the brand row says, and
 * which callbacks its chevrons run.
 */

/** This widget's own preferences file. Named as it was, so an update keeps its rotation. */
private val Context.postsDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "mention_widget_posts",
)

/** The trending-posts rotation. */
internal val PostsStore = FeedRotationStore { postsDataStore }

/**
 * This widget's image cache. Its own directory, kept at the name it already had so an app
 * update does not orphan the files already on disk — see `FeedImageCache` for why the two
 * widgets do not share one.
 */
internal val PostsImages = FeedImageCache("mention_widget_posts_images")

/**
 * Explore's rotation is ANONYMOUS, so it has no account to be stamped with.
 *
 * A named constant rather than a bare `null` at four call sites, because `null` here is a
 * decision — this feed carries no identity at all — and not an absent value someone forgot to
 * supply. `GET /feed/mtn?descriptor=explore` answers an unauthenticated request with a full
 * page, which is the whole reason this widget needs no session; see `PostsApi`.
 */
internal val POSTS_ACCOUNT_ID: String? = null

internal object PostsCardSpec : FeedCardSpec {

    override val eyebrow: Int = R.string.mention_posts_widget_eyebrow

    override val emptyMessage: Int = R.string.mention_posts_widget_empty

    /** The Explore feed this rotation is drawn from. */
    override fun feedScreenUrl(context: Context): String = "${webBaseUrl(context)}/explore"

    override val previousAction: Action get() = actionRunCallback<PreviousPostAction>()

    override val nextAction: Action get() = actionRunCallback<NextPostAction>()

    override val images: FeedImageCache = PostsImages
}
