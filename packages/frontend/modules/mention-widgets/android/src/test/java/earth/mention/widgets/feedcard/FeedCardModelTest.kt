package earth.mention.widgets.feedcard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The trending-posts widget's data rules.
 *
 * The bodies below are the REAL shapes `GET /feed/mtn?descriptor=explore` serves, taken
 * from the live feed on 2026-07-29 and trimmed to the fields the widget reads — including
 * the two cases the design turns on: a post whose text is its link preview's title with a
 * URL glued on, and a post with no text at all.
 *
 * Nothing here draws anything. What is pinned is every decision made before drawing, each of
 * which fails in a way that looks like a working card in code: a card repeating the same
 * sentence twice, a slot with a hole in it, a rotation that crashes on an index.
 */
class FeedCardModelTest {

    private companion object {
        /**
         * A real link post: the body is the headline plus its URL, the preview carries the
         * headline alone, and there is no attached media. 57% of the feed looks like this.
         */
        val LINK_POST = """
            {
              "id": "6a6a82f9c1d2e3f4a5b60001",
              "content": {
                "text": "Microsoft confirms Copilot super app coming this year https://www.theverge.com/tech/972927/x"
              },
              "attachments": {},
              "linkPreviews": [
                {
                  "url": "https://www.theverge.com/tech/972927/x",
                  "title": "Microsoft confirms Copilot super app coming this year",
                  "image": "https://cloud.oxy.so/6a6a7ef1ab026eb594ddb4d4?variant=w320",
                  "siteName": "The Verge"
                }
              ],
              "user": {
                "id": "6a30d42df24acd91fb263b69",
                "username": "verge@mastodon.social",
                "name": { "displayName": "The Verge", "first": "The Verge" },
                "avatar": "6a30d42d0ef11d23d365ad09",
                "isFederated": true
              }
            }
        """.trimIndent()

        /** A real media post: attached media with both URLs, and no preview. 20% of the feed. */
        val MEDIA_POST = """
            {
              "id": "6a6a82f9c1d2e3f4a5b60002",
              "content": { "text": "Look at this" },
              "attachments": {
                "media": [
                  {
                    "id": "6a6a7cf7ab026eb594ddb1a5",
                    "type": "image",
                    "alt": "A cat asleep on a keyboard",
                    "url": "https://cloud.oxy.so/6a6a7cf7ab026eb594ddb1a5",
                    "thumbUrl": "https://cloud.oxy.so/6a6a7cf7ab026eb594ddb1a5?variant=w320"
                  }
                ]
              },
              "user": {
                "id": "6a50ac8606dec75c2d187b6c",
                "username": "nate",
                "name": { "displayName": "Nate" },
                "avatar": "6a50ac8606dec75c2d187b6d"
              }
            }
        """.trimIndent()

        /** Plain text, no preview, no media. A third of the feed. */
        val TEXT_POST = """
            {
              "id": "6a6a82f9c1d2e3f4a5b60003",
              "content": { "text": "Analog Devices, which makes a lot of components, said today" },
              "attachments": {},
              "linkPreviews": [],
              "user": {
                "username": "someone@poa.st",
                "name": { "displayName": "Someone" }
              }
            }
        """.trimIndent()

        fun body(vararg posts: String): String =
            """{"success":true,"data":{"items":[${posts.joinToString(",")}],"hasMore":true}}"""
    }

    // ── The preview-vs-text choice ───────────────────────────────────────────────────

    @Test
    fun `a link posts card shows the preview title, not the text with its URL`() {
        val post = parseFeedResponse(body(LINK_POST)).single()

        // The whole point: the two strings are the same sentence, and the preview's is the
        // one without the URL welded to the end.
        assertEquals("Microsoft confirms Copilot super app coming this year", post.text)
        assertFalse("the card must not carry a raw URL", post.text.contains("https://"))
    }

    @Test
    fun `the post text is used when there is no preview`() {
        val post = parseFeedResponse(body(TEXT_POST)).single()

        assertTrue(post.text.startsWith("Analog Devices"))
    }

