package earth.mention.widgets.feedcard

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
 * The card's background is the reason this file matters more than it used to: a picture behind
 * the whole card is several times the band it replaced. What keeps it bounded is that the
 * bitmap does not depend on the placement, so every composition shares ONE instance — and
 * because that is an argument rather than a guarantee, the budget is checked BOTH ways here:
 * with the sharing, and with two full copies in case it ever stops happening.
 *
 * Nothing here decodes anything — `BitmapFactory` is a stub off-device. What is pinned is
 * every size decided before a decode.
 */
class FeedCardBitmapsTest {

    private companion object {
        /**
         * Half of the 1MB conventionally taken as the Binder transaction limit, leaving the
         * other half for the view tree, the strings and everything else in the same parcel.
         */
        const val PAYLOAD_BUDGET_BYTES = 512L * 1024

        /** The background's pixel budget: 60,000px, 240KB at ARGB. */
        const val BACKGROUND_BUDGET_PIXELS = 60_000L

        /**
         * WCAG AA's contrast floor for text below 18pt — the smallest type on this card is a
         * 12sp handle, so this is the figure the scrim has to clear rather than the 3:1 that
         * large text would allow.
         */
        const val AA_CONTRAST_FLOOR = 4.5f

        /** Placements a launcher can produce, from the provider's floor to past its ceiling. */
        val SWEPT_SIZES = listOf(
            110.dp to 110.dp,
            250.dp to 110.dp,
            250.dp to 180.dp,
            320.dp to 320.dp,
            373.dp to 306.dp,
            387.dp to 325.dp,
            500.dp to 600.dp,
        )
    }

    // ── The worst-case payload ──────────────────────────────────────────────────────

    @Test
    fun `the worst-case bitmap payload stays inside its budget`() {
        assertTrue(
            "worst case is $FEED_CARD_WORST_CASE_BITMAP_BYTES bytes, over the " +
                "$PAYLOAD_BUDGET_BYTES budget — a widget this heavy renders blank",
            FEED_CARD_WORST_CASE_BITMAP_BYTES <= PAYLOAD_BUDGET_BYTES,
        )
    }

    @Test
    fun `the payload fits even if the compositions stop sharing one instance`() {
        // The bound above holds because both bitmaps are size-independent, so the parcel
        // carries one of each however many sizes the launcher asks for. That rests on
        // `RemoteViews` deduplicating by identity, which is a claim about someone else's code
        // — so the ceiling is also set low enough that TWO full copies fit, which is what a
        // phone launcher would produce if the sharing ever stopped. A blank widget is not an
        // acceptable outcome for an optimisation regressing.
        val unshared = FEED_CARD_WORST_CASE_BITMAP_BYTES * 2

        assertTrue(
            "two unshared copies are $unshared bytes, over the $PAYLOAD_BUDGET_BYTES budget",
            unshared <= PAYLOAD_BUDGET_BYTES,
        )
    }

    /**
     * THE CEILING IS WHAT THE BUDGET AFFORDS — derived here, not restated.
     *
     * `BACKGROUND_MAX_PIXELS` and [BACKGROUND_BUDGET_PIXELS] are the same number written in two
     * files, and every other assertion in here checks a decoded size against the copy in THIS
     * file. So the one thing none of them can see is the two copies drifting apart: lower the
     * source constant and the sweep still passes against a stale 60,000 here, which would read
     * as a widget that is merely conservative while actually being softer than it needs to be.
     *
     * This computes the ceiling from the budget instead — `budget / 2 compositions / 4 bytes
     * − the avatar` — and checks the real sizing function against it, so the derivation is the
     * assertion rather than a comment. It fails if the budget moves, if a third bitmap joins the
     * parcel, or if either copy of the ceiling is edited alone.
     */
    @Test
    fun `the background ceiling is what the budget actually affords`() {
        val perComposition = PAYLOAD_BUDGET_BYTES / 2 / BYTES_PER_PIXEL
        val affordable = perComposition - (avatarBitmapSize()?.pixels ?: 0L)
        // Asked of the sizing function, so this reads the SOURCE ceiling rather than the copy
        // above — which is the whole point of the test.
        val decoded = cardBackgroundBitmapSize().pixels

        assertTrue("the background should have a size at all", decoded > 0L)
        assertTrue(
            "the background decodes ${decoded}px, past the ${affordable}px the budget affords " +
                "beside an avatar — the parcel would overrun and the widget would render blank",
            decoded <= affordable,
        )
        // And it is not left far under what it could use, which would be softness bought for
        // nothing. A tenth is the slack the rounding down to a whole 60,000 needs.
        assertTrue(
            "the background decodes ${decoded}px of an affordable ${affordable}px, wasting " +
                "more than a tenth of the budget on softness",
            decoded >= affordable - affordable / 10,
        )
    }

