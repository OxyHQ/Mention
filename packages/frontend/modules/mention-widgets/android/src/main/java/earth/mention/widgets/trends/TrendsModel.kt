package earth.mention.widgets.trends

import earth.mention.widgets.sparkline.sanitizeSparklineSeries
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * The kinds of trend `GET /trending` returns, mirroring the backend's
 * `TrendingType` enum (packages/backend/src/models/Trending.ts).
 *
 * [UNKNOWN] is not a server value — it is what an unrecognised `type` string
 * decodes to. The API is free to add a kind, and a widget that threw on one it
 * had never heard of would blank itself over a value it could perfectly well
 * render as a plain trend.
 */
internal enum class TrendKind(val wireValue: String) {
    HASHTAG("hashtag"),
    TOPIC("topic"),
    ENTITY("entity"),
    UNKNOWN("");

    companion object {
        fun fromWire(value: String?): TrendKind =
            entries.firstOrNull { it.wireValue == value } ?: UNKNOWN
    }
}

/** One trend, as the widgets draw it. */
internal data class WidgetTrend(
    val name: String,
    val kind: TrendKind,
    /** Posts behind the trend. `0` where the API reports none. */
    val volume: Int,
    /**
     * Recent history of [volume], oldest first — the sparkline's only input.
     *
     * EMPTY is a normal, expected state and means DRAW NOTHING: the server omits
     * `series` entirely for a trend it has seen in too few batches to draw
     * honestly (`MtnConfig.trending.series.minPoints`), and it is never to be
     * replaced with a flat or synthesized line. Empty is also what a series that
     * failed [sanitizeSparklineSeries] decodes to, so nothing downstream has to
     * ask a second time whether a series is drawable.
     */
    val series: List<Float> = emptyList(),
)

/**
 * The chart every variant draws behind its content: the LEADING trend's series.
 *
 * See `SparklineBackground` for why one chart rather than one per trend, and why the
 * leading trend rather than a combination of them.
 */
internal fun leadingSeries(trends: List<WidgetTrend>): List<Float> =
    trends.firstOrNull()?.series ?: emptyList()

private const val FIELD_TRENDING = "trending"
private const val FIELD_NAME = "name"
private const val FIELD_TYPE = "type"
private const val FIELD_VOLUME = "volume"
private const val FIELD_SERIES = "series"

/**
 * Read `GET /trending`'s body.
 *
 * Trends with a blank name are dropped rather than rendered: `name` is both the
 * label and the deep-link path segment, so an empty one would paint an empty row
 * that navigates to a broken URL.
 *
 * Throws [org.json.JSONException] when the body is not the expected object —
 * that is a contract break, and the caller answers for it by keeping whatever it
 * already had rather than by rendering nothing.
 */
internal fun parseTrendsResponse(body: String): List<WidgetTrend> {
    val items = JSONObject(body).getJSONArray(FIELD_TRENDING)
    return buildList(items.length()) {
        for (index in 0 until items.length()) {
            val item = items.optJSONObject(index) ?: continue
            val name = item.optString(FIELD_NAME).trim()
            if (name.isEmpty()) continue
            add(
                WidgetTrend(
                    name = name,
                    kind = TrendKind.fromWire(item.optString(FIELD_TYPE)),
                    volume = item.optInt(FIELD_VOLUME, 0).coerceAtLeast(0),
                    series = readSeries(item.optJSONArray(FIELD_SERIES)),
                ),
            )
        }
    }
}

/**
 * Store shape for the last-known trends.
 *
 * Deliberately NOT the server's response: this is what survives a process death
 * and a reboot, so it holds only the fields the widgets draw. Re-encoding also
 * means a future server field cannot silently grow the stored blob.
 */
internal fun encodeTrends(trends: List<WidgetTrend>): String {
    val array = JSONArray()
    trends.forEach { trend ->
        array.put(
            JSONObject()
                .put(FIELD_NAME, trend.name)
                .put(FIELD_TYPE, trend.kind.wireValue)
                .put(FIELD_VOLUME, trend.volume)
                .put(FIELD_SERIES, encodeSeries(trend.series)),
        )
    }
    return array.toString()
}

/**
 * Read back what [encodeTrends] wrote. Returns an empty list for a blob this
 * build can no longer read (an older or corrupted encoding) — the widget then
 * shows its empty state and the next refresh replaces it, which is a better
 * outcome than a crash inside a composition the launcher is hosting.
 */
internal fun decodeTrends(stored: String?): List<WidgetTrend> {
    if (stored.isNullOrEmpty()) return emptyList()
    val array = runCatching { JSONArray(stored) }.getOrNull() ?: return emptyList()
    return buildList(array.length()) {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val name = item.optString(FIELD_NAME)
            if (name.isEmpty()) continue
            add(
                WidgetTrend(
                    name = name,
                    kind = TrendKind.fromWire(item.optString(FIELD_TYPE)),
                    volume = item.optInt(FIELD_VOLUME, 0),
                    series = readSeries(item.optJSONArray(FIELD_SERIES)),
                ),
            )
        }
    }
}

/**
 * The `series` array, sanitized — see [sanitizeSparklineSeries] for what is
 * rejected and why a rejected series is dropped whole.
 *
 * Absent, `null` and unusable all decode to EMPTY, which is the one state the
 * widgets check.
 *
 * `optDouble` with a NaN fallback is what makes a non-numeric element (a string, a
 * nested object, JSON `null`) fail rather than quietly become a zero: NaN is not
 * finite, so the sanitizer drops the series.
 */
private fun readSeries(array: JSONArray?): List<Float> {
    if (array == null) return emptyList()
    val values = ArrayList<Float>(array.length())
    for (index in 0 until array.length()) {
        values.add(array.optDouble(index, Double.NaN).toFloat())
    }
    return sanitizeSparklineSeries(values)
}

/** Tenths, because that is the precision `volume` series carry; see [encodeSeries]. */
private const val SERIES_DECIMAL_SCALE = 10f

/**
 * The series as stored.
 *
 * Written at one decimal place, which is LOSSLESS for this data and not a rounding
 * decision of ours: the server already rounds each point to a tenth
 * (`Math.round(mean * 10) / 10` in
 * packages/backend/src/services/trending/trendSeries.ts). Writing the raw `Float`
 * instead would widen every point to its double expansion — `18.7` stored as
 * `18.700000762939453` — for no precision that exists.
 */
private fun encodeSeries(series: List<Float>): JSONArray {
    val array = JSONArray()
    series.forEach { value ->
        array.put((value * SERIES_DECIMAL_SCALE).roundToInt() / SERIES_DECIMAL_SCALE.toDouble())
    }
    return array
}
