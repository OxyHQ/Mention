package earth.mention.widgets.posts

import androidx.compose.ui.unit.Dp
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * How big the card's bitmaps are allowed to be — the one piece of arithmetic on this
 * widget that decides whether it renders at all.
 *
 * The constraint is `SizeMode.Responsive`: it composes EVERY declared size into the
 * single `RemoteViews` handed to the launcher, so the payload is not the picture on
 * screen but the sum of the pictures for all three designs at once. A `RemoteViews`
 * crosses a Binder transaction to another process, and one that overruns it does not
 * degrade — the widget is blank.
 *
 * So every bitmap is sized for THE DESIGN IT BELONGS TO and then capped by a hard pixel
 * ceiling, and the resulting total is derived in [POSTS_WORST_CASE_BITMAP_BYTES] rather
 * than estimated by hand. This file is pure so all of it is unit tested; the decoding
 * itself is in `PostsImageRenderer.kt`.
 */

/** ARGB_8888 — the only config worth using here, and four bytes a pixel. */
internal const val BYTES_PER_PIXEL = 4

/**
 * Pixels per dp the THUMBNAIL aims for.
 *
 * Above 1.0 because this one is a photograph, not the sparkline's low-opacity
 * watermark: at one pixel per dp a picture on a 3x screen is visibly soft, and softness
 * in the card's only image is the first thing a reader notices. 1.5 is as far as the
 * ceiling below allows the larger designs to go anyway, so it buys sharpness on the
 * smaller slot without changing the worst case.
 */
private const val THUMBNAIL_PIXELS_PER_DP = 1.5f

/**
 * Hard ceiling on one thumbnail, in pixels — 30,000, which is 120KB at
 * [BYTES_PER_PIXEL].
 *
 * This, not [THUMBNAIL_PIXELS_PER_DP], is what actually sizes the two image-bearing
 * designs: it puts the large slot at roughly one pixel per dp and the medium slot a
 * little above it. It is expressed as a pixel count rather than a scale factor because
 * the thing being bounded is memory, and a scale factor bounds nothing when a launcher
 * hands over a size no breakpoint declared.
 */
private const val THUMBNAIL_MAX_PIXELS = 30_000L

/**
 * Pixels per dp the AVATAR aims for, and its ceiling.
 *
 * The avatar is 28dp, so 2x lands at 56 × 56 = 3,136 pixels — 12.5KB, comfortably
 * inside the ceiling, which exists for the same reason as the thumbnail's: to bound an
 * undeclared size rather than a declared one.
 */
private const val AVATAR_PIXELS_PER_DP = 2f
private const val AVATAR_MAX_PIXELS = 4_000L

/** A bitmap needs at least this many pixels on an edge to be worth decoding. */
private const val MIN_BITMAP_EDGE_PX = 2

/** The pixel dimensions to decode a bitmap at. */
internal data class PostsBitmapSize(val widthPx: Int, val heightPx: Int) {
    val pixels: Long get() = widthPx.toLong() * heightPx.toLong()
    val bytes: Long get() = pixels * BYTES_PER_PIXEL
}

/**
 * The bitmap to decode for a space of `width × height`, or `null` when that space is
 * too small to hold a picture.
 *
 * Both axes are scaled by the SAME factor when the ceiling bites, so the decoded
 * bitmap keeps the aspect of the slot it fills and the image is never stretched.
 *
 * The scale is TRUNCATED rather than rounded, which is the difference between a ceiling
 * and a suggestion: rounding both axes up can put the product back over the very limit
 * this branch exists to enforce.
 */
internal fun bitmapSizeFor(
    width: Dp,
    height: Dp,
    pixelsPerDp: Float,
    maxPixels: Long,
): PostsBitmapSize? {
    val widthPx = (width.value * pixelsPerDp).roundToInt()
    val heightPx = (height.value * pixelsPerDp).roundToInt()
    if (widthPx < MIN_BITMAP_EDGE_PX || heightPx < MIN_BITMAP_EDGE_PX) return null

    val pixels = widthPx.toLong() * heightPx.toLong()
    if (pixels <= maxPixels) return PostsBitmapSize(widthPx, heightPx)

    val scale = sqrt(maxPixels.toDouble() / pixels.toDouble()).toFloat()
    return PostsBitmapSize(
        widthPx = (widthPx * scale).toInt().coerceAtLeast(MIN_BITMAP_EDGE_PX),
        heightPx = (heightPx * scale).toInt().coerceAtLeast(MIN_BITMAP_EDGE_PX),
    )
}

/** The thumbnail bitmap for a slot of `width × height`. */
internal fun thumbnailBitmapSize(width: Dp, height: Dp): PostsBitmapSize? =
    bitmapSizeFor(width, height, THUMBNAIL_PIXELS_PER_DP, THUMBNAIL_MAX_PIXELS)

/** The avatar bitmap — square, at [PostsCardDimensions.AVATAR_SIZE]. */
internal fun avatarBitmapSize(): PostsBitmapSize? = bitmapSizeFor(
    width = PostsCardDimensions.AVATAR_SIZE,
    height = PostsCardDimensions.AVATAR_SIZE,
    pixelsPerDp = AVATAR_PIXELS_PER_DP,
    maxPixels = AVATAR_MAX_PIXELS,
)

/**
 * Width the image slot has inside a card of [cardWidth], for [size]'s padding.
 *
 * The slot spans the content width — the image is the card's picture, not a thumbnail
 * beside a column of text.
 */
internal fun imageSlotWidth(size: PostsCardSize, cardWidth: Dp): Dp {
    val padding = if (size == PostsCardSize.SMALL) {
        PostsCardDimensions.PADDING_SMALL
    } else {
        PostsCardDimensions.PADDING
    }
    return cardWidth - padding * 2
}

/**
 * THE NUMBER TO REPORT: bytes of bitmap in the worst-case `RemoteViews` — every
 * declared size, each with its avatar, and a thumbnail wherever the design has a slot.
 *
 * It is derived from [POSTS_WIDGET_SIZES] and the slot table, so it cannot fall out of
 * step with the layout, and it assumes NO deduplication between sizes. `RemoteViews`
 * does share one bitmap cache across its sized variants and would collapse the three
 * identical avatars if they were the same instance — they are not, since each size is
 * composed separately — so the real payload is at or below this figure, never above.
 *
 * A worst case is only meaningful against a limit, and the limit here is not a public
 * constant: the ceiling that matters is the Binder transaction the `RemoteViews`
 * travels in, conventionally taken as 1MB for the whole transaction. `PostsBitmapTest`
 * holds this to half of that, leaving the other half for the view tree, the strings and
 * everything else in the same parcel.
 */
internal val POSTS_WORST_CASE_BITMAP_BYTES: Long = POSTS_WIDGET_SIZES.sumOf { declared ->
    val design = postsCardSize(declared.width, declared.height)
    val avatarBytes = avatarBitmapSize()?.bytes ?: 0L
    val slotHeight = imageSlotBaseHeight(design)
    val thumbnailBytes = if (slotHeight == null) {
        0L
    } else {
        thumbnailBitmapSize(imageSlotWidth(design, declared.width), slotHeight)?.bytes ?: 0L
    }
    avatarBytes + thumbnailBytes
}
