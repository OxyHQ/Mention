package earth.mention.widgets.trends

import org.json.JSONException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reading `GET /trending`, and surviving a reboot with what it said.
 *
 * The bodies below are the shape production actually serves — captured from
 * `https://api.mention.earth/trending?limit=10` on 2026-07-29 — trimmed to the fields
 * the widgets read. The series values are the real ones, `ai`'s flat run included.
 */
class TrendsModelTest {

    private companion object {
        val BUSINESS_SERIES = listOf(19f, 19f, 19f, 19f, 19f, 19f, 18f, 17.3f, 16f, 14.3f, 12.3f, 11f)
        val AI_SERIES = List(12) { 4f }
    }

    private fun body(vararg trends: String) = """{"trending":[${trends.joinToString(",")}],"count":${trends.size},"recId":"ms6mlekc"}"""

    private val businessJson = """
        {"_id":"6a6a7756f368ae14d2c57271","type":"topic","name":"business","volume":11,
         "series":[19,19,19,19,19,19,18,17.3,16,14.3,12.3,11]}
    """.trimIndent()

    private val aiJson = """
        {"_id":"6a6a7756f368ae14d2c57274","type":"topic","name":"ai","volume":4,
         "series":[4,4,4,4,4,4,4,4,4,4,4,4]}
    """.trimIndent()

    private val hashtagJson = """
        {"_id":"6a6a7756f368ae14d2c57276","type":"hashtag","name":"tradeshow","volume":11,
         "series":[20,20,20,20,20,20,18.7,17.3,16,14.3,12.3,11]}
    """.trimIndent()

    @Test
    fun `a production body parses into trends with their series`() {
        val trends = parseTrendsResponse(body(businessJson, aiJson, hashtagJson))

        assertEquals(3, trends.size)
        assertEquals("business", trends[0].name)
        assertEquals(TrendKind.TOPIC, trends[0].kind)
        assertEquals(11, trends[0].volume)
        assertEquals(BUSINESS_SERIES, trends[0].series)
        assertEquals(TrendKind.HASHTAG, trends[2].kind)
    }

    @Test
    fun `a flat series survives parsing intact`() {
        // The one series shape that a careless normalisation destroys has to reach
        // the renderer unchanged first.
        val trends = parseTrendsResponse(body(aiJson))

        assertEquals(AI_SERIES, trends.single().series)
    }

    @Test
    fun `series of different lengths in one batch are all kept`() {
        // Production serves both: the server downsamples each trend over the batches
        // THAT trend appeared in, so at `limit=20` lengths of 9 and 12 arrive together
        // (verified 2026-07-29). It is also why the widgets draw one trend's chart
        // rather than a sum — two series of different lengths do not share a time axis.
        val nine = """{"type":"topic","name":"china","volume":3,"series":[1,2,3,4,5,6,7,8,9]}"""

        val trends = parseTrendsResponse(body(businessJson, nine))

        assertEquals(12, trends[0].series.size)
        assertEquals(9, trends[1].series.size)
    }

    @Test
    fun `a trend with no series parses with an empty one`() {
        val trends = parseTrendsResponse(body("""{"type":"topic","name":"gaming","volume":4}"""))

        // The server omits `series` for a trend it has seen in too few batches.
        // Empty means draw nothing, and it must never become a flat line.
        assertEquals(emptyList<Float>(), trends.single().series)
        assertEquals("gaming", trends.single().name)
    }

    @Test
    fun `a series with a non-numeric element is dropped, and the trend is kept`() {
        val trends = parseTrendsResponse(
            body("""{"type":"topic","name":"tech","volume":5,"series":[3,"nope",5,6,7,8]}"""),
        )

        assertEquals(1, trends.size)
        assertEquals("tech", trends.single().name)
        assertEquals(emptyList<Float>(), trends.single().series)
    }

    @Test
    fun `a series with a negative count is dropped`() {
        val trends = parseTrendsResponse(
            body("""{"type":"topic","name":"tech","volume":5,"series":[3,4,-1,6,7,8]}"""),
        )

        assertEquals(emptyList<Float>(), trends.single().series)
    }

    @Test
    fun `a one-point series is dropped`() {
        val trends = parseTrendsResponse(body("""{"type":"topic","name":"tech","volume":5,"series":[7]}"""))

        assertEquals(emptyList<Float>(), trends.single().series)
    }

    @Test
    fun `a trend with a blank name is dropped entirely`() {
        val trends = parseTrendsResponse(body("""{"type":"topic","name":"  ","volume":9}""", aiJson))

        // `name` is the deep-link path segment as well as the label.
        assertEquals(listOf("ai"), trends.map { it.name })
    }

    @Test
    fun `an unknown type still renders as a trend`() {
        val trends = parseTrendsResponse(body("""{"type":"constellation","name":"orion","volume":3}"""))

        assertEquals(TrendKind.UNKNOWN, trends.single().kind)
    }

    @Test(expected = JSONException::class)
    fun `a body that is not the documented shape is a contract break`() {
        // The caller answers for this by keeping the trends it already had.
        parseTrendsResponse("""{"nope":true}""")
    }

    @Test
    fun `trends round-trip through the store with their series`() {
        val original = parseTrendsResponse(body(businessJson, aiJson, hashtagJson))

        val restored = decodeTrends(encodeTrends(original))

        assertEquals(original, restored)
    }

    @Test
    fun `a series is stored at the servers own precision, not a floats expansion`() {
        val encoded = encodeTrends(parseTrendsResponse(body(businessJson)))

        // 17.3 as a raw Float widens to 17.299999237060547 through JSON. The server
        // already rounds every point to a tenth, so writing tenths is lossless — and
        // this is what keeps the stored blob from tripling in size.
        assertTrue("stored as $encoded", encoded.contains("17.3"))
        assertTrue("stored as $encoded", !encoded.contains("17.29"))
    }

    @Test
    fun `an unreadable blob decodes to nothing rather than crashing a composition`() {
        assertEquals(emptyList<WidgetTrend>(), decodeTrends("not json at all"))
        assertEquals(emptyList<WidgetTrend>(), decodeTrends(null))
        assertEquals(emptyList<WidgetTrend>(), decodeTrends(""))
    }

    @Test
    fun `the chart belongs to the leading trend`() {
        val trends = parseTrendsResponse(body(businessJson, aiJson))

        assertEquals(BUSINESS_SERIES, leadingSeries(trends))
        assertEquals(emptyList<Float>(), leadingSeries(emptyList()))
    }
}
