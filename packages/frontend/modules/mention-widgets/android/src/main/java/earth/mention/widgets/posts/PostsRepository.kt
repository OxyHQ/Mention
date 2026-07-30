package earth.mention.widgets.posts

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * The rotation the trending-posts widget is showing: the posts, and which one is up.
 *
 * A SEPARATE store from the trends widgets', not a second key in theirs. The two
 * families fetch different endpoints on different schedules and are placed
 * independently, so sharing a store would mean a trends refresh waking a write that
 * every posts widget then re-renders for nothing.
 *
 * Like the trends store, this is APP-SCOPED rather than per widget instance: two posts
 * widgets on the same home screen show the same rotation, so one store means one write
 * per tick, and a widget placed while the app is running paints real content on its first
 * frame instead of an empty box.
 *
 * It is a [DataStore] rather than SharedPreferences for the [Flow]. A Glance session
 * that is already running does not re-enter `provideGlance` when `updateAll` is called,
 * so a widget reading a non-reactive source would sit on whatever it read when its
 * session started — which for a widget whose whole behaviour is rotating would mean it
 * never rotated.
 */
private val Context.postsDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "mention_widget_posts",
)

/** The stored rotation. */
internal data class PostsRotation(
    val posts: List<WidgetPost>,
    /**
     * Position in [posts]. Read through [postAt], which brings it into range — a stored
     * index can outlive the rotation it was an index into.
     */
    val index: Int,
    /**
     * When the posts were last fetched, as `System.currentTimeMillis`, or `0` when they
     * never have been. Drives the fetch/rotate decision in `PostsRefreshWorker`.
     */
    val fetchedAtMs: Long,
) {
    /** The post on screen, or `null` before the first successful fetch. */
    val current: WidgetPost? get() = postAt(posts, index)
}

internal object PostsRepository {
    private val KEY_POSTS = stringPreferencesKey("posts")
    private val KEY_INDEX = intPreferencesKey("index")
    private val KEY_FETCHED_AT = longPreferencesKey("fetchedAt")

    /** Emits on every write, which is what re-renders a live widget. */
    fun rotation(context: Context): Flow<PostsRotation> =
        context.applicationContext.postsDataStore.data.map { preferences ->
            PostsRotation(
                posts = decodePosts(preferences[KEY_POSTS]),
                index = preferences[KEY_INDEX] ?: 0,
                fetchedAtMs = preferences[KEY_FETCHED_AT] ?: 0L,
            )
        }

    /** The rotation as it stands right now. */
    suspend fun read(context: Context): PostsRotation = rotation(context).first()

    /**
     * Store a freshly fetched rotation.
     *
     * The position resets to the top only when the CONTENT changed. Explore returns
     * largely the same posts from one half-hour to the next, and a reset on every fetch
     * would put the widget back on post one twice an hour — the rotation would spend most
     * of its life on the first two of five.
     */
    suspend fun saveFetched(context: Context, posts: List<WidgetPost>, fetchedAtMs: Long) {
        context.applicationContext.postsDataStore.edit { preferences ->
            val previousIds = decodePosts(preferences[KEY_POSTS]).map { it.id }
            preferences[KEY_POSTS] = encodePosts(posts)
            preferences[KEY_FETCHED_AT] = fetchedAtMs
            if (previousIds != posts.map { it.id }) {
                preferences[KEY_INDEX] = 0
            }
        }
    }

    /**
     * Move to the next post.
     *
     * The size is read inside the transaction rather than passed in, so an advance can
     * never be computed against a rotation that a concurrent fetch has already replaced.
     */
    suspend fun advance(context: Context) {
        context.applicationContext.postsDataStore.edit { preferences ->
            val size = decodePosts(preferences[KEY_POSTS]).size
            preferences[KEY_INDEX] = nextRotationIndex(preferences[KEY_INDEX] ?: 0, size)
        }
    }

    /**
     * Move to the previous post — what the card's back control does.
     *
     * Reads the size inside the transaction for the same reason [advance] does, and that
     * matters more here: a tap arrives at a moment the user chose, which is far likelier to
     * land during a fetch than a scheduled tick is.
     */
    suspend fun retreat(context: Context) {
        context.applicationContext.postsDataStore.edit { preferences ->
            val size = decodePosts(preferences[KEY_POSTS]).size
            preferences[KEY_INDEX] = previousRotationIndex(preferences[KEY_INDEX] ?: 0, size)
        }
    }
}
