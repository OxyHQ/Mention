package earth.mention.widgets.feedcard

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * The rotation a feed-card widget is showing: the posts, and which one is up.
 *
 * ONE INSTANCE PER WIDGET FAMILY, each over its own [DataStore] — see `PostsStore` and
 * `FollowingStore`. They are separate stores rather than keys in one because the two
 * widgets fetch different endpoints on different schedules and are placed
 * independently: a shared store would mean either refresh waking a write that every
 * widget of the other kind then re-renders for nothing. Neither shares with the trends
 * widgets, for the same reason.
 *
 * Each store is APP-SCOPED rather than per widget instance: two following widgets on the
 * same home screen show the same rotation, so one store means one write per tick, and a
 * widget placed while the app is running paints real content on its first frame instead
 * of an empty box.
 *
 * It is a [DataStore] rather than SharedPreferences for the [Flow]. A Glance session that
 * is already running does not re-enter `provideGlance` when `updateAll` is called, so a
 * widget reading a non-reactive source would sit on whatever it read when its session
 * started — which for a widget whose whole behaviour is rotating would mean it never
 * rotated.
 */
internal class FeedRotationStore(private val dataStore: Context.() -> DataStore<Preferences>) {

    private val KEY_POSTS = stringPreferencesKey("posts")
    private val KEY_INDEX = intPreferencesKey("index")
    private val KEY_FETCHED_AT = longPreferencesKey("fetchedAt")

    /**
     * The account the stored rotation was fetched for, or absent for an anonymous feed.
     *
     * This is the local half of the account-correctness rule that makes an authenticated
     * feed widget safe to cache at all: [rotation] reports a rotation stamped with any
     * OTHER account as EMPTY, so posts fetched for the previous account can never be drawn
     * under the new one's name. Anonymous feeds (Explore) never write it and never ask.
     */
    private val KEY_ACCOUNT_ID = stringPreferencesKey("accountId")

    /**
     * Emits on every write, which is what re-renders a live widget.
     *
     * [expectedAccountId] is the account the CALLER is currently authorized as — `null` for
     * an anonymous feed. A stored rotation stamped with a different account is reported as
     * empty rather than drawn, which is what makes an account switch show the widget's
     * signed-out/first-run state instead of the previous account's timeline. It is reported
     * empty rather than deleted here because this is a read: `clear` is the writer, and it
     * is called from the worker that notices.
     */
    fun rotation(context: Context, expectedAccountId: String?): Flow<FeedRotation> =
        context.applicationContext.dataStore().data.map { preferences ->
            rotationFor(
                storedAccountId = preferences[KEY_ACCOUNT_ID],
                expectedAccountId = expectedAccountId,
                storedPosts = preferences[KEY_POSTS],
                storedIndex = preferences[KEY_INDEX],
                storedFetchedAtMs = preferences[KEY_FETCHED_AT],
            )
        }

    /** The rotation as it stands right now. */
    suspend fun read(context: Context, expectedAccountId: String?): FeedRotation =
        rotation(context, expectedAccountId).first()

    /**
     * Store a freshly fetched rotation, stamped with the account it belongs to.
     *
     * [accountId] is the server's answer for an authenticated feed (never a local guess)
     * and `null` for an anonymous one. Writing it in the same transaction as the posts is
     * what makes the stamp trustworthy: there is no window in which posts are stored
     * without the account they were fetched for.
     *
     * The position resets to the top only when the CONTENT changed. A feed returns largely
     * the same posts from one half-hour to the next, and a reset on every fetch would put
     * the widget back on post one twice an hour — the rotation would spend most of its life
     * on the first two of five.
     */
    suspend fun saveFetched(
        context: Context,
        posts: List<WidgetPost>,
        fetchedAtMs: Long,
        accountId: String?,
    ) {
        context.applicationContext.dataStore().edit { preferences ->
            val previousIds = decodePosts(preferences[KEY_POSTS]).map { it.id }
            val previousAccountId = preferences[KEY_ACCOUNT_ID]
            preferences[KEY_POSTS] = encodePosts(posts)
            preferences[KEY_FETCHED_AT] = fetchedAtMs
            if (accountId == null) {
                preferences.remove(KEY_ACCOUNT_ID)
            } else {
                preferences[KEY_ACCOUNT_ID] = accountId
            }
            // A different account is a different rotation however similar its ids, so the
            // cursor goes back to the top rather than landing mid-way through someone
            // else's five posts.
            if (previousIds != posts.map { it.id } || previousAccountId != accountId) {
                preferences[KEY_INDEX] = 0
            }
        }
    }

    /**
     * Forget everything — the posts, the cursor and the account stamp.
     *
     * This is the PRIVACY-LOAD-BEARING half of the signed-out path, and it is why the
     * following widget deletes rather than hides: a home screen is a lock-screen-adjacent
     * surface, and someone else's session ending must take their timeline off it. The card
     * then draws its signed-out state from an empty store, so there is nothing left to leak
     * even if a later composition runs before the next refresh.
     */
    suspend fun clear(context: Context) {
        context.applicationContext.dataStore().edit { preferences -> preferences.clear() }
    }

    /**
     * Move to the next post.
     *
     * The size is read inside the transaction rather than passed in, so an advance can
     * never be computed against a rotation that a concurrent fetch has already replaced.
     */
    suspend fun advance(context: Context) {
        context.applicationContext.dataStore().edit { preferences ->
            val size = decodePosts(preferences[KEY_POSTS]).size
            preferences[KEY_INDEX] = nextRotationIndex(preferences[KEY_INDEX] ?: 0, size)
        }
    }
}

/**
 * THE ACCOUNT-CORRECTNESS RULE, as a pure function: what a store's raw values mean to a caller
 * authorized as [expectedAccountId].
 *
 * A stored rotation is only ever handed back when its stamp MATCHES. Any mismatch — a rotation
 * stamped with another account, an authenticated caller finding an unstamped (anonymous) rotation,
 * or an anonymous caller finding a stamped one — yields an EMPTY rotation, which every card draws
 * as its first-run state.
 *
 * It is pulled out of [FeedRotationStore.rotation] and made pure for one reason: this is the
 * single decision that stops one account's private timeline from being rendered under another
 * account's name, and inside a `DataStore` flow it would be reachable only from an instrumented
 * test. Here every branch is pinned on a plain JVM.
 *
 * `==` on two nullable strings is doing real work in all four directions, which is why the
 * mismatch cases are enumerated in the tests rather than left to read as obvious.
 */
internal fun rotationFor(
    storedAccountId: String?,
    expectedAccountId: String?,
    storedPosts: String?,
    storedIndex: Int?,
    storedFetchedAtMs: Long?,
): FeedRotation {
    if (storedAccountId != expectedAccountId) {
        return FeedRotation(posts = emptyList(), index = 0, fetchedAtMs = 0L)
    }
    return FeedRotation(
        posts = decodePosts(storedPosts),
        index = storedIndex ?: 0,
        fetchedAtMs = storedFetchedAtMs ?: 0L,
    )
}

/** The stored rotation. */
internal data class FeedRotation(
    val posts: List<WidgetPost>,
    /**
     * Position in [posts]. Read through [postAt], which brings it into range — a stored
     * index can outlive the rotation it was an index into.
     */
    val index: Int,
    /**
     * When the posts were last fetched, as `System.currentTimeMillis`, or `0` when they
     * never have been. Drives the fetch/rotate decision in [shouldFetchRotation].
     */
    val fetchedAtMs: Long,
) {
    /** The post on screen, or `null` before the first successful fetch. */
    val current: WidgetPost? get() = postAt(posts, index)
}
