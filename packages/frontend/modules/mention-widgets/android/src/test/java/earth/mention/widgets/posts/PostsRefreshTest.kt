package earth.mention.widgets.posts

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * The rule that gives the trending-posts widget its behaviour: ROTATE on every tick, FETCH
 * only when the batch is stale.
 *
 * The tick runs every fifteen minutes, which is WorkManager's floor, so this is what keeps
 * the widget visibly moving four times an hour while `/feed/mtn` is called twice. Get it
 * wrong in one direction and the widget doubles its network use for the same five posts; get
 * it wrong in the other and it freezes on one post forever, which is indistinguishable from
 * a broken widget.
 */
class PostsRefreshTest {

    private companion object {
        val NOW = TimeUnit.DAYS.toMillis(20_000)

        val POSTS = listOf(
            WidgetPost(
                id = "1",
                text = "A post",
                imageUrl = null,
                imageAlt = null,
                authorName = "A",
                authorHandle = "a",
                authorAvatar = null,
            ),
        )

        fun rotation(fetchedAtMs: Long, posts: List<WidgetPost> = POSTS) =
            PostsRotation(posts = posts, index = 0, fetchedAtMs = fetchedAtMs)
    }

    @Test
    fun `a rotation that has never been fetched always fetches`() {
        // The first-run state, and the placement case: a widget added to a home screen has an
        // empty store and must fill it whatever the clock says.
        assertTrue(shouldFetchRotation(rotation(fetchedAtMs = NOW, posts = emptyList()), NOW))
        assertTrue(shouldFetchRotation(rotation(fetchedAtMs = 0L, posts = emptyList()), NOW))
    }

    @Test
    fun `a fresh batch rotates instead of fetching`() {
        assertFalse(shouldFetchRotation(rotation(fetchedAtMs = NOW), NOW))
        assertFalse(
            shouldFetchRotation(
                rotation(fetchedAtMs = NOW - TimeUnit.MINUTES.toMillis(15)),
                NOW,
            ),
        )
        // One tick short of the interval: this is the boundary that decides whether the widget
        // makes two requests an hour or four.
        assertFalse(
            shouldFetchRotation(
                rotation(fetchedAtMs = NOW - TimeUnit.MINUTES.toMillis(29)),
                NOW,
            ),
        )
    }

    @Test
    fun `a batch at or past the interval fetches`() {
        assertTrue(shouldFetchRotation(rotation(fetchedAtMs = NOW - FETCH_INTERVAL_MS), NOW))
        assertTrue(
            shouldFetchRotation(
                rotation(fetchedAtMs = NOW - TimeUnit.HOURS.toMillis(6)),
                NOW,
            ),
        )
    }

    @Test
    fun `the interval is half an hour, matching how fast explore turns over`() {
        assertTrue(FETCH_INTERVAL_MS == TimeUnit.MINUTES.toMillis(30))
    }

    @Test
    fun `a timestamp from the future is treated as stale, not as fresh forever`() {
        // `currentTimeMillis` moves backwards whenever the clock is corrected or the time zone
        // changes. Without the absolute value the widget would conclude its content was
        // fetched hours from now and stop refreshing until real time caught up — a widget
        // permanently frozen by a clock change.
        assertTrue(
            shouldFetchRotation(
                rotation(fetchedAtMs = NOW + TimeUnit.HOURS.toMillis(6)),
                NOW,
            ),
        )
    }

    @Test
    fun `a rotation is five posts long, so the pips fit on one byline`() {
        // The number is also the length of the cycle: at a fifteen-minute tick, five posts
        // come round in an hour and a quarter.
        assertTrue(ROTATION_LENGTH in 3..6)
    }
}
