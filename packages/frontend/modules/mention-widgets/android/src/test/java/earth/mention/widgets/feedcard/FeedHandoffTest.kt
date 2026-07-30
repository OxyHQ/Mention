package earth.mention.widgets.feedcard

import org.json.JSONException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WHAT THE RUNNING APP IS ALLOWED TO PUT ON A HOME SCREEN.
 *
 * Two things are pinned here, and they fail in opposite directions:
 *
 *  - The PARSE, where the risk is drift. A page handed over by the app arrives in a
 *    different shape from one the worker fetched, and if the two ever stopped producing the
 *    same card nobody would notice — both would look like working widgets, showing
 *    different things depending on which door the posts came through. So the first test
 *    below feeds one post in through BOTH doors and asserts the results are identical.
 *  - The ACCOUNT RULE, where the risk is a leak. It is the one comparison standing between
 *    one account's private timeline and another account's home screen, and it is invisible
 *    when wrong: a widget drawing the previous account's posts looks exactly like a widget
 *    working correctly.
 */
class FeedHandoffTest {

    private companion object {
        const val ACCOUNT = "6981c9178fcdefaf81988ffb"
        const val OTHER_ACCOUNT = "70a1d2e3f4b5c6d7e8f90001"

        /**
         * One post as the FEED serves it — nested wire objects, what the refresh worker
         * parses.
         */
        val WIRE_POST = """
            {
              "data": {
                "items": [
                  {
                    "id": "6a6a82f9c1d2e3f4a5b60001",
                    "content": {
                      "text": "Microsoft confirms Copilot super app coming this year https://www.theverge.com/tech/972927/x"
                    },
                    "attachments": {
                      "media": [
                        {
                          "url": "https://cloud.oxy.so/6a6a7ef1ab026eb594ddb4d4",
                          "thumbUrl": "https://cloud.oxy.so/6a6a7ef1ab026eb594ddb4d4?variant=w320",
                          "alt": "A screenshot of the app"
                        }
                      ]
                    },
                    "linkPreviews": [
                      {
                        "url": "https://www.theverge.com/tech/972927/x",
                        "title": "Microsoft confirms Copilot super app coming this year",
                        "image": "https://cloud.oxy.so/6a6a7ef1ab026eb594ddb4d5?variant=w320"
                      }
                    ],
                    "user": {
                      "id": "6a30d42df24acd91fb263b69",
                      "username": "verge@mastodon.social",
                      "name": { "displayName": "The Verge" },
                      "avatar": "6a30d42d0ef11d23d365ad09"
                    }
                  }
                ]
              }
            }
        """.trimIndent()

        /**
         * The SAME post as the app hands it over — flat, and only the fields a card reads.
         * This is exactly what `toWidgetFeedPosts` in `feedWidgetSync.ts` produces.
         */
        val HANDOFF_POST = """
            [
              {
                "id": "6a6a82f9c1d2e3f4a5b60001",
                "text": "Microsoft confirms Copilot super app coming this year https://www.theverge.com/tech/972927/x",
                "title": "Microsoft confirms Copilot super app coming this year",
                "thumbUrl": "https://cloud.oxy.so/6a6a7ef1ab026eb594ddb4d4?variant=w320",
                "url": "https://cloud.oxy.so/6a6a7ef1ab026eb594ddb4d4",
                "alt": "A screenshot of the app",
                "image": "https://cloud.oxy.so/6a6a7ef1ab026eb594ddb4d5?variant=w320",
                "name": "The Verge",
                "username": "verge@mastodon.social",
                "avatar": "6a30d42d0ef11d23d365ad09"
              }
            ]
        """.trimIndent()
    }

    /**
     * THE DRIFT TEST. The app saving the widget a request must not change what the widget
     * shows — the same post, through either door, is the same card.
     */
    @Test
    fun `a handed-over post draws exactly as a fetched one`() {
        val fetched = parseFeedResponse(WIRE_POST)
        val handedOver = parseHandoffPosts(HANDOFF_POST)

        assertEquals(1, fetched.size)
        assertEquals(fetched, handedOver)
    }

    @Test
    fun `the handoff applies the same content rules`() {
        val post = parseHandoffPosts(HANDOFF_POST).single()

        // The preview title wins over the body, which is the headline with its URL glued on.
        assertEquals("Microsoft confirms Copilot super app coming this year", post.text)
        // The media thumbnail outranks the original and the preview image.
        assertEquals("https://cloud.oxy.so/6a6a7ef1ab026eb594ddb4d4?variant=w320", post.imageUrl)
        // The handle is normalized to bare, as the byline expects.
        assertEquals("verge@mastodon.social", post.authorHandle)
    }

