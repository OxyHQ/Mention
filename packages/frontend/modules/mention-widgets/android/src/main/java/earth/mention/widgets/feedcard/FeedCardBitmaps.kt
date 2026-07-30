package earth.mention.widgets.feedcard

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
 * Under `SizeMode.Exact` (see the feed widgets) the parcel carries the sizes the LAUNCHER
 * offers rather than a declared set, so there is no table of sizes to add up and the
 * bound cannot come from one. It comes instead from the HARD PIXEL CEILINGS below: each
 * bitmap is sized for the slot it fills and then capped, so the payload is bounded at any
 * size a launcher can invent — including one no breakpoint declared and one past the
 * provider's own resize ceiling. [FEED_CARD_WORST_CASE_BITMAP_BYTES] is that bound.
 *
 * This file is pure so all of it is unit tested; the decoding itself is in
 * `FeedImageRenderer.kt`.
 */

/** ARGB_8888 — the only config worth using here, and four bytes a pixel. */
internal const val BYTES_PER_PIXEL = 4

/**
 * Pixels in the card's background picture — 60,000, which is 240KB at [BYTES_PER_PIXEL].
 *
 * ## Why this is a pixel COUNT and not a size
 *
 * The background does not depend on the card. It is decoded once at this budget, and the
 * launcher centre-crops it to whatever the placement turns out to be
 * (`ContentScale.Crop`), which is what makes ONE bitmap serve every composition — see
 * [FEED_CARD_WORST_CASE_BITMAP_BYTES] for why that is the difference between a bounded payload
 * and an unbounded one.
 *
 * ## Why 60,000 and not more
 *
 * Set so the parcel is inside its budget EVEN IF the sharing described in
 * [FEED_CARD_WORST_CASE_BITMAP_BYTES] does not happen: two compositions each carrying their own
 * copy of a 240KB picture and a 12.5KB avatar is 505KB, just inside the 512KB
 * `PostsBitmapTest` allows. Sharing is the measured reality — but a ceiling that depends on
 * an optimisation holding is not a ceiling, and the failure it would guard against is a
 * blank widget rather than a slower one.
 *
 * ## What it buys on screen
 *
 * At [BACKGROUND_ASPECT_WIDTH]:[BACKGROUND_ASPECT_HEIGHT] this is 283 × 212 pixels. After
 * the launcher's crop that is roughly 0.7 pixels per dp on a default four-by-three
 * placement and 1.1 on the smallest one the provider allows — softer than the inset band
 * this replaced, which ran at 0.93, and the reason it is acceptable is the scrim: the
 * picture is a backdrop behind [IMAGE_SCRIM_ALPHA] of black, not the card's subject.
 */
private const val BACKGROUND_MAX_PIXELS = 60_000L

/**
 * The aspect the background is decoded at: 4:3.
 *
 * The bitmap is cropped by the launcher rather than by us, so this only decides how much
 * of it survives that crop — a bitmap whose aspect is far from the card's loses the
 * difference, and the pixels it loses are sharpness. 4:3 is the aspect most feed
 * photographs and video posters arrive in, and it is within 10% of a default four-by-three
 * placement (measured 373 × 306dp, 1.22:1, on a 420dpi phone), which is where this card
 * spends most of its life.
 */
private const val BACKGROUND_ASPECT_WIDTH = 4
private const val BACKGROUND_ASPECT_HEIGHT = 3

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
internal data class FeedBitmapSize(val widthPx: Int, val heightPx: Int) {
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
): FeedBitmapSize? {
    val widthPx = (width.value * pixelsPerDp).roundToInt()
    val heightPx = (height.value * pixelsPerDp).roundToInt()
    if (widthPx < MIN_BITMAP_EDGE_PX || heightPx < MIN_BITMAP_EDGE_PX) return null

    val pixels = widthPx.toLong() * heightPx.toLong()
    if (pixels <= maxPixels) return FeedBitmapSize(widthPx, heightPx)

    val scale = sqrt(maxPixels.toDouble() / pixels.toDouble()).toFloat()
    return FeedBitmapSize(
        widthPx = (widthPx * scale).toInt().coerceAtLeast(MIN_BITMAP_EDGE_PX),
        heightPx = (heightPx * scale).toInt().coerceAtLeast(MIN_BITMAP_EDGE_PX),
    )
}

