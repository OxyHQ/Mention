package earth.mention.widgets.posts

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
class PostsModelTest {

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
        val post = parsePostsResponse(body(LINK_POST)).single()

        // The whole point: the two strings are the same sentence, and the preview's is the
        // one without the URL welded to the end.
        assertEquals("Microsoft confirms Copilot super app coming this year", post.text)
        assertFalse("the card must not carry a raw URL", post.text.contains("https://"))
    }

    @Test
    fun `the post text is used when there is no preview`() {
        val post = parsePostsResponse(body(TEXT_POST)).single()

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
        val post = parsePostsResponse(body(LINK_POST)).single()

        assertEquals("https://cloud.oxy.so/6a6a7ef1ab026eb594ddb4d4?variant=w320", post.imageUrl)
    }

    @Test
    fun `a media post uses the servers thumbnail URL and never builds one from the id`() {
        val post = parsePostsResponse(body(MEDIA_POST)).single()

        assertEquals("https://cloud.oxy.so/6a6a7cf7ab026eb594ddb1a5?variant=w320", post.imageUrl)
        // For a federated post `id` is the ORIGINAL remote URL, so a card that resolved
        // media from it would fetch a third-party server straight from the device.
        assertFalse(post.imageUrl.orEmpty().endsWith("6a6a7cf7ab026eb594ddb1a5"))
    }

    @Test
    fun `a text post has no image at all`() {
        val post = parsePostsResponse(body(TEXT_POST)).single()

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
            parsePostsResponse(body(MEDIA_POST)).single().imageAlt,
        )
        assertNull(parsePostsResponse(body(TEXT_POST)).single().imageAlt)
    }

    // ── Parsing ─────────────────────────────────────────────────────────────────────

    @Test
    fun `the real response shape is read from data items`() {
        val posts = parsePostsResponse(body(LINK_POST, MEDIA_POST, TEXT_POST))

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
        val posts = parsePostsResponse(body(LINK_POST, MEDIA_POST, TEXT_POST), limit = 2)

        assertEquals(2, posts.size)
    }

    @Test
    fun `a post with no id or no author name is dropped`() {
        val noId = """{"id":"","content":{"text":"x"},"user":{"name":{"displayName":"A"}}}"""
        val noName = """{"id":"abc","content":{"text":"x"},"user":{"name":{}}}"""
        val noUser = """{"id":"abc","content":{"text":"x"}}"""

        // The id is the deep-link target and the name is the whole byline: a card missing
        // either could be attributed to anyone or open nothing.
        assertEquals(0, parsePostsResponse(body(noId, noName, noUser)).size)
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

        // Dropping it would make the position pips lie about the length of the rotation.
        val post = parsePostsResponse(body(bare)).single()
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

        val post = parsePostsResponse(body(degraded)).single()
        assertEquals("", post.authorHandle)
        assertEquals("", bylineHandle(post))
    }

    // ── The store ───────────────────────────────────────────────────────────────────

    @Test
    fun `posts survive a round trip through the store`() {
        val original = parsePostsResponse(body(LINK_POST, MEDIA_POST, TEXT_POST))

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
        val posts = parsePostsResponse(body(LINK_POST, MEDIA_POST))

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
        val posts = parsePostsResponse(body(LINK_POST, MEDIA_POST, TEXT_POST))
        var index = 0
        val seen = mutableListOf<String>()

        repeat(posts.size) {
            seen += requireNotNull(postAt(posts, index)).id
            index = nextRotationIndex(index, posts.size)
        }

        assertEquals(posts.map { it.id }, seen)
        assertEquals(0, index)
    }

    // ── Advancing the cursor, which is what a tap does ──────────────────────────────

    @Test
    fun `the cursor a tap stores is counted off the rotation the store holds`() {
        val three = parsePostsResponse(body(LINK_POST, MEDIA_POST, TEXT_POST))

        // The property that makes the advance safe: the LENGTH comes out of the stored blob,
        // never from the caller. A widget composed when the rotation was five posts long can
        // be tapped after a fetch cut it to three, and the position it lands on has to exist
        // in the rotation that is actually stored — position 2 of three wraps to 0, where a
        // cursor advanced against a remembered five would have stored 3.
        assertEquals(0, advancedRotationIndex(encodePosts(three), 2))
        assertEquals(1, advancedRotationIndex(encodePosts(three), 0))
        assertEquals(2, advancedRotationIndex(encodePosts(three), 1))
    }

    @Test
    fun `a tap on a rotation of five walks it and comes back round`() {
        val five = List(5) { index ->
            WidgetPost(
                id = "$index",
                text = "post $index",
                imageUrl = null,
                imageAlt = null,
                authorName = "A",
                authorHandle = "a",
                authorAvatar = null,
            )
        }
        val stored = encodePosts(five)
        val walked = mutableListOf<Int>()
        var cursor = 0

        // Forward-only is the whole control, so reaching the post BEFORE this one means
        // walking the ring — five taps have to return to where they started, or "previous is
        // four taps away" is not true and the control needs a partner after all.
        repeat(five.size) {
            cursor = advancedRotationIndex(stored, cursor)
            walked += cursor
        }

        assertEquals(listOf(1, 2, 3, 4, 0), walked)
    }

    @Test
    fun `a cursor stored out of range is brought back in rather than pushed further out`() {
        val two = parsePostsResponse(body(LINK_POST, MEDIA_POST))

        // Both ends. A stored index past the end (a rotation that shrank) and a negative one
        // (a corrupted preference) are the two ways the cursor arrives outside its rotation,
        // and an advance must land inside it either way — this is a widget on a home screen,
        // and an index out of bounds here is a blank card.
        assertEquals(1, advancedRotationIndex(encodePosts(two), 4))
        assertEquals(0, advancedRotationIndex(encodePosts(two), -1))
        assertTrue(advancedRotationIndex(encodePosts(two), Int.MAX_VALUE) in two.indices)
    }

    @Test
    fun `a tap before the first fetch, or on an unreadable store, changes nothing`() {
        // The store is empty on a freshly placed widget, and the card is showing its first-run
        // state. There is nothing to advance to, and writing a position for a rotation that
        // does not exist would leave a cursor pointing into one that arrives later.
        assertEquals(0, advancedRotationIndex(null, null))
        assertEquals(0, advancedRotationIndex("", 3))
        assertEquals(0, advancedRotationIndex("not json", 3))
        assertEquals(0, advancedRotationIndex(encodePosts(emptyList()), 3))
    }

    @Test
    fun `a missing stored cursor counts as the first post, not as no advance`() {
        val three = parsePostsResponse(body(LINK_POST, MEDIA_POST, TEXT_POST))

        // `index` is absent until something writes it, so the first tap a widget ever receives
        // reads null here. It has to move to post two; treating it as "no cursor, no advance"
        // would make the very first press do nothing.
        assertEquals(1, advancedRotationIndex(encodePosts(three), null))
    }

    // ── The filled pip ─────────────────────────────────────────────────────────────

    @Test
    fun `the filled pip is the position the drawn post came from`() {
        val posts = parsePostsResponse(body(LINK_POST, MEDIA_POST, TEXT_POST))

        // Expectations written as literals rather than derived from the same call the
        // production code makes: a pip highlighted from the raw stored index would point at a
        // different post than the card shows, and comparing the two implementations of that
        // arithmetic against each other would pass whatever they both did.
        assertEquals(0, PostsRotation(posts, index = 0, fetchedAtMs = 1L).position)
        assertEquals(2, PostsRotation(posts, index = 2, fetchedAtMs = 1L).position)
        assertEquals(1, PostsRotation(posts, index = 7, fetchedAtMs = 1L).position)
        assertEquals(2, PostsRotation(posts, index = -1, fetchedAtMs = 1L).position)

        // …and it is the position of the post actually on the card.
        listOf(0, 2, 7, -1).forEach { stored ->
            val rotation = PostsRotation(posts, index = stored, fetchedAtMs = 1L)
            assertEquals(rotation.current, posts[rotation.position])
        }
    }

    @Test
    fun `an empty rotation has a position of zero rather than an exception`() {
        val empty = PostsRotation(emptyList(), index = 4, fetchedAtMs = 0L)

        // The first-run state. No pips are drawn, so nothing reads this — but a card that
        // threw while composing would take the launcher's redraw down with it.
        assertEquals(0, empty.position)
        assertNull(empty.current)
    }
}
