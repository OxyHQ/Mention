package earth.mention.widgets.trends

import org.json.JSONArray
import org.json.JSONObject

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

/** One row of the widget. */
internal data class WidgetTrend(
    val name: String,
    val kind: TrendKind,
    /** Posts behind the trend. `0` where the API reports none. */
    val volume: Int,
)

private const val FIELD_TRENDING = "trending"
private const val FIELD_NAME = "name"
private const val FIELD_TYPE = "type"
private const val FIELD_VOLUME = "volume"

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
                ),
            )
        }
    }
}

/**
 * Store shape for the last-known trends.
 *
 * Deliberately NOT the server's response: this is what survives a process death
 * and a reboot, so it holds only the three fields the widget draws. Re-encoding
 * also means a future server field cannot silently grow the stored blob.
 */
internal fun encodeTrends(trends: List<WidgetTrend>): String {
    val array = JSONArray()
    trends.forEach { trend ->
        array.put(
            JSONObject()
                .put(FIELD_NAME, trend.name)
                .put(FIELD_TYPE, trend.kind.wireValue)
                .put(FIELD_VOLUME, trend.volume),
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
                ),
            )
        }
    }
}