/**
 * The card's background picture — [BACKGROUND_MAX_PIXELS] at 4:3, and the SAME size
 * whatever the placement.
 *
 * That independence is the whole design. A bitmap sized for the card would be a different
 * bitmap in every composition, and the parcel would carry one per composition; one sized
 * for nothing in particular is a single instance every composition can share, which is what
 * [FEED_CARD_WORST_CASE_BITMAP_BYTES] rests on. The launcher makes it fit by cropping
 * (`ContentScale.Crop`) rather than by stretching, so nothing is distorted — the price is
 * paid in the pixels the crop discards, not in the shape of the photograph.
 *
 * The height is derived first and the width from the aspect, so the product cannot exceed
 * the budget through rounding.
 */
internal fun cardBackgroundBitmapSize(): FeedBitmapSize {
    val heightPx = sqrt(
        BACKGROUND_MAX_PIXELS.toDouble() * BACKGROUND_ASPECT_HEIGHT / BACKGROUND_ASPECT_WIDTH,
    ).toInt().coerceAtLeast(MIN_BITMAP_EDGE_PX)
    val widthPx = (heightPx.toLong() * BACKGROUND_ASPECT_WIDTH / BACKGROUND_ASPECT_HEIGHT)
        .toInt()
        .coerceAtLeast(MIN_BITMAP_EDGE_PX)
    return FeedBitmapSize(widthPx = widthPx, heightPx = heightPx)
}

/** The avatar bitmap — square, at [FeedCardDimensions.AVATAR_SIZE]. */
internal fun avatarBitmapSize(): FeedBitmapSize? = bitmapSizeFor(
    width = FeedCardDimensions.AVATAR_SIZE,
    height = FeedCardDimensions.AVATAR_SIZE,
    pixelsPerDp = AVATAR_PIXELS_PER_DP,
    maxPixels = AVATAR_MAX_PIXELS,
)

/**
 * THE NUMBER TO REPORT: bytes of bitmap in the worst-case `RemoteViews` — one background
 * and one avatar, whatever the launcher does.
 *
 * ## Why it is ONE of each rather than one per composition
 *
 * Because neither bitmap depends on the card. `RemoteViews` keeps ONE bitmap cache for a
 * tree and its sized variants, and `BitmapCache.getBitmapId` looks bitmaps up by identity,
 * so the same INSTANCE used in two compositions is written to the parcel once. Both bitmaps
 * here are sized from constants — [cardBackgroundBitmapSize] and [avatarBitmapSize] take no
 * arguments — so every composition asks `FeedCardBitmapCache` for the same key and gets the
 * same instance back. That is what makes this figure independent of how many sizes the
 * launcher offers, which matters because that number is not ours: `OPTION_APPWIDGET_SIZES`
 * is two on a phone launcher and may be more on a foldable, and a bound that multiplied by
 * it would be a bound on a number we cannot see.
 *
 * MEASURED, not argued: with a background on screen the launcher reports exactly this figure
 * — 251,680 bytes, a 282 × 212 picture plus one 56 × 56 avatar — for a card composed at two
 * sizes, and 12,544 for a text-only post, which is one avatar rather than two. The instrument
 * is `dumpsys appwidget`'s `views_bitmap_memory`, and it is also what caught the avatar being
 * decoded per composition while this comment already claimed it was shared: the figure was
 * 264,224, one 12.5KB circle over.
 *
 * For scale, the inset band this replaced measured 275,820 bytes (three avatars and two
 * slot-sized thumbnails, one set per declared size). A picture behind the whole card is
 * therefore CHEAPER than a picture inside it was — the saving is entirely in not decoding one
 * per composition.
 *
 * ## What it is measured against
 *
 * The ceiling that matters is the Binder transaction the `RemoteViews` travels in,
 * conventionally taken as 1MB for the whole transaction, and one that overruns it renders a
 * BLANK widget rather than a smaller picture. `PostsBitmapTest` holds this to half of that,
 * leaving the other half for the view tree, the strings and everything else in the parcel —
 * and it separately holds the UNSHARED case, two full copies, inside the same budget, so
 * the widget survives even if the sharing above ever stops happening.
 */
internal val FEED_CARD_WORST_CASE_BITMAP_BYTES: Long =
    cardBackgroundBitmapSize().bytes + (avatarBitmapSize()?.bytes ?: 0L)
