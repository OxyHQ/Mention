package earth.mention.widgets.feedcard

import org.json.JSONArray
import org.json.JSONObject

/**
 * The trending-posts widget's DATA RULES — reading `GET /feed/mtn?descriptor=explore`
 * into the handful of fields a card draws, and back out of the store again.
 *
 * Two of the rules in here are decisions about content rather than about parsing, and
 * both were taken against the real explore feed rather than against the type
 * definitions:
 *
 *  - [chooseDisplayText] — the post text and its link preview's title are usually the
 *    SAME sentence, so showing both spends half the card repeating itself.
 *  - [chooseImageUrl] — the media slot prefers real attached media, falls back to the
 *    preview's image, and collapses when there is neither.
 *
 * Everything here is pure, so all of it is unit-tested on a plain JVM. The
 * distribution it is written against, measured over 30 consecutive explore posts:
 * 20% carried `attachments.media`, 57% carried `linkPreviews`, text ran from 0 to
 * 1708 characters, and one post had no text at all.
 */

/** One post, as the widget draws it. */
internal data class WidgetPost(
    /** Mention post id — the deep-link target, `/p/<id>`. */
    val id: String,
    /**
     * The card's emphasised text, ALREADY CHOSEN between the post body and its link
     * preview's title by [chooseDisplayText], and capped at
     * [MAX_STORED_TEXT_CHARS].
     *
     * May be EMPTY: a post whose whole body was a bare URL with an image has nothing
     * to say in words, and that is a post worth showing on its picture. The layout
     * treats empty as "draw no text", never as an error.
     */
    val text: String,
    /**
     * Absolute URL of the card's image, or `null` for a post with neither media nor a
     * preview image — a third of the feed. `null` collapses the slot with no gap; it
     * is not a missing-image state.
     */
    val imageUrl: String?,
    /**
     * The image's alt text when its author wrote one, for TalkBack. `null` is the
     * common case and means the image is announced generically.
     */
    val imageAlt: String?,
    /** Author's display name. Never blank — a post whose author has none is dropped. */
    val authorName: String,
    /**
     * Author's handle WITHOUT the leading `@`, e.g. `verge@mastodon.social`.
     *
     * EMPTY where hydration could not resolve the author (the backend's degraded
     * author summary carries an empty username on purpose, so that a raw user id can
     * never be rendered as a handle). Empty means the byline shows the name alone.
     */
    val authorHandle: String,
    /**
     * Author's avatar: a bare Oxy file id, or an absolute URL for a federated actor
     * whose picture was never re-hosted. `null` where the author has no picture.
     * Resolved to a URL by `oxyFileUrl`.
     */
    val authorAvatar: String?,
)

/**
 * Longest text kept in the store.
 *
 * Derived, not chosen: it is the largest per-breakpoint budget any card can draw
 * ([LARGEST_TEXT_BUDGET_CHARS]), so storing more would be storing characters no size
 * can ever show. The feed's longest observed post is 1708 characters, which is several
 * times this — the cap is doing real work on every fetch, not guarding an edge case.
 */
internal val MAX_STORED_TEXT_CHARS = LARGEST_TEXT_BUDGET_CHARS

/**
 * Posts held in the store, and therefore the number of position pips.
 *
 * The widget shows ONE post at a time and rotates, so this is the length of the
 * rotation rather than an amount of content to draw. Five is a rotation a reader can
 * place themselves in from the pips at a glance, and five pips fit on the byline row
 * at the narrowest size the widget offers.
 */
internal const val ROTATION_LENGTH = 5

private const val FIELD_DATA = "data"
private const val FIELD_ITEMS = "items"
private const val FIELD_ID = "id"
private const val FIELD_CONTENT = "content"
private const val FIELD_TEXT = "text"
private const val FIELD_ATTACHMENTS = "attachments"
private const val FIELD_MEDIA = "media"
private const val FIELD_LINK_PREVIEWS = "linkPreviews"
private const val FIELD_TITLE = "title"
private const val FIELD_IMAGE = "image"
private const val FIELD_THUMB_URL = "thumbUrl"
private const val FIELD_URL = "url"
private const val FIELD_ALT = "alt"
private const val FIELD_USER = "user"
private const val FIELD_NAME = "name"
private const val FIELD_DISPLAY_NAME = "displayName"
private const val FIELD_USERNAME = "username"
private const val FIELD_AVATAR = "avatar"

