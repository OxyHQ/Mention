package earth.mention.widgets.posts

import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The card's bitmap budget — the arithmetic that decides whether this widget renders at all.
 *
 * `SizeMode.Responsive` composes every declared size into the ONE `RemoteViews` the launcher
 * receives, and that parcel crosses a Binder transaction. A `RemoteViews` that overruns it
 * does not degrade gracefully: the widget is blank, with nothing in the log to say why. So
 * the total is bounded here, as a test rather than as a comment, and the bound is checked
 * against the same declared-size set the widget actually uses.
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

        /** The per-thumbnail ceiling the sizing is built around: 30,000px, 120KB at ARGB. */
        const val THUMBNAIL_CEILING_PIXELS = 30_000L

        /**
         * The worst case as it stood BEFORE the byline row carried an advance control —
         * 275,820 bytes across the three declared sizes.
         *
         * A RATCHET rather than a record: the control had to be added without enlarging the
         * parcel, and the only way this number can grow is a bigger image slot or a fourth
         * declared size. The control itself contributes nothing to it, and that is not an
         * estimate — Glance translates a drawable-resource `ImageProvider` with
         * `RemoteViews.setImageViewResource` (verified in `ImageTranslator` in
         * glance-appwidget 1.1.1), so the chevron crosses the Binder transaction as an `int`
         * while only the avatar and the thumbnail cross it as pixels.
         */
        const val PAYLOAD_BEFORE_CONTROL_BYTES = 275_820L

        /** The declared placement a given design is drawn for. */
        fun declared(design: PostsCardSize): DpSize =
            POSTS_WIDGET_SIZES.first { postsCardSize(it.width, it.height) == design }
    }

    /** The two real image slots, as the card composes them. */
    private val mediumSlotWidth =
        imageSlotWidth(PostsCardSize.MEDIUM, declared(PostsCardSize.MEDIUM).width)
    private val mediumSlotHeight = requireNotNull(imageSlotBaseHeight(PostsCardSize.MEDIUM))
    private val largeSlotWidth =
        imageSlotWidth(PostsCardSize.LARGE, declared(PostsCardSize.LARGE).width)
    private val largeSlotHeight = requireNotNull(imageSlotBaseHeight(PostsCardSize.LARGE))

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
    fun `adding the advance control did not enlarge the payload`() {
        assertTrue(
            "worst case is $POSTS_WORST_CASE_BITMAP_BYTES bytes, up from " +
                "$PAYLOAD_BEFORE_CONTROL_BYTES before the advance control — a control is not " +
                "allowed to cost the parcel anything",
            POSTS_WORST_CASE_BITMAP_BYTES <= PAYLOAD_BEFORE_CONTROL_BYTES,
        )
    }

    @Test
    fun `the worst case actually counts the thumbnails, not just the avatars`() {
        // A vacuity floor. The total is a sum over sizes with a nullable slot in the middle,
        // so a bug that dropped every thumbnail would leave a comfortably small number that
        // passes the budget assertion above while measuring nothing.
        val avatarsOnly = (avatarBitmapSize()?.bytes ?: 0L) * POSTS_WIDGET_SIZES.size

        assertTrue("avatars alone should not be the whole payload", avatarsOnly > 0)
        assertTrue(
            "worst case $POSTS_WORST_CASE_BITMAP_BYTES is no more than the avatars ($avatarsOnly)",
            POSTS_WORST_CASE_BITMAP_BYTES > avatarsOnly,
        )
    }

    @Test
    fun `no single thumbnail exceeds the per-bitmap ceiling`() {
        POSTS_WIDGET_SIZES.forEach { declared ->
            val design = postsCardSize(declared.width, declared.height)
            val slotHeight = imageSlotBaseHeight(design) ?: return@forEach
            val size = requireNotNull(
                thumbnailBitmapSize(imageSlotWidth(design, declared.width), slotHeight),
            )

            assertTrue(
                "$design decodes ${size.widthPx}×${size.heightPx} = ${size.pixels}px",
                size.pixels <= THUMBNAIL_CEILING_PIXELS,
            )
        }
    }

    @Test
    fun `each design's thumbnail is sized for its own slot`() {
        // Read out of the slot table rather than written down, so these stay the sizes the
        // card actually decodes at even after the slots change height.
        val medium = requireNotNull(thumbnailBitmapSize(mediumSlotWidth, mediumSlotHeight))
        val large = requireNotNull(thumbnailBitmapSize(largeSlotWidth, largeSlotHeight))

        // Sized per design, not one bitmap reused across sizes: a card that put the largest
        // slot's bitmap into every declared size would multiply the payload by three.
        assertTrue("the large slot is taller than the medium one", large.heightPx > medium.heightPx)
    }

    @Test
    fun `a thumbnail keeps the aspect ratio of the slot it fills`() {
        // Both axes are scaled by the same factor when the ceiling bites, so a photograph is
        // never stretched into its slot.
        val slotAspect = largeSlotWidth.value / largeSlotHeight.value
        val size = requireNotNull(thumbnailBitmapSize(largeSlotWidth, largeSlotHeight))
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
