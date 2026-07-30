package earth.mention.widgets.feedcard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE ACCOUNT STAMP — the rule that decides whether a stored timeline may be drawn.
 *
 * This is the most safety-critical decision in the feed-card widgets, and it is invisible when it
 * is wrong: a widget showing the previous account's posts after a switch looks exactly like a
 * widget working correctly. So every direction of the comparison is pinned, including the two that
 * read as impossible until an app is upgraded across a version that did not write stamps.
 */
class FeedRotationStoreTest {

    private companion object {
        const val ACCOUNT = "6981c9178fcdefaf81988ffb"
        const val OTHER_ACCOUNT = "70a1d2e3f4b5c6d7e8f90001"

        /** Two posts, in the shape `encodePosts` writes. */
        val STORED_POSTS: String = encodePosts(
            listOf(
                WidgetPost(
                    id = "post_one",
                    text = "A post from someone this reader follows",
                    imageUrl = null,
                    imageAlt = null,
                    authorName = "Ada",
                    authorHandle = "ada",
                    authorAvatar = null,
                ),
                WidgetPost(
                    id = "post_two",
                    text = "Another one",
                    imageUrl = null,
                    imageAlt = null,
                    authorName = "Grace",
                    authorHandle = "grace",
                    authorAvatar = null,
                ),
            ),
        )
    }

    @Test
    fun `a matching stamp yields the stored rotation`() {
        val rotation = rotationFor(
            storedAccountId = ACCOUNT,
            expectedAccountId = ACCOUNT,
            storedPosts = STORED_POSTS,
            storedIndex = 1,
            storedFetchedAtMs = 1_700_000_000_000L,
        )

        assertEquals(2, rotation.posts.size)
        assertEquals(1, rotation.index)
        assertEquals(1_700_000_000_000L, rotation.fetchedAtMs)
        assertEquals("post_two", rotation.current?.id)
    }

    /**
     * The case this whole mechanism exists for: the device's active account changed, and the
     * previous account's posts are still on disk.
     */
    @Test
    fun `another account's rotation is not drawn`() {
        val rotation = rotationFor(
            storedAccountId = OTHER_ACCOUNT,
            expectedAccountId = ACCOUNT,
            storedPosts = STORED_POSTS,
            storedIndex = 1,
            storedFetchedAtMs = 1_700_000_000_000L,
        )

        assertTrue(rotation.posts.isEmpty())
        assertNull(rotation.current)
    }

    /**
     * A stored rotation with NO stamp, read by an authenticated caller.
     *
     * Reachable by upgrading over a build that did not stamp, and it must not be trusted: an
     * unstamped rotation cannot be shown to belong to the account now asking.
     */
    @Test
    fun `an unstamped rotation is not drawn for an authenticated caller`() {
        val rotation = rotationFor(
            storedAccountId = null,
            expectedAccountId = ACCOUNT,
            storedPosts = STORED_POSTS,
            storedIndex = 0,
            storedFetchedAtMs = 1L,
        )

        assertTrue(rotation.posts.isEmpty())
    }

    /**
     * And the reverse: an ANONYMOUS caller must not be handed a rotation that was fetched for
     * somebody. This is the direction that would leak a following timeline into the trending
     * widget's card if the two ever shared a store.
     */
    @Test
    fun `a stamped rotation is not drawn for an anonymous caller`() {
        val rotation = rotationFor(
            storedAccountId = ACCOUNT,
            expectedAccountId = null,
            storedPosts = STORED_POSTS,
            storedIndex = 0,
            storedFetchedAtMs = 1L,
        )

        assertTrue(rotation.posts.isEmpty())
    }

    /** The anonymous feed's own happy path: no stamp on either side. */
    @Test
    fun `an anonymous caller reads an unstamped rotation`() {
        val rotation = rotationFor(
            storedAccountId = null,
            expectedAccountId = null,
            storedPosts = STORED_POSTS,
            storedIndex = 0,
            storedFetchedAtMs = 5L,
        )

        assertEquals(2, rotation.posts.size)
        assertNotNull(rotation.current)
    }

    /**
     * A mismatch reports a rotation that `shouldFetchRotation` will always refetch.
     *
     * Not just cosmetic: were the timestamp carried through from the rejected rotation, a switched
     * account would show the empty card AND decline to fetch for up to half an hour, because the
     * batch it is refusing to draw would still look fresh.
     */
    @Test
    fun `a rejected rotation reports no fetch time, so the next tick refetches`() {
        val rotation = rotationFor(
            storedAccountId = OTHER_ACCOUNT,
            expectedAccountId = ACCOUNT,
            storedPosts = STORED_POSTS,
            storedIndex = 3,
            storedFetchedAtMs = Long.MAX_VALUE,
        )

        assertEquals(0L, rotation.fetchedAtMs)
        assertEquals(0, rotation.index)
        assertTrue(shouldFetchRotation(rotation, nowMs = 1_700_000_000_000L))
    }

    /** A first run: matching (absent) stamps, and nothing stored yet. */
    @Test
    fun `an empty store is the first-run state rather than an error`() {
        val rotation = rotationFor(
            storedAccountId = null,
            expectedAccountId = null,
            storedPosts = null,
            storedIndex = null,
            storedFetchedAtMs = null,
        )

        assertTrue(rotation.posts.isEmpty())
        assertNull(rotation.current)
        assertEquals(0, rotation.index)
        assertEquals(0L, rotation.fetchedAtMs)
    }
}