    @Test
    fun `a preview the server resolved without a title falls back to the post text`() {
        // Real case: `linkPreviews` is populated but `title` is absent or blank. Preferring
        // it blindly would leave the card with nothing to say.
        assertEquals("The body", chooseDisplayText(postText = "The body", previewTitle = ""))
        assertEquals("The body", chooseDisplayText(postText = "The body", previewTitle = "   "))
    }

    @Test
    fun `a post with neither text nor a preview title yields empty text`() {
        // Not an error: one real post's whole body was a bare URL with an image. The card
        // draws the picture and no text.
        assertEquals("", chooseDisplayText(postText = "", previewTitle = ""))
    }

    @Test
    fun `the stored text is capped at what the largest card can draw`() {
        val huge = "x".repeat(5_000)

        assertEquals(MAX_STORED_TEXT_CHARS, chooseDisplayText(huge, "").length)
        assertEquals(MAX_STORED_TEXT_CHARS, chooseDisplayText("", huge).length)
    }

    // ── The media-slot fallback chain ────────────────────────────────────────────────

    @Test
    fun `attached media outranks a preview image, and its thumbnail outranks its original`() {
        assertEquals(
            "thumb",
            chooseImageUrl(mediaThumbUrl = "thumb", mediaUrl = "full", previewImageUrl = "preview"),
        )
        assertEquals(
            "full",
            chooseImageUrl(mediaThumbUrl = "", mediaUrl = "full", previewImageUrl = "preview"),
        )
    }

    @Test
    fun `a link post falls back to its preview image`() {
        val post = parseFeedResponse(body(LINK_POST)).single()

        assertEquals("https://cloud.oxy.so/6a6a7ef1ab026eb594ddb4d4?variant=w320", post.imageUrl)
    }

    @Test
    fun `a media post uses the servers thumbnail URL and never builds one from the id`() {
        val post = parseFeedResponse(body(MEDIA_POST)).single()

        assertEquals("https://cloud.oxy.so/6a6a7cf7ab026eb594ddb1a5?variant=w320", post.imageUrl)
        // For a federated post `id` is the ORIGINAL remote URL, so a card that resolved
        // media from it would fetch a third-party server straight from the device.
        assertFalse(post.imageUrl.orEmpty().endsWith("6a6a7cf7ab026eb594ddb1a5"))
    }

    @Test
    fun `a text post has no image at all`() {
        val post = parseFeedResponse(body(TEXT_POST)).single()

        // `null`, not an empty string: the slot is not drawn, so there is no gap to collapse.
        assertNull(post.imageUrl)
    }

    @Test
    fun `blank and whitespace URLs count as absent`() {
        assertNull(chooseImageUrl("", "", ""))
        assertNull(chooseImageUrl("  ", "\n", " "))
    }

    @Test
    fun `alt text is carried when the author wrote one and is null otherwise`() {
        assertEquals(
            "A cat asleep on a keyboard",
            parseFeedResponse(body(MEDIA_POST)).single().imageAlt,
        )
        assertNull(parseFeedResponse(body(TEXT_POST)).single().imageAlt)
    }

    // ── Parsing ─────────────────────────────────────────────────────────────────────

    @Test
    fun `the real response shape is read from data items`() {
        val posts = parseFeedResponse(body(LINK_POST, MEDIA_POST, TEXT_POST))

        assertEquals(3, posts.size)
        assertEquals("6a6a82f9c1d2e3f4a5b60001", posts[0].id)
        assertEquals("The Verge", posts[0].authorName)
        // Federated handles arrive as `user@host` and are stored bare — the byline adds the
        // leading `@`, so storing one too would render `@@verge@mastodon.social`.
        assertEquals("verge@mastodon.social", posts[0].authorHandle)
        assertEquals("6a30d42d0ef11d23d365ad09", posts[0].authorAvatar)
    }

    @Test
    fun `no more than the requested number of posts is kept`() {
        val posts = parseFeedResponse(body(LINK_POST, MEDIA_POST, TEXT_POST), limit = 2)

        assertEquals(2, posts.size)
    }