    @Test
    fun `the worst case counts the background, not just the avatar`() {
        // A vacuity floor. The total is a sum of two terms, and the avatar is the small one,
        // so a bug that dropped the background would leave a comfortably small number that
        // passes both budget assertions above while measuring almost nothing.
        val avatarOnly = avatarBitmapSize()?.bytes ?: 0L

        assertTrue("the avatar should have a size at all", avatarOnly > 0)
        assertTrue(
            "worst case $FEED_CARD_WORST_CASE_BITMAP_BYTES is under ten avatars " +
                "(${avatarOnly * 10}), so the background is missing or is thumbnail-sized",
            FEED_CARD_WORST_CASE_BITMAP_BYTES > avatarOnly * 10,
        )
    }

    // ── The background, which is sized without reference to the card ───────────────

    @Test
    fun `one picture is one cache key, and two pictures are two`() {
        // The property the payload bound rests on, and the one that would show the wrong
        // photograph if it were wrong. Same URL and size means the same key, so every
        // composition of one update gets ONE instance and the parcel carries one copy; a
        // different URL must never collide onto it, or a card would draw the previous post's
        // picture.
        val size = cardBackgroundBitmapSize()
        val first = FeedCardBitmapCache.backgroundKey("https://cdn.example/a.jpg", size)
        val again = FeedCardBitmapCache.backgroundKey("https://cdn.example/a.jpg", size)
        val other = FeedCardBitmapCache.backgroundKey("https://cdn.example/b.jpg", size)

        assertEquals(first, again)
        assertTrue("two posts must not share one key", first != other)
        // The avatar shares the cache, so its keys must not collide with a background's.
        assertTrue(
            "avatar and background keys collide",
            FeedCardBitmapCache.avatarKey("https://cdn.example/a.jpg", size) != first,
        )
    }

    @Test
    fun `the background stays inside its pixel budget`() {
        val size = cardBackgroundBitmapSize()

        assertTrue(
            "${size.widthPx}×${size.heightPx} = ${size.pixels}px, over the budget",
            size.pixels <= BACKGROUND_BUDGET_PIXELS,
        )
        // A vacuity floor: the budget is a ceiling, and a size far under it would pass the
        // assertion above while putting a thumbnail-sized picture behind a whole card.
        assertTrue("${size.pixels}px is not a picture", size.pixels >= BACKGROUND_BUDGET_PIXELS / 2)
    }

    @Test
    fun `the background is decoded at four by three`() {
        val size = cardBackgroundBitmapSize()
        val aspect = size.widthPx.toFloat() / size.heightPx.toFloat()

        // The aspect decides how much of the bitmap survives the launcher's centre-crop, so a
        // square or portrait background would quietly throw away a third of the pixels the
        // budget above paid for.
        assertEquals(4f / 3f, aspect, 0.02f)
    }

    @Test
    fun `enough of the background survives the crop to stay a picture`() {
        // What the fixed aspect actually costs at each placement: the launcher centre-crops,
        // so the visible pixels are the bitmap's area times the smaller of the two aspect
        // ratios. Below a third of the bitmap the card would be showing a strip blown up.
        val size = cardBackgroundBitmapSize()
        val bitmapAspect = size.widthPx.toFloat() / size.heightPx.toFloat()

        SWEPT_SIZES.forEach { (width, height) ->
            val cardAspect = width.value / height.value
            val visible = minOf(cardAspect / bitmapAspect, bitmapAspect / cardAspect)

            assertTrue(
                "at $width × $height only ${(visible * 100).toInt()}% of the picture is used",
                visible >= 0.33f,
            )
        }
    }

    // ── Legibility over the picture ────────────────────────────────────────────────