/**
 * Read `GET /feed/mtn?descriptor=explore`.
 *
 * The posts are taken from `data.items`, the response's own flattened post list,
 * rather than walked out of `data.slices[].items[].post`. Both carry the same posts in
 * the same order — verified against the live feed, 30 posts either way with matching
 * ids — and the flat one is a field the widget can read without knowing anything about
 * thread slicing.
 *
 * A post is DROPPED when it has no id or no author display name, because both are
 * load-bearing: the id is the deep-link target, and a card whose byline cannot name
 * anyone is a card that could be attributed to anyone. Nothing else drops a post — in
 * particular a post with no text and no image is kept, since the byline and the brand
 * row still make it a legible card, and silently skipping posts would make the pips
 * lie about the rotation.
 *
 * Throws [org.json.JSONException] when the body is not the documented shape; the
 * caller answers for that by keeping whatever it already had.
 */
internal fun parseFeedResponse(body: String, limit: Int = ROTATION_LENGTH): List<WidgetPost> {
    val items = JSONObject(body).getJSONObject(FIELD_DATA).getJSONArray(FIELD_ITEMS)
    return buildList(minOf(items.length(), limit)) {
        for (index in 0 until items.length()) {
            if (size >= limit) break
            val post = items.optJSONObject(index) ?: continue
            add(readPost(post) ?: continue)
        }
    }
}

private fun readPost(post: JSONObject): WidgetPost? {
    val id = post.optString(FIELD_ID).trim()
    if (id.isEmpty()) return null

    val user = post.optJSONObject(FIELD_USER) ?: return null
    val authorName = user.optJSONObject(FIELD_NAME)?.optString(FIELD_DISPLAY_NAME)?.trim().orEmpty()
    if (authorName.isEmpty()) return null

    val previews = post.optJSONArray(FIELD_LINK_PREVIEWS)
    val firstPreview = previews?.optJSONObject(0)
    val media = post.optJSONObject(FIELD_ATTACHMENTS)?.optJSONArray(FIELD_MEDIA)
    val firstMedia = media?.optJSONObject(0)

    return WidgetPost(
        id = id,
        text = chooseDisplayText(
            postText = post.optJSONObject(FIELD_CONTENT)?.optString(FIELD_TEXT).orEmpty(),
            previewTitle = firstPreview?.optString(FIELD_TITLE).orEmpty(),
        ),
        imageUrl = chooseImageUrl(
            mediaThumbUrl = firstMedia?.optString(FIELD_THUMB_URL).orEmpty(),
            mediaUrl = firstMedia?.optString(FIELD_URL).orEmpty(),
            previewImageUrl = firstPreview?.optString(FIELD_IMAGE).orEmpty(),
        ),
        imageAlt = firstMedia?.optString(FIELD_ALT)?.trim()?.ifEmpty { null },
        authorName = authorName,
        // Normalized to bare here so nothing downstream has to know that a federated
        // username arrives as `user@host` while the byline renders `@user@host`.
        authorHandle = user.optString(FIELD_USERNAME).trim().removePrefix("@"),
        authorAvatar = user.optString(FIELD_AVATAR).trim().ifEmpty { null },
    )
}

/**
 * Which string the card leads with: the link preview's title, or the post's own text.
 *
 * The PREVIEW TITLE WINS, and that is a finding from the feed rather than a
 * preference. In more than half of explore's posts the body is the article's headline
 * with its URL glued on the end — "Microsoft confirms Copilot 'super app' coming this
 * year https://www.theverge.com/…" against a preview titled "Microsoft confirms
 * Copilot 'super app' coming this year". Drawing both stacks the same sentence twice
 * and spends the card's best space on a URL; drawing the title alone is the same
 * information without the machinery.
 *
 * It falls back to the post text whenever the title cannot carry the card — no
 * preview, a preview the server resolved without a title, or a title that is nothing
 * but whitespace. Both being empty is a legitimate post (a bare URL with an image),
 * and returns empty.
 */
internal fun chooseDisplayText(postText: String, previewTitle: String): String {
    val title = previewTitle.trim()
    val text = postText.trim()
    val chosen = title.ifEmpty { text }
    return chosen.take(MAX_STORED_TEXT_CHARS)
}

/**
 * The card's image, preferring the smallest URL that is actually an image of the post.
 *
 * The chain is media thumbnail → media original → preview image → nothing:
 *
 *  - ATTACHED MEDIA FIRST, because it is the post's own picture. `thumbUrl` before
 *    `url` since both are absolute and server-resolved (`MediaItem` in
 *    packages/shared-types/src/post.ts: "Backends populate this so the frontend never
 *    computes URLs from `id`"), and the thumbnail is the variant sized for a slot this
 *    small. Nothing here is ever built out of `id` — for a federated post that field
 *    holds the ORIGINAL remote URL, which would fetch a third-party server directly
 *    from the device and bypass our proxy.
 *  - THE PREVIEW IMAGE SECOND. It is an illustration of the link rather than of the
 *    post, which is why it does not outrank real media, but on a link post it is the
 *    only picture there is — and link posts are the majority of the feed.
 *  - `null` LAST, for the third of the feed that is plain text. The slot is not drawn
 *    at all in that case: an empty frame or a placeholder would make a perfectly
 *    ordinary text post look like a failed image load.
 */
