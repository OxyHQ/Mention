package earth.mention.widgets.posts

import androidx.compose.ui.unit.Dp
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * How big the card's bitmaps are allowed to be — the one piece of arithmetic on this
 * widget that decides whether it renders at all.
 *
 * A `RemoteViews` crosses a Binder transaction to another process, and one that overruns
 * it does not degrade: the widget is blank, with nothing in the log to say why. This
 * widget's `RemoteViews` carries decoded bitmaps, so the bound has to be real.
 *
 * Under `SizeMode.Exact` (see `PostsWidget`) the parcel carries the sizes the LAUNCHER
 * offers rather than a declared set, so there is no table of sizes to add up and the
 * bound cannot come from one. It comes instead from the HARD PIXEL CEILINGS below: each
 * bitmap is sized for the slot it fills and then capped, so the payload is bounded at any
 * size a launcher can invent — including one no breakpoint declared and one past the
 * provider's own resize ceiling. [POSTS_WORST_CASE_BITMAP_BYTES] is that bound.
 *
 * This file is pure so all of it is unit tested; the decoding itself is in
 * `PostsImageRenderer.kt`.
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
 * Hard ceiling on one thumbnail, in pixels — 46,000, which is 184KB at
 * [BYTES_PER_PIXEL].
 *
 * This, not [THUMBNAIL_PIXELS_PER_DP], is what actually sizes every slot the card draws:
 * at 46,000 pixels a 288 × 162dp band — a 16:9 landscape at the content width of the
 * widest placement the provider asks for, which is the shape most feed photographs and
 * video posters arrive in — comes out at one pixel per dp, and the taller slots a large
 * placement now produces come out a little under it. It is expressed as a pixel count
 * rather than a scale factor because the thing being bounded is memory, and a scale factor
 * bounds nothing when a launcher hands over a size no breakpoint declared.
 *
 * It was 30,000 while `SizeMode.Responsive` put a thumbnail for every image-bearing design
 * in the same parcel. `Exact` carries at most two, and the slot they fill is no longer a
 * 120dp band, so the freed payload goes into keeping the bigger picture as sharp as the
 * small one was rather than into a smaller number. [POSTS_WORST_CASE_BITMAP_BYTES] is what
 * holds that trade honest, and `PostsBitmapTest` is what holds the total inside the
 * transaction.
 */
private const val THUMBNAIL_MAX_PIXELS = 46_000L

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
internal fun imageSlotWidth(size: PostsCardSize, cardWidth: Dp): Dp =
    cardWidth - cardPadding(size) * 2

/**
 * How many layouts one `RemoteViews` carries — TWO.
 *
 * `SizeMode.Exact` composes once per size the launcher offers in
 * `AppWidgetManager.OPTION_APPWIDGET_SIZES`, and on API 31+ a launcher offers the portrait
 * size and the landscape one. They are different sizes, so they can land on different
 * designs with differently-shaped slots, and neither bitmap can be assumed to be the other.
 */
private const val COMPOSITIONS_PER_PARCEL = 2

/**
 * THE NUMBER TO REPORT: bytes of bitmap in the worst-case `RemoteViews` — an avatar and a
 * thumbnail per composition, each at its hard pixel ceiling.
 *
 * The CEILINGS rather than any particular size, because under `SizeMode.Exact` there is no
 * declared set to sum over and the launcher decides the size — so a figure computed from
 * one placement would not bound the next one. Every decode goes through [bitmapSizeFor],
 * which caps at these ceilings, so this figure bounds the payload at ANY size, including a
 * placement past the provider's resize ceiling (which launchers do hand out: a four-cell
 * width is 387dp against a 320dp declaration).
 *
 * It assumes NO deduplication between compositions. `RemoteViews` does share one bitmap
 * cache across its sized variants and would collapse two identical avatars if they were the
 * same instance — they are not, since each size is composed separately — so the real
 * payload is at or below this figure, never above. Measured on a real placement before this
 * arithmetic changed, the launcher's own `views_bitmap_memory` agreed with it to the byte.
 *
 * A worst case is only meaningful against a limit, and the limit here is not a public
 * constant: the ceiling that matters is the Binder transaction the `RemoteViews`
 * travels in, conventionally taken as 1MB for the whole transaction. `PostsBitmapTest`
 * holds this to half of that, leaving the other half for the view tree, the strings and
 * everything else in the same parcel.
 */
internal val POSTS_WORST_CASE_BITMAP_BYTES: Long =
    COMPOSITIONS_PER_PARCEL * (AVATAR_MAX_PIXELS + THUMBNAIL_MAX_PIXELS) * BYTES_PER_PIXEL
