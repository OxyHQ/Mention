package earth.mention.widgets.posts

import android.content.Context
import earth.mention.widgets.R
import earth.mention.widgets.feedcard.ROTATION_LENGTH
import earth.mention.widgets.feedcard.WidgetPost
import earth.mention.widgets.feedcard.parseFeedResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * The trending-posts widget's feed call: `GET /feed/mtn?descriptor=explore`.
 *
 * ANONYMOUS, and that is what makes this widget possible at all. The explore descriptor
 * answers an unauthenticated request with a full page — verified against production —
 * so there is no session, token or credential in this file. Reading anything
 * personalized from a widget needs the device-first session, which belongs in the shared
 * Oxy SDK rather than here; see the phase 2 / 3 note in the design doc.
 *
 * The anonymity is also a content decision. Explore is the discovery feed, so it is
 * SFW-filtered server-side by the discovery sources' own safety match, and nothing
 * private can appear on a home screen through a request that carries no identity.
 */
internal object PostsApi {

    private val CONNECT_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(10).toInt()
    private val READ_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(15).toInt()

    /**
     * Fetch the rotation.
     *
     * Asks for exactly [ROTATION_LENGTH] posts rather than a page — the widget shows one
     * at a time and rotates through five, so a larger page would be bytes parsed and
     * thrown away on a metered connection.
     *
     * Throws [IOException] for what a later attempt could get past (no network, a
     * timeout, a 5xx) and [org.json.JSONException] for a body that is not the documented
     * shape. The caller distinguishes the two: the first is worth retrying, the second
     * is not.
     */
    suspend fun fetch(context: Context): List<WidgetPost> = withContext(Dispatchers.IO) {
        val base = context.getString(R.string.mention_widget_api_base_url).trimEnd('/')
        val url = URL("$base/feed/mtn?descriptor=explore&limit=$ROTATION_LENGTH")
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("Accept", "application/json")
        }
        try {
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_OK) {
                throw IOException("GET /feed/mtn?descriptor=explore responded $status")
            }
            parseFeedResponse(connection.inputStream.bufferedReader().use { it.readText() })
        } finally {
            connection.disconnect()
        }
    }
}