    @Test
    fun `a post with no id or no author name is dropped`() {
        val noId = """{"id":"","content":{"text":"x"},"user":{"name":{"displayName":"A"}}}"""
        val noName = """{"id":"abc","content":{"text":"x"},"user":{"name":{}}}"""
        val noUser = """{"id":"abc","content":{"text":"x"}}"""

        // The id is the deep-link target and the name is the whole byline: a card missing
        // either could be attributed to anyone or open nothing.
        assertEquals(0, parseFeedResponse(body(noId, noName, noUser)).size)
    }

    @Test
    fun `a post with no text and no image is kept`() {
        val bare = """
            {
              "id": "6a6a82f9c1d2e3f4a5b60004",
              "content": { "text": "" },
              "attachments": {},
              "user": { "username": "a", "name": { "displayName": "A" } }
            }
        """.trimIndent()

        // Dropping it would silently shorten the rotation, with nothing saying so.
        val post = parseFeedResponse(body(bare)).single()
        assertEquals("", post.text)
        assertNull(post.imageUrl)
    }

    @Test
    fun `an unresolved author yields an empty handle rather than a user id`() {
        // The backend's degraded author summary carries an empty username on purpose, so a
        // raw id can never be rendered as a handle.
        val degraded = """
            {
              "id": "6a6a82f9c1d2e3f4a5b60005",
              "content": { "text": "x" },
              "user": { "username": "", "name": { "displayName": "Unknown user" } }
            }
        """.trimIndent()

        val post = parseFeedResponse(body(degraded)).single()
        assertEquals("", post.authorHandle)
        assertEquals("", bylineHandle(post))
    }

    // ── The store ───────────────────────────────────────────────────────────────────

    @Test
    fun `posts survive a round trip through the store`() {
        val original = parseFeedResponse(body(LINK_POST, MEDIA_POST, TEXT_POST))

        assertEquals(original, decodePosts(encodePosts(original)))
    }

    @Test
    fun `absent fields round trip as null rather than as empty strings`() {
        val post = WidgetPost(
            id = "1",
            text = "",
            imageUrl = null,
            imageAlt = null,
            authorName = "A",
            authorHandle = "",
            authorAvatar = null,
        )

        assertEquals(post, decodePosts(encodePosts(listOf(post))).single())
    }

    @Test
    fun `an unreadable store decodes to nothing instead of throwing`() {
        // The widget then shows its first-run state and the next tick replaces it, which
        // beats an exception inside a composition the launcher is waiting on.
        assertEquals(emptyList<WidgetPost>(), decodePosts(null))
        assertEquals(emptyList<WidgetPost>(), decodePosts(""))
        assertEquals(emptyList<WidgetPost>(), decodePosts("not json"))
        assertEquals(emptyList<WidgetPost>(), decodePosts("""{"posts":[]}"""))
    }

    // ── The rotation ────────────────────────────────────────────────────────────────

    @Test
    fun `an index past the end of a shrunken rotation wraps instead of crashing`() {
        val posts = parseFeedResponse(body(LINK_POST, MEDIA_POST))

        // A fetch that returns two posts where the last returned five leaves a stored index
        // pointing past the end.
        assertEquals(posts[0], postAt(posts, 4))
        assertEquals(posts[1], postAt(posts, 7))
        assertNotNull(postAt(posts, Int.MAX_VALUE))
    }

    @Test
    fun `a negative index is brought back into range`() {
        // Kotlin's `%` keeps the sign of the left operand, so a bare remainder would index
        // backwards out of the list.
        assertEquals(4, normalizeRotationIndex(-1, 5))
        assertEquals(0, normalizeRotationIndex(-5, 5))
        assertEquals(2, normalizeRotationIndex(7, 5))
    }

    @Test
    fun `an empty rotation has no current post and no index`() {
        assertNull(postAt(emptyList(), 0))
        assertEquals(0, normalizeRotationIndex(3, 0))
        assertEquals(0, nextRotationIndex(3, 0))
    }