internal fun chooseImageUrl(
    mediaThumbUrl: String,
    mediaUrl: String,
    previewImageUrl: String,
): String? = sequenceOf(mediaThumbUrl, mediaUrl, previewImageUrl)
    .map { it.trim() }
    .firstOrNull { it.isNotEmpty() }

/**
 * Store shape for the rotation.
 *
 * Re-encoded rather than storing the response: this is what survives a process death
 * and a reboot, and the response is two orders of magnitude larger than the six fields
 * a card draws (146KB for 30 posts). Storing the DECIDED text and image also means the
 * two content rules above run once per fetch instead of on every redraw.
 */
internal fun encodePosts(posts: List<WidgetPost>): String {
    val array = JSONArray()
    posts.forEach { post ->
        array.put(
            JSONObject()
                .put(FIELD_ID, post.id)
                .put(FIELD_TEXT, post.text)
                // The three nullable fields are written as EMPTY STRINGS rather than as
                // JSON nulls, and read back through `ifEmpty { null }`. `JSONObject.put`
                // with a null value removes the key instead of storing one, and
                // `optString` has its own opinion about `JSONObject.NULL` — writing "" is
                // the one encoding whose round trip does not depend on either.
                .put(FIELD_URL, post.imageUrl.orEmpty())
                .put(FIELD_ALT, post.imageAlt.orEmpty())
                .put(FIELD_NAME, post.authorName)
                .put(FIELD_USERNAME, post.authorHandle)
                .put(FIELD_AVATAR, post.authorAvatar.orEmpty()),
        )
    }
    return array.toString()
}

/**
 * Read back what [encodePosts] wrote.
 *
 * An unreadable blob — an older encoding, a truncated write — decodes to EMPTY rather
 * than throwing. The widget then shows its first-run state and the next refresh
 * replaces it, which is a better outcome than an exception inside a composition the
 * launcher is waiting on.
 */
internal fun decodePosts(stored: String?): List<WidgetPost> {
    if (stored.isNullOrEmpty()) return emptyList()
    val array = runCatching { JSONArray(stored) }.getOrNull() ?: return emptyList()
    return buildList(array.length()) {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val id = item.optString(FIELD_ID)
            val authorName = item.optString(FIELD_NAME)
            if (id.isEmpty() || authorName.isEmpty()) continue
            add(
                WidgetPost(
                    id = id,
                    text = item.optString(FIELD_TEXT),
                    imageUrl = item.optString(FIELD_URL).ifEmpty { null },
                    imageAlt = item.optString(FIELD_ALT).ifEmpty { null },
                    authorName = authorName,
                    authorHandle = item.optString(FIELD_USERNAME),
                    authorAvatar = item.optString(FIELD_AVATAR).ifEmpty { null },
                ),
            )
        }
    }
}

/**
 * Which post the card shows, given the stored rotation position.
 *
 * The modulo is what makes the stored index safe to advance forever and safe to read
 * after the rotation has SHRUNK — a fetch that returned three posts where the last one
 * returned five leaves an index pointing past the end, and a widget must not crash on
 * the home screen over an off-by-one. Returns `null` only for an empty rotation, which
 * is the first-run state.
 */
internal fun postAt(posts: List<WidgetPost>, index: Int): WidgetPost? {
    if (posts.isEmpty()) return null
    return posts[normalizeRotationIndex(index, posts.size)]
}

/**
 * The stored index brought into `0 until size`.
 *
 * `rem` alone is not enough: Kotlin's `%` keeps the sign of the left operand, so a
 * negative index — an `Int` that has wrapped after years of advancing, or a corrupted
 * preference — would produce a negative position and an index-out-of-bounds.
 */
internal fun normalizeRotationIndex(index: Int, size: Int): Int {
    if (size <= 0) return 0
    val remainder = index % size
    return if (remainder < 0) remainder + size else remainder
}

/**
 * The next rotation position.
 *
 * Normalised BEFORE the increment, so the stored value stays inside `0 until size`
 * forever and can never approach `Int.MAX_VALUE` — a widget that has been on a home
 * screen for years advances this every fifteen minutes.
 */
internal fun nextRotationIndex(index: Int, size: Int): Int {
    if (size <= 0) return 0
    return (normalizeRotationIndex(index, size) + 1) % size
}