    @Test
    fun `a post with no id or no author name is dropped`() {
        val body = """
            [
              { "id": "", "name": "Ada" },
              { "id": "kept", "name": "Ada" },
              { "id": "no-name", "name": "   " }
            ]
        """.trimIndent()

        assertEquals(listOf("kept"), parseHandoffPosts(body).map { it.id })
    }

    @Test
    fun `the handoff keeps only a rotation's worth, pictures first`() {
        val body = buildString {
            append("[")
            // Six text-only posts, then one with a picture — so a parser that simply took
            // the first five would keep no picture at all.
            (1..6).forEach { index ->
                append("""{"id":"text-$index","name":"Ada"},""")
            }
            append("""{"id":"pictured","name":"Ada","url":"https://cloud.oxy.so/x"}""")
            append("]")
        }

        val posts = parseHandoffPosts(body)

        assertEquals(ROTATION_LENGTH, posts.size)
        assertEquals("pictured", posts.first().id)
    }

    @Test
    fun `an empty page yields nothing rather than an exception`() {
        assertTrue(parseHandoffPosts("[]").isEmpty())
    }

    /**
     * A body that is not an array THROWS, and the module catches it — deliberately unlike
     * `decodePosts`, which degrades to empty. The difference is who is at fault: a corrupt
     * store is a fact to recover from, while a handoff the widget cannot read is a bug in
     * the app that must be visible in a log rather than silently storing nothing.
     */
    @Test(expected = JSONException::class)
    fun `a body that is not an array is refused`() {
        parseHandoffPosts("""{"items":[]}""")
    }

    @Test
    fun `a matching account is stamped with what the device says`() {
        val outcome = accountFeedHandoff(
            claimedAccountId = ACCOUNT,
            deviceAccountId = ACCOUNT,
            postCount = 5,
        )

        assertEquals(FeedHandoff.Write(ACCOUNT), outcome)
    }

    /**
     * The case this whole mechanism exists for: the page was fetched as one account and the
     * device has moved to another. It is DROPPED — never reconciled, never re-stamped.
     */
    @Test
    fun `a page fetched as another account is refused`() {
        val outcome = accountFeedHandoff(
            claimedAccountId = OTHER_ACCOUNT,
            deviceAccountId = ACCOUNT,
            postCount = 5,
        )

        assertEquals(FeedHandoff.Refuse(HandoffRefusal.DIFFERENT_ACCOUNT), outcome)
    }

    /**
     * No background credential means no account to stamp with. Writing the claim instead
     * would produce a rotation the widget's own composition reads back as empty — dead data
     * on disk, and a claim nothing ever checked.
     */
    @Test
    fun `a page is refused when the device has no credential`() {
        val outcome = accountFeedHandoff(
            claimedAccountId = ACCOUNT,
            deviceAccountId = null,
            postCount = 5,
        )

        assertEquals(FeedHandoff.Refuse(HandoffRefusal.NO_CREDENTIAL), outcome)
    }

    /** A caller that names no account at all, including one that sends whitespace. */
    @Test
    fun `an unclaimed account is refused before anything else is considered`() {
        assertEquals(
            FeedHandoff.Refuse(HandoffRefusal.NO_ACCOUNT_CLAIMED),
            accountFeedHandoff(claimedAccountId = "", deviceAccountId = ACCOUNT, postCount = 5),
        )
        assertEquals(
            FeedHandoff.Refuse(HandoffRefusal.NO_ACCOUNT_CLAIMED),
            accountFeedHandoff(claimedAccountId = "   ", deviceAccountId = ACCOUNT, postCount = 5),
        )
    }

    /**
     * An empty page never overwrites a rotation.
     *
     * `descriptor=following` answers an UNAUTHENTICATED request with 200 and zero posts, so
     * "empty" is precisely the shape of a request whose bearer did not apply. Refusing it
     * means that case can never blank a widget that has content.
     */
    @Test
    fun `an empty page is refused on both feeds`() {
        assertEquals(
            FeedHandoff.Refuse(HandoffRefusal.NOTHING_TO_WRITE),
            accountFeedHandoff(claimedAccountId = ACCOUNT, deviceAccountId = ACCOUNT, postCount = 0),
        )
        assertEquals(
            FeedHandoff.Refuse(HandoffRefusal.NOTHING_TO_WRITE),
            anonymousFeedHandoff(postCount = 0),
        )
    }

    /**
     * The anonymous feed is stamped with NOTHING, and never consults the credential.
     *
     * A stamp here would make the store unreadable to the widget, which reads it
     * anonymously — and asking who is signed in would break a public discovery feed for a
     * signed-out reader.
     */
    @Test
    fun `an anonymous page is stamped with no account`() {
        val outcome = anonymousFeedHandoff(postCount = 5)

        assertEquals(FeedHandoff.Write(null), outcome)
        assertNull((outcome as FeedHandoff.Write).accountId)
    }
}
