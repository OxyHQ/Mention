package earth.mention.widgets.posts

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The card's bitmap budget — the arithmetic that decides whether this widget renders at all.
 *
 * The `RemoteViews` the launcher receives crosses a Binder transaction, and one that overruns
 * it does not degrade gracefully: the widget is blank, with nothing in the log to say why. So
 * the total is bounded here, as a test rather than as a comment.
 *
 * Under `SizeMode.Exact` there is no declared-size set to check the bound against — the
 * launcher picks the size — so what is checked instead is that the PIXEL CEILINGS hold across
 * the whole range of placements a launcher can produce, including sizes past the provider's
 * own resize ceiling. That is the property the bound rests on.
 *
 * Nothing here decodes anything — `BitmapFactory` is a stub off-device. What is pinned is
 * every size decided before a decode.
 */
class PostsBitmapTest {

    private companion object {
        /**
         * Half of the 1MB conventionally taken as the Binder transaction limit, leaving the
         * other half for the view tree, the strings and everything else in the same parcel.
         */
        const val PAYLOAD_BUDGET_BYTES = 512L * 1024

        /** The per-thumbnail ceiling the sizing is built around: 46,000px, 184KB at ARGB. */
        const val THUMBNAIL_CEILING_PIXELS = 46_000L

        /** Placements to sweep: the provider's floor, its ceiling, and past both. */
        val SWEPT_WIDTHS = listOf(110.dp, 250.dp, 320.dp, 387.dp, 500.dp)
        val SWEPT_HEIGHTS = listOf(110.dp, 180.dp, 260.dp, 325.dp, 460.dp, 600.dp)
    }

    // ── The worst-case payload ──────────────────────────────────────────────────────

    @Test
    fun `the worst-case bitmap payload stays inside its budget`() {
        assertTrue(
            "worst case is $POSTS_WORST_CASE_BITMAP_BYTES bytes, over the " +
                "$PAYLOAD_BUDGET_BYTES budget — a widget this heavy renders blank",
            POSTS_WORST_CASE_BITMAP_BYTES <= PAYLOAD_BUDGET_BYTES,
        )
    }

    @Test
    fun `the worst case actually counts the thumbnails, not just the avatars`() {
        // A vacuity floor. The total is a product of a composition count and two ceilings, so
        // a bug that dropped the thumbnail term would leave a comfortably small number that
        // passes the budget assertion above while measuring nothing.
        val avatarsOnly = (avatarBitmapSize()?.bytes ?: 0L) * 2

        assertTrue("avatars alone should not be the whole payload", avatarsOnly > 0)
        assertTrue(
            "worst case $POSTS_WORST_CASE_BITMAP_BYTES is no more than the avatars ($avatarsOnly)",
            POSTS_WORST_CASE_BITMAP_BYTES > avatarsOnly,
        )
    }

    @Test
    fun `the worst case counts more than one composition`() {
        // The other half of the same floor: `Exact` composes the portrait size AND the
        // landscape one into the same parcel, so a bound written for a single layout would be
        // half the real payload.
        val oneComposition = (avatarBitmapSize()?.bytes ?: 0L) +
            THUMBNAIL_CEILING_PIXELS * BYTES_PER_PIXEL

        assertTrue(
            "worst case $POSTS_WORST_CASE_BITMAP_BYTES does not cover two compositions",
            POSTS_WORST_CASE_BITMAP_BYTES >= oneComposition * 2,
        )
    }

    @Test
    fun `no thumbnail at any placement exceeds the per-bitmap ceiling`() {
        // The bound has no declared-size set to rest on any more, so it rests on this: every
        // slot the derivation can produce, at every placement a launcher can hand over,
        // decodes inside the ceiling.
        var checked = 0
        SWEPT_WIDTHS.forEach { width ->
            SWEPT_HEIGHTS.forEach { height ->
                val design = postsCardSize(width, height)
                (0..textMaxLines(design)).forEach { lines ->
                    val slotHeight = imageSlotHeight(
                        size = design,
                        widgetHeight = height,
                        textLines = lines,
                        showsRotationControls = showsRotationControls(design, rotationLength = 5),
                        fontScale = 1f,
                    ) ?: return@forEach
                    val size = thumbnailBitmapSize(imageSlotWidth(design, width), slotHeight)
                        ?: return@forEach
                    checked++

                    assertTrue(
                        "$width × $height at $lines lines decodes " +
                            "${size.widthPx}×${size.heightPx} = ${size.pixels}px",
                        size.pixels <= THUMBNAIL_CEILING_PIXELS,
                    )
                }
            }
        }

        // A vacuity floor on the sweep itself: a derivation that returned null everywhere
        // would satisfy every assertion above without measuring one bitmap.
        assertTrue("the sweep checked only $checked thumbnails", checked >= 20)
    }

    @Test
    fun `a thumbnail is sized for the slot it fills, not for the biggest one`() {
        val shortBand = requireNotNull(thumbnailBitmapSize(355.dp, 72.dp))
        val tallBand = requireNotNull(thumbnailBitmapSize(355.dp, 256.dp))

        // A card that decoded every picture at the largest slot's size would carry the tall
        // band's pixels on a placement showing the short one.
        assertTrue("the tall slot decodes taller", tallBand.heightPx > shortBand.heightPx)
        assertTrue("the short slot stays under the ceiling by a margin", shortBand.pixels < THUMBNAIL_CEILING_PIXELS)
    }

