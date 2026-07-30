package earth.mention.widgets.feedcard

import android.content.Context
import android.util.Log
import earth.mention.widgets.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.MalformedURLException
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * The card's images, on disk.
 *
 * A widget composition cannot fetch anything: `provideGlance` runs while the launcher
 * waits for a `RemoteViews`, so an HTTP request in there would stall the home screen for
 * as long as the network takes. Every image is therefore downloaded by the refresh
 * WORKER, ahead of the redraw, and the composition only ever reads a local file.
 *
 * What gets downloaded is the CURRENT post's pair — one avatar and at most one thumbnail
 * — not the whole rotation's. Rotating is the mechanism that makes this widget cheap: at
 * any moment the cache needs two files, and [prune] is what keeps that true over months
 * of use rather than accumulating every image the feed has ever shown.
 *
 * ONE INSTANCE PER WIDGET FAMILY, each with its OWN [directoryName]. They are separate
 * directories because [prune] is exact — it deletes every file the rotation it was given does
 * not name — so a shared directory would have each widget's refresh evicting the other's
 * pictures, and both would re-download them twice an hour forever. The cost of separating them
 * is that a post appearing in both feeds is stored twice, a few tens of kilobytes; the
 * alternative is either that mutual eviction or a prune that has to reach into a sibling
 * widget's store to know what to keep.
 */
internal class FeedImageCache(private val directoryName: String) {

    /**
     * The invariants, which are the same for every instance — only the directory differs.
     *
     * A companion rather than class-body properties because `const val` is not legal in a
     * class body, and because one copy of these is correct: two caches do not want two
     * different timeouts.
     */
    private companion object {
        private const val TAG = "MentionFeedWidget"

        private val CONNECT_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(10).toInt()
        private val READ_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(20).toInt()

        /**
         * Most bytes read from one image.
         *
         * The URLs the widget is handed are thumbnails and avatars, tens of kilobytes each,
         * so this is not a budget — it is a bound on a response that turns out not to be
         * what it claimed. Without it a mis-resolved URL pointing at a video file would be
         * streamed to the device's disk in full, on a metered connection, in the background.
         */
        private const val MAX_IMAGE_BYTES = 4L * 1024 * 1024

        /** Read buffer. 16KB is the JDK's own default for stream copies. */
        private const val COPY_BUFFER_BYTES = 16 * 1024
    }

    /**
     * Whether [url] is one the widget is willing to fetch.
     *
     * A HOST ALLOWLIST, derived from the same two configured origins the widget already
     * talks to, because the alternative is a background job on someone's phone fetching
     * whatever URL arrives in a JSON body. Every image URL in the feed is server-resolved
     * to one of these two — Oxy's CDN for native and re-hosted media, our own media proxy
     * for anything federated — so a URL pointing anywhere else is not a picture this
     * widget was meant to load, and fetching it would leak the device's address to a
     * third party that the app itself never contacts directly.
     *
     * A rejected URL costs the card its picture and is logged; it never costs the card.
     */
    private fun isAllowed(context: Context, url: URL): Boolean {
        if (url.protocol != "https" && url.protocol != "http") return false
        val allowedHosts = listOf(
            R.string.mention_widget_api_base_url,
            R.string.mention_widget_media_base_url,
        ).mapNotNull { resource ->
            runCatching { URL(context.getString(resource)).host }.getOrNull()
        }
        return url.host in allowedHosts
    }

    /**
     * The file [url] is cached at, whether or not it has been downloaded.
     *
     * Named by a SHA-256 of the URL: it is a fixed-length name with no path separators or
     * query punctuation in it, so no URL can escape the cache directory or collide with
     * another. The URL is the whole key, which means a media variant (`?variant=w320`)
     * and its original are different entries, as they should be.
     */
    private fun fileFor(context: Context, url: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(url.toByteArray())
        val name = digest.joinToString(separator = "") { byte -> "%02x".format(byte) }
        return File(directory(context), name)
    }

    private fun directory(context: Context): File =
        File(context.applicationContext.cacheDir, directoryName)

