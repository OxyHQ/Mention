package earth.mention.widgets.feedcard

import android.graphics.Bitmap
import android.util.LruCache

/**
 * The decoded bitmaps, in memory — and the reason the card's payload is bounded.
 *
 * `FeedImageCache` keeps the downloaded FILES; this keeps what was decoded from them. It
 * exists for one specific reason, and it is not speed: `SizeMode.Exact` composes the card
 * once per size the launcher offers, and each composition asks for its own bitmap. A
 * `RemoteViews` keeps ONE bitmap cache for a tree and its sized variants, looking bitmaps up
 * by IDENTITY, so two compositions that decode the same picture separately put two copies in
 * the parcel while two that share one instance put in one. Handing every composition the same
 * instance is therefore what keeps [FEED_CARD_WORST_CASE_BITMAP_BYTES] to a single background and
 * a single avatar, rather than to a multiple of a number the launcher chooses and we cannot
 * see.
 *
 * It can only work because neither bitmap depends on the placement: the background is decoded
 * at a fixed size and cropped by the launcher, and the avatar has always been a fixed 56
 * pixels square. A size-dependent bitmap would be a different key per composition and this
 * whole file would be pointless.
 *
 * Sized in ENTRIES rather than bytes, and small: the rotation shows one post at a time, so
 * the live set is one background and one avatar. Four leaves room for the next post's pair to
 * arrive before the current one is evicted, and caps the cache at roughly a megabyte.
 *
 * Bitmaps handed out here are NEVER recycled. The launcher may still be holding one in a
 * `RemoteViews` it has not drawn yet, and recycling a bitmap out from under the host is a
 * blank card at best. Eviction drops the reference and lets the collector deal with it.
 */
internal object FeedCardBitmapCache {

    private const val MAX_ENTRIES = 4

    /** `LruCache` for its synchronisation: compositions run on whatever thread Glance uses. */
    private val cache = LruCache<String, Bitmap>(MAX_ENTRIES)

    /**
     * The bitmap for [key], decoding it with [decode] only if it is not already held.
     *
     * A miss that decodes to `null` is NOT cached — a truncated download or a file the
     * system cleared should be retried on the next redraw, not remembered as "no picture"
     * for as long as the process lives.
     */
    fun getOrDecode(key: String, decode: () -> Bitmap?): Bitmap? {
        cache.get(key)?.let { return it }
        val decoded = decode() ?: return null
        cache.put(key, decoded)
        return decoded
    }

    /**
     * A key for the background decoded from [url] at [size].
     *
     * The size is part of the key even though it is currently a constant, because the day it
     * stops being one is the day two compositions must not share a bitmap — and a key that
     * ignored it would hand a card the wrong one instead of decoding a new one.
     */
    fun backgroundKey(url: String, size: FeedBitmapSize): String =
        "bg:$url:${size.widthPx}x${size.heightPx}"

    /** As [backgroundKey], for the byline's avatar. */
    fun avatarKey(url: String, size: FeedBitmapSize): String =
        "avatar:$url:${size.widthPx}x${size.heightPx}"
}