    @Test
    fun `the ceiling keeps a big slot close to one pixel per dp`() {
        // Why the ceiling moved with the slot: the picture is the card's one photograph, and a
        // 16:9 band at the content width of the widest placement the provider asks for is the
        // shape it usually arrives in. That shape has to land at about one pixel per dp, or
        // the card's only image is visibly soft.
        val band = requireNotNull(thumbnailBitmapSize(288.dp, 162.dp))
        val pixelsPerDp = band.widthPx / 288f

        assertTrue("a 288 × 162dp band decodes at $pixelsPerDp px/dp", pixelsPerDp >= 0.95f)
    }

    @Test
    fun `a thumbnail keeps the aspect ratio of the slot it fills`() {
        // Both axes are scaled by the same factor when the ceiling bites, so a photograph is
        // never stretched into its slot.
        val slotAspect = 288f / 120f
        val size = requireNotNull(thumbnailBitmapSize(288.dp, 120.dp))
        val bitmapAspect = size.widthPx.toFloat() / size.heightPx.toFloat()

        assertEquals(slotAspect, bitmapAspect, 0.05f)
    }

    // ── The sizing rules ───────────────────────────────────────────────────────────

    @Test
    fun `a size inside the ceiling is used exactly`() {
        val size = requireNotNull(bitmapSizeFor(100.dp, 100.dp, pixelsPerDp = 1f, maxPixels = 1_000_000L))

        assertEquals(100, size.widthPx)
        assertEquals(100, size.heightPx)
    }

    @Test
    fun `the ceiling is a ceiling, not a suggestion`() {
        // Rounding both axes UP after scaling can put the product back over the very limit
        // this branch exists to enforce: 4000×4000 scales to 244.95 per axis, and 245×245 is
        // 60,025 — over a 60,000 limit.
        val size = requireNotNull(bitmapSizeFor(4000.dp, 4000.dp, pixelsPerDp = 1f, maxPixels = 60_000L))

        assertEquals(244, size.widthPx)
        assertEquals(244, size.heightPx)
        assertTrue("${size.pixels} exceeds the 60,000 ceiling", size.pixels <= 60_000L)
    }

    @Test
    fun `a space too small to draw in yields no bitmap`() {
        // A launcher may hand over a size no breakpoint declared; a one-pixel bitmap is not
        // worth a decode, and a zero-pixel one cannot be allocated at all.
        assertNull(bitmapSizeFor(1.dp, 1.dp, pixelsPerDp = 1f, maxPixels = 30_000L))
        assertNull(bitmapSizeFor(0.dp, 100.dp, pixelsPerDp = 1f, maxPixels = 30_000L))
        assertNull(bitmapSizeFor(100.dp, 100.dp, pixelsPerDp = 0.001f, maxPixels = 30_000L))
    }

    @Test
    fun `the avatar is decoded above one pixel per dp`() {
        val size = requireNotNull(avatarBitmapSize())

        // 28dp at 2x. A circle this small at one pixel per dp reads as visibly soft next to
        // the text beside it.
        assertEquals(56, size.widthPx)
        assertEquals(size.widthPx, size.heightPx)
    }

    @Test
    fun `bytes are counted at four per pixel`() {
        val size = PostsBitmapSize(widthPx = 10, heightPx = 10)

        assertEquals(100L, size.pixels)
        assertEquals(400L, size.bytes)
    }

    // ── Decoding at size ───────────────────────────────────────────────────────────

    @Test
    fun `a large source is sampled down to the smallest power of two that still covers the slot`() {
        val slot = PostsBitmapSize(widthPx = 300, heightPx = 200)

        // 2048/4 = 512, which still covers 300×200; 2048/8 = 256, which does not.
        assertEquals(4, sampleSizeFor(sourceWidth = 2048, sourceHeight = 2048, target = slot))
    }

    @Test
    fun `a source no bigger than the slot is not sampled at all`() {
        val slot = PostsBitmapSize(widthPx = 300, heightPx = 200)

        // Sampling past the slot would upscale the picture into it and undo the point.
        assertEquals(1, sampleSizeFor(sourceWidth = 100, sourceHeight = 100, target = slot))
        assertEquals(1, sampleSizeFor(sourceWidth = 320, sourceHeight = 240, target = slot))
    }

    @Test
    fun `sampling stops on the shorter axis`() {
        val slot = PostsBitmapSize(widthPx = 100, heightPx = 100)

        // A wide panorama: halving is bounded by the height, or the result would no longer
        // cover the slot vertically and would be stretched to fill it.
        assertEquals(2, sampleSizeFor(sourceWidth = 4000, sourceHeight = 200, target = slot))
    }

    @Test
    fun `a source with no dimensions is not sampled`() {
        // What `BitmapFactory` reports for a file that is not an image.
        assertEquals(1, sampleSizeFor(0, 0, PostsBitmapSize(100, 100)))
        assertEquals(1, sampleSizeFor(-1, 100, PostsBitmapSize(100, 100)))
    }
}