    @Test
    fun `advancing cycles and never grows without bound`() {
        assertEquals(1, nextRotationIndex(0, 5))
        assertEquals(0, nextRotationIndex(4, 5))
        // Normalised BEFORE the increment, so a stored value can never climb towards
        // Int.MAX_VALUE over years of ticking.
        assertEquals(3, nextRotationIndex(7, 5))
        assertTrue(nextRotationIndex(Int.MAX_VALUE, 5) in 0 until 5)
    }

    @Test
    fun `a full cycle visits every post exactly once`() {
        val posts = parseFeedResponse(body(LINK_POST, MEDIA_POST, TEXT_POST))
        var index = 0
        val seen = mutableListOf<String>()

        repeat(posts.size) {
            seen += requireNotNull(postAt(posts, index)).id
            index = nextRotationIndex(index, posts.size)
        }

        assertEquals(posts.map { it.id }, seen)
        assertEquals(0, index)
    }

    @Test
    fun `an empty rotation cannot be stepped`() {
        // What a widget holds before its first fetch. Stepping has to yield a readable index
        // rather than dividing by zero, because the auto-advance chain runs whether or not
        // anything has been stored yet.
        assertEquals(0, nextRotationIndex(3, 0))
        assertEquals(0, nextRotationIndex(-3, 0))
    }

    // ── Which posts make it into the rotation ───────────────────────────────────────

    private fun post(id: String, image: String?) = WidgetPost(
        id = id,
        text = "t",
        imageUrl = image,
        imageAlt = null,
        authorName = "A",
        authorHandle = "a",
        authorAvatar = null,
    )

    @Test
    fun `posts with a picture are taken before text-only ones`() {
        // The card's background IS the picture, and the feed carries one on roughly a fifth
        // of its posts — so taking the first five in order usually yielded a rotation with no
        // picture at all. That is what "the background isn't there" was.
        val feed = listOf(
            post("a", null),
            post("b", "https://x/1.jpg"),
            post("c", null),
            post("d", "https://x/2.jpg"),
            post("e", null),
        )

        assertEquals(listOf("b", "d"), preferPostsWithPictures(feed, 2).map { it.id })
    }

    @Test
    fun `feed order is kept inside each group`() {
        // The rotation still reads newest-first; pictures are promoted as a group, not
        // shuffled. A rotation whose order changed on every fetch would read as random.
        val feed = listOf(
            post("a", "https://x/1.jpg"),
            post("b", null),
            post("c", "https://x/2.jpg"),
            post("d", null),
        )

        assertEquals(listOf("a", "c", "b", "d"), preferPostsWithPictures(feed, 4).map { it.id })
    }

    @Test
    fun `text-only posts still fill the rotation when pictures run out`() {
        // A quiet following feed may have none, and a short rotation would be the worse
        // trade: a card that says nothing beats a card with no picture.
        val feed = listOf(post("a", null), post("b", null), post("c", "https://x/1.jpg"))

        assertEquals(listOf("c", "a", "b"), preferPostsWithPictures(feed, 5).map { it.id })
    }

    @Test
    fun `a degenerate limit yields nothing rather than an exception`() {
        assertEquals(emptyList<WidgetPost>(), preferPostsWithPictures(listOf(post("a", null)), 0))
        assertEquals(emptyList<WidgetPost>(), preferPostsWithPictures(listOf(post("a", null)), -1))
        assertEquals(emptyList<WidgetPost>(), preferPostsWithPictures(emptyList(), 5))
    }

    @Test
    fun `the widget asks the feed for more posts than it keeps`() {
        // The selection above needs something to select FROM: a page of exactly
        // ROTATION_LENGTH would leave it choosing five from five.
        assertTrue("$FEED_PAGE_LENGTH must exceed $ROTATION_LENGTH", FEED_PAGE_LENGTH > ROTATION_LENGTH)
        assertTrue("a page of $FEED_PAGE_LENGTH is not enough to find a picture in", FEED_PAGE_LENGTH >= 20)
    }
}
