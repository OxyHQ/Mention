package earth.mention.widgets.trends

import android.content.Context
import earth.mention.widgets.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * The widget's one network call: `GET /trending`.
 *
 * That route is public — it is mounted on the backend's `publicApi` router
 * (packages/backend/src/appRoutes.ts) and answers an anonymous request with the
 * live batch — so there is no session, token or credential anywhere in this
 * file, and deliberately so. Reading anything authenticated from a widget needs
 * the device-first session, which belongs in the shared Oxy SDK rather than
 * here; see the phase 2 / 3 note in the design doc.
 *
 * `HttpURLConnection` rather than a client library: this is a single unauthenticated
 * GET of a few hundred bytes, and adding an HTTP stack to the release APK to
 * make it would cost more than it saves.
 */
internal object TrendsApi {
    /**
     * How many trends to ask for.
     *
     * Sized for the HUNGRIEST variant, which is the chip cloud rather than the list:
     * a list's largest breakpoint draws four rows, but a cloud packs several chips
     * into each of its four, and a row of short names (`ai`, `food`) fits five in the
     * 296dp a 5×5 widget has. Twenty is that worst case, so no placement runs out of
     * trends and shows a half-empty last row.
     *
     * It is also the server's own default and well inside its 1–50 range
     * (`MAX_TRENDING_LIMIT`, packages/backend/src/routes/trending.routes.ts), and the
     * surplus over what a smaller placement shows is what lets a resize reveal more
     * immediately instead of waiting for the next refresh.
     */
    private const val REQUESTED_TRENDS = 20

    private val CONNECT_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(10).toInt()
    private val READ_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(15).toInt()

    /**
     * Fetch the current batch.
     *
     * Throws [IOException] for anything that a later attempt could plausibly get
     * past (no network, a timeout, a 5xx) and [org.json.JSONException] for a body
     * that is not the documented shape. The caller distinguishes the two: the
     * first is worth retrying, the second is not.
     */
    suspend fun fetch(context: Context): List<WidgetTrend> = withContext(Dispatchers.IO) {
        val base = context.getString(R.string.mention_widget_api_base_url).trimEnd('/')
        val connection = (URL("$base/trending?limit=$REQUESTED_TRENDS").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("Accept", "application/json")
        }
        try {
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_OK) {
                throw IOException("GET /trending responded $status")
            }
            parseTrendsResponse(connection.inputStream.bufferedReader().use { it.readText() })
        } finally {
            connection.disconnect()
        }
    }
}
