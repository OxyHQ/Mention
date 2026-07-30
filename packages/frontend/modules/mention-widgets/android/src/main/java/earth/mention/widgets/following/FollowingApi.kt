package earth.mention.widgets.following

import android.content.Context
import earth.mention.widgets.R
import earth.mention.widgets.feedcard.FEED_PAGE_LENGTH
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
 * The following widget's feed call: `GET /feed/mtn?descriptor=following`, WITH A BEARER.
 *
 * ## The two origins, which are not the same origin
 *
 * The bearer is minted against the OXY api (the credential carries its own `baseUrl`, and
 * `so.oxy.session.OxyBackgroundSessionApi` uses it), but the FEED lives on Mention's api. So
 * the token is passed in and the URL is built from `mention_widget_api_base_url` — the same
 * configured origin the trending-posts widget uses. Building this URL from the credential's
 * `baseUrl` would send an authenticated request for a Mention feed to `api.oxy.so`.
 *
 * ## An empty page is not a failure
 *
 * Verified against production: the following descriptor answers an UNAUTHENTICATED request
 * with HTTP 200 and zero posts. So a wrong or missing token does not announce itself with a
 * status code — it looks exactly like a user who follows nobody. That is why the token is
 * obtained and classified BEFORE this is called (`FollowingSession.kt`) rather than inferred
 * from the response, and why the caller treats an empty page as "nothing to show" instead of
 * as an error to retry.
 */
internal object FollowingApi {

    private val CONNECT_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(10).toInt()
    private val READ_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(15).toInt()

    /**
     * Fetch the rotation as [accessToken]'s owner.
     *
     * Asks for exactly [ROTATION_LENGTH] posts rather than a page — the widget shows one at a
     * time and rotates through five, so a larger page would be bytes parsed and thrown away
     * on a metered connection.
     *
     * Throws [IOException] for what a later attempt could get past (no network, a timeout, a
     * 5xx) and [org.json.JSONException] for a body that is not the documented shape. The
     * caller distinguishes the two: the first is worth retrying, the second is not.
     */
    suspend fun fetch(context: Context, accessToken: String): List<WidgetPost> =
        withContext(Dispatchers.IO) {
            val base = context.getString(R.string.mention_widget_api_base_url).trimEnd('/')
            val url = URL("$base/feed/mtn?descriptor=following&limit=$FEED_PAGE_LENGTH")
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer $accessToken")
            }
            try {
                val status = connection.responseCode
                if (status != HttpURLConnection.HTTP_OK) {
                    // Includes 401. A token that was valid when it was minted seconds ago and
                    // is refused now is an ambiguous answer, not proof of a revoked session —
                    // the same reasoning the SDK applies to an unrecognised 401 — so it is
                    // raised as a retryable failure and the widget keeps its content. Only
                    // the MINT can conclude that a credential is finished.
                    throw IOException("GET /feed/mtn?descriptor=following responded $status")
                }
                parseFeedResponse(connection.inputStream.bufferedReader().use { it.readText() })
            } finally {
                connection.disconnect()
            }
        }
}