    /**
     * The cached file for [url] if it is ALREADY on disk, and `null` otherwise.
     *
     * What a composition is allowed to call. It never downloads: composing runs while the
     * launcher waits for its `RemoteViews`, so a fetch here would stall the home screen for
     * as long as the network takes — and if the file is missing the layout has a slot that
     * collapses. The worker's [ensureCached] is what makes it present in the first place.
     *
     * The emptiness check matters because the system may clear the cache directory at any
     * moment, including between the worker's download and the next composition.
     */
    fun fileForComposition(context: Context, url: String): File? {
        val file = fileFor(context, url)
        return if (file.isFile && file.length() > 0L) file else null
    }

    /**
     * The local file for [url], downloading it if it is not already there.
     *
     * Returns `null` for every failure — a URL off the allowlist, a dead host, a response
     * that is not an image — because the caller's only options are to draw the picture or
     * not, and it has a layout that collapses cleanly when there is none.
     *
     * An already-cached file is NEVER re-downloaded. These URLs are content-addressed
     * (an Oxy file id, or a proxy URL keyed on the remote one), so the bytes behind one
     * do not change; re-fetching would spend a request to receive the same image.
     */
    suspend fun ensureCached(context: Context, url: String): File? = withContext(Dispatchers.IO) {
        val parsed = try {
            URL(url)
        } catch (cause: MalformedURLException) {
            Log.w(TAG, "Card image URL is not a URL", cause)
            return@withContext null
        }
        if (!isAllowed(context, parsed)) {
            Log.w(TAG, "Refusing to fetch a card image from an unexpected host: ${parsed.host}")
            return@withContext null
        }

        val file = fileFor(context, url)
        if (file.isFile && file.length() > 0L) return@withContext file

        try {
            download(parsed, file)
            file
        } catch (cause: IOException) {
            Log.w(TAG, "Could not cache a card image", cause)
            // A partial file would be indistinguishable from a good one next time.
            file.delete()
            null
        }
    }

    /**
     * Fetch [url] into [destination].
     *
     * Written to a temporary file and renamed, so a download interrupted by the process
     * being killed can never leave a half-written image that the next composition would
     * read as complete.
     */
    private fun download(url: URL, destination: File) {
        destination.parentFile?.mkdirs()
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("Accept", "image/*")
        }
        try {
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_OK) {
                throw IOException("Image request responded $status")
            }
            // The bytes are handed to `BitmapFactory`, so a response that is not an image
            // is caught here rather than by a decode that returns null for reasons nobody
            // can distinguish afterwards.
            val contentType = connection.contentType?.substringBefore(';')?.trim().orEmpty()
            if (!contentType.startsWith("image/")) {
                throw IOException("Image request returned ${contentType.ifEmpty { "no content type" }}")
            }

            val temporary = File(destination.parentFile, "${destination.name}.part")
            try {
                connection.inputStream.use { input ->
                    temporary.outputStream().use { output ->
                        val buffer = ByteArray(COPY_BUFFER_BYTES)
                        var total = 0L
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            total += read
                            if (total > MAX_IMAGE_BYTES) {
                                throw IOException("Image exceeded $MAX_IMAGE_BYTES bytes")
                            }
                            output.write(buffer, 0, read)
                        }
                    }
                }
                if (!temporary.renameTo(destination)) {
                    throw IOException("Could not move the downloaded image into place")
                }
            } finally {
                // A no-op on the success path — the rename already moved it.
                temporary.delete()
            }
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Delete every cached image except the ones [keep] names.
     *
     * Called after each refresh with the URLs the stored rotation actually references, so
     * the directory holds what the widget can currently draw and nothing else. This is
     * the whole eviction policy: with a rotation of five posts there is no working set
     * large enough to need ages or sizes weighed against each other.
     */
    fun prune(context: Context, keep: Collection<String>) {
        val directory = directory(context)
        val files = directory.listFiles() ?: return
        val keepNames = keep.map { fileFor(context, it).name }.toSet()
        files.forEach { file ->
            if (file.name !in keepNames && !file.delete()) {
                Log.w(TAG, "Could not evict a cached card image: ${file.name}")
            }
        }
    }
}