    @Test
    fun `the scrim clears the contrast floor over the brightest possible photograph`() {
        // The card's one real risk: text over a photograph nobody vetted. The explore feed can
        // supply a picture that is white exactly where the byline sits, so the scrim has to be
        // strong enough for the WORST case rather than for a typical one — and this is the
        // assertion that stops it being weakened for looks, because the failure it prevents
        // (grey text on a white sky) is invisible in any screenshot taken over a dark image.
        val contrast = whiteTextContrastOverWhite(IMAGE_SCRIM_ALPHA)

        assertTrue(
            "white text over a $IMAGE_SCRIM_ALPHA scrim on white is only " +
                "${"%.2f".format(contrast)}:1, under the $AA_CONTRAST_FLOOR:1 WCAG AA floor " +
                "for the 12sp handle",
            contrast >= AA_CONTRAST_FLOOR,
        )
    }

    @Test
    fun `the scrim is no darker than the floor requires`() {
        // The other side of it: the scrim is the picture's cost, so it should be the least that
        // clears the floor rather than a comfortable margin. One step lighter must FAIL the
        // floor — which is what makes the figure derived rather than picked.
        val oneStepLighter = whiteTextContrastOverWhite(IMAGE_SCRIM_ALPHA - 0.05f)

        assertTrue(
            "a scrim 5% lighter still clears the floor at ${"%.2f".format(oneStepLighter)}:1, " +
                "so $IMAGE_SCRIM_ALPHA is darker than it needs to be",
            oneStepLighter < AA_CONTRAST_FLOOR,
        )
    }

    @Test
    fun `the contrast maths agrees with the two figures WCAG is defined by`() {
        // A control on the helper itself, since both assertions above are only as good as it
        // is: white on black is 21:1 and white on white is 1:1, by definition.
        assertEquals(21.0, whiteTextContrastOverWhite(1f).toDouble(), 0.01)
        assertEquals(1.0, whiteTextContrastOverWhite(0f).toDouble(), 0.01)
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
        val size = FeedBitmapSize(widthPx = 10, heightPx = 10)

        assertEquals(100L, size.pixels)
        assertEquals(400L, size.bytes)
    }

    // ── Decoding at size ───────────────────────────────────────────────────────────

    @Test
    fun `a large source is sampled down to the smallest power of two that still covers the target`() {
        val target = FeedBitmapSize(widthPx = 300, heightPx = 200)

        // 2048/4 = 512, which still covers 300×200; 2048/8 = 256, which does not.
        assertEquals(4, sampleSizeFor(sourceWidth = 2048, sourceHeight = 2048, target = target))
    }

    @Test
    fun `a source no bigger than the target is not sampled at all`() {
        val target = FeedBitmapSize(widthPx = 300, heightPx = 200)

        // Sampling past the target would upscale the picture into it and undo the point.
        assertEquals(1, sampleSizeFor(sourceWidth = 100, sourceHeight = 100, target = target))
        assertEquals(1, sampleSizeFor(sourceWidth = 320, sourceHeight = 240, target = target))
    }

    @Test
    fun `sampling stops on the shorter axis`() {
        val target = FeedBitmapSize(widthPx = 100, heightPx = 100)

        // A wide panorama: halving is bounded by the height, or the result would no longer
        // cover the target vertically and would be stretched to fill it.
        assertEquals(2, sampleSizeFor(sourceWidth = 4000, sourceHeight = 200, target = target))
    }

    @Test
    fun `a source with no dimensions is not sampled`() {
        // What `BitmapFactory` reports for a file that is not an image.
        assertEquals(1, sampleSizeFor(0, 0, FeedBitmapSize(100, 100)))
        assertEquals(1, sampleSizeFor(-1, 100, FeedBitmapSize(100, 100)))
    }

    /**
     * The contrast ratio of white text over [scrimAlpha] of black over a WHITE photograph.
     *
     * The formula WCAG 2 defines: `(L1 + 0.05) / (L2 + 0.05)` over relative luminances, with
     * the composite's sRGB channel value linearised the way the spec requires. White's
     * luminance is 1.0, so the numerator is fixed and the whole thing turns on how dark the
     * scrim makes the brightest pixel the feed can hand us.
     */
    private fun whiteTextContrastOverWhite(scrimAlpha: Float): Float {
        val channel = 1f - scrimAlpha.coerceIn(0f, 1f)
        val linear = if (channel <= 0.04045f) {
            channel / 12.92f
        } else {
            Math.pow(((channel + 0.055f) / 1.055f).toDouble(), 2.4).toFloat()
        }
        return (1f + 0.05f) / (linear + 0.05f)
    }
}
