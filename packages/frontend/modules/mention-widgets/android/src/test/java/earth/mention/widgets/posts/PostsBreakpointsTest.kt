package earth.mention.widgets.posts

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The per-breakpoint design of the trending-posts card.
 *
 * These are the decisions that make the card DESIGNED PER SIZE rather than one layout
 * stretched — which design a placement gets, what each one drops, and how much text each can
 * hold. Every one of them fails invisibly: a widget that looks right at the size it was
 * developed at and runs out of room at another.
 *
 * The 1708-character post used below is the longest observed in the live explore feed.
 */
class PostsBreakpointsTest {

    private companion object {
        /** Content width inside each design at a 4-cell-wide placement. */
        const val SMALL_CONTENT_WIDTH = 250f - 12f * 2
        const val MEDIUM_CONTENT_WIDTH = 250f - 16f * 2
        const val LARGE_CONTENT_WIDTH = 320f - 16f * 2

        /**
         * The resize FLOOR the provider declares, from `dimens_posts.xml` — 4 cells wide by
         * 2 tall. The ceiling has a Kotlin constant ([POSTS_MAX_PLACEMENT]); the floor does
         * not, because nothing in the layout is measured against it.
         */
        val MIN_RESIZE_WIDTH = 250.dp
        val MIN_RESIZE_HEIGHT = 110.dp

        /** Where the medium design starts — 3 cells. */
        val MEDIUM_HEIGHT = 180.dp

        /** The longest real post, and a realistic one. */
        val LONGEST_POST = "word ".repeat(341) + "end"
        val TYPICAL_POST = "Microsoft confirms Copilot super app coming this year"
    }

    /**
     * [imageSlotHeight] with the two arguments most of these cases do not vary, so each test
     * reads as the one thing it is about.
     */
    private fun slotAt(
        design: PostsCardSize,
        widgetHeight: Dp,
        textLines: Int,
        showsRotationControls: Boolean = true,
        fontScale: Float = 1f,
    ): Dp? = imageSlotHeight(
        size = design,
        widgetHeight = widgetHeight,
        textLines = textLines,
        showsRotationControls = showsRotationControls,
        fontScale = fontScale,
    )

    // ── Which design a placement gets ───────────────────────────────────────────────

    @Test
    fun `each cell count maps to its own design`() {
        assertEquals(PostsCardSize.SMALL, postsCardSize(250.dp, 110.dp))
        assertEquals(PostsCardSize.MEDIUM, postsCardSize(250.dp, 180.dp))
        assertEquals(PostsCardSize.LARGE, postsCardSize(320.dp, 320.dp))
    }

    @Test
    fun `every design is reachable inside the provider's own resize range`() {
        // A vacuity floor: if this ever fails, the breakpoint boundaries have drifted away
        // from the range the provider allows and one design has become dead code — reachable
        // only at a size the launcher will not let the user pick.
        val reachable = listOf(
            DpSize(MIN_RESIZE_WIDTH, MIN_RESIZE_HEIGHT),
            DpSize(MIN_RESIZE_WIDTH, MEDIUM_HEIGHT),
            POSTS_MAX_PLACEMENT,
        ).map { postsCardSize(it.width, it.height) }

        assertEquals(PostsCardSize.entries.toSet(), reachable.toSet())
        assertEquals(reachable.size, reachable.toSet().size)
    }

    @Test
    fun `the large design needs the width as well as the height`() {
        // A 120dp image slot on a 250dp-wide card would leave the text a strip.
        assertEquals(PostsCardSize.MEDIUM, postsCardSize(250.dp, 320.dp))
        assertEquals(PostsCardSize.MEDIUM, postsCardSize(319.dp, 400.dp))
        assertEquals(PostsCardSize.LARGE, postsCardSize(320.dp, 320.dp))
    }

    @Test
    fun `a size no breakpoint declared still lands on a design`() {
        // A launcher is free to hand over anything inside the resize range, and something
        // outside it after a display-density change.
        assertEquals(PostsCardSize.SMALL, postsCardSize(110.dp, 110.dp))
        assertEquals(PostsCardSize.SMALL, postsCardSize(250.dp, 179.dp))
        assertEquals(PostsCardSize.MEDIUM, postsCardSize(300.dp, 200.dp))
        assertEquals(PostsCardSize.LARGE, postsCardSize(500.dp, 500.dp))
    }

    // ── What each design drops ──────────────────────────────────────────────────────

    @Test
    fun `the smallest design has no image slot at all`() {
        // 110dp of height holds a brand row, two lines and a byline. An image would have
        // about 20dp left, which is a stripe rather than a picture — and this design keeps
        // its two lines whatever the arithmetic would allow.
        assertNull(slotAt(PostsCardSize.SMALL, MIN_RESIZE_HEIGHT, textLines = 1))
        assertNull(slotAt(PostsCardSize.SMALL, 400.dp, textLines = 1))
    }

    @Test
    fun `a taller card shows more lines of text`() {
        assertTrue(textMaxLines(PostsCardSize.SMALL) < textMaxLines(PostsCardSize.MEDIUM))
        assertTrue(textMaxLines(PostsCardSize.MEDIUM) < textMaxLines(PostsCardSize.LARGE))
        // Two is the floor worth drawing: one line of a post is a fragment.
        assertTrue(textMaxLines(PostsCardSize.SMALL) >= 2)
    }

    @Test
    fun `the image slot spans the content width, inside the design's own padding`() {
        assertEquals(
            (250f - 16f * 2).dp,
            imageSlotWidth(PostsCardSize.MEDIUM, 250.dp),
        )
        // The small design pads tighter, so at the same card width its content is wider —
        // which is exactly why the padding is read from the design and not from a constant.
        assertEquals(
            (250f - 12f * 2).dp,
            imageSlotWidth(PostsCardSize.SMALL, 250.dp),
        )
    }

    // ── The picture's height, derived ───────────────────────────────────────────────

    @Test
    fun `the picture takes the height the rest of the card does not need`() {
        // The whole point of the change: the slot is the leftover, so the parts above and
        // below it plus the slot itself account for the whole widget with nothing spare.
        val height = 325.dp
        val slot = requireNotNull(slotAt(PostsCardSize.LARGE, height, textLines = 2))
        val reserved = cardHeightWithoutImage(
            size = PostsCardSize.LARGE,
            textLines = 2,
            showsRotationControls = true,
            fontScale = 1f,
        )

        assertEquals(height.value, (reserved + slot).value, 0.01f)
    }

    @Test
    fun `a taller placement is a taller picture, dp for dp`() {
        // What `SizeMode.Responsive` could not do: every dp the launcher hands over reaches
        // the photograph instead of being quantised away at the nearest declared bucket.
        val short = requireNotNull(slotAt(PostsCardSize.LARGE, 325.dp, textLines = 2))
        val tall = requireNotNull(slotAt(PostsCardSize.LARGE, 425.dp, textLines = 2))

        assertEquals(100f, (tall - short).value, 0.01f)
    }

    @Test
    fun `a short post gets a bigger picture than a long one`() {
        // The empty space this change exists to spend: a one-line post used to leave the room
        // its unused lines would have taken sitting blank above the byline.
        val oneLine = requireNotNull(slotAt(PostsCardSize.LARGE, 400.dp, textLines = 1))
        val fiveLines = requireNotNull(slotAt(PostsCardSize.LARGE, 400.dp, textLines = 5))

        assertTrue("one line: $oneLine, five: $fiveLines", oneLine > fiveLines)
        // …and a post with no words at all gets the most of any.
        val noText = requireNotNull(slotAt(PostsCardSize.LARGE, 400.dp, textLines = 0))
        assertTrue("no text: $noText, one line: $oneLine", noText > oneLine)
    }

    @Test
    fun `the fixed band this replaced is beaten wherever the card had room for it`() {
        // The band was 72dp at the medium design and 120dp at the large one. The derivation
        // has to be worth having, not merely different: at a placement that could hold the
        // old band, it now holds at least as much picture.
        assertTrue(
            requireNotNull(slotAt(PostsCardSize.LARGE, 325.dp, textLines = 2)) >= 120.dp,
        )
        assertTrue(
            requireNotNull(slotAt(PostsCardSize.MEDIUM, 290.dp, textLines = 2)) >= 72.dp,
        )
    }

    @Test
    fun `a card with no room for a picture shows none, rather than a sliver`() {
        // Below twice the corner radius the two curves meet and the slot has no straight edge
        // left. A 4×2 placement at the medium design's text is exactly that case.
        assertNull(slotAt(PostsCardSize.MEDIUM, 213.dp, textLines = 2))

        // The boundary itself is inclusive, and one dp below it is not.
        val reserved = cardHeightWithoutImage(
            size = PostsCardSize.MEDIUM,
            textLines = 2,
            showsRotationControls = true,
            fontScale = 1f,
        )
        val floor = PostsCardDimensions.MIN_IMAGE_HEIGHT
        assertEquals(floor, slotAt(PostsCardSize.MEDIUM, reserved + floor, textLines = 2))
        assertNull(slotAt(PostsCardSize.MEDIUM, reserved + floor - 1.dp, textLines = 2))
    }

    @Test
    fun `the picture never takes room the rotation controls need`() {
        // The row is 48dp and the launcher clips rather than shrinks, so a slot that ignored
        // it would push the controls off the bottom of the card.
        val withControls = requireNotNull(
            slotAt(PostsCardSize.LARGE, 400.dp, textLines = 2, showsRotationControls = true),
        )
        val without = requireNotNull(
            slotAt(PostsCardSize.LARGE, 400.dp, textLines = 2, showsRotationControls = false),
        )

        assertEquals(PostsCardDimensions.CONTROL_SIZE, without - withControls)
    }

    @Test
    fun `a larger font setting takes its height from the picture, not from the card`() {
        val standard = requireNotNull(slotAt(PostsCardSize.LARGE, 400.dp, textLines = 3))
        val large = requireNotNull(
            slotAt(PostsCardSize.LARGE, 400.dp, textLines = 3, fontScale = 1.3f),
        )

        assertTrue("standard: $standard, at 1.3: $large", large < standard)
        // At the largest scale Android offers, a full five-line post on a real 325dp placement
        // leaves nothing — the words win, and the card shows no picture rather than clipping.
        assertNull(slotAt(PostsCardSize.LARGE, 325.dp, textLines = 5, fontScale = 2f))
    }

    @Test
    fun `the reservation matches the card measured on a real launcher`() {
        // Calibration, and the only assertion here with an outside witness: a 387 × 325dp
        // placement of the shipped card, dumped from the launcher's own view tree, drew a 20dp
        // brand row, an 8dp gap, 50.7dp of two-line text, an 8dp gap, a 120dp picture, an 8dp
        // gap, a 28dp byline and a 48dp control row inside 16dp of padding. That is 202.7dp of
        // everything-but-the-picture, and the reservation must sit just above it — above,
        // because the text estimate rounds up, and only just, or the picture pays for slack
        // that was never needed.
        val measuredWithoutPicture = 20f + 8f + 50.7f + 8f + 8f + 28f + 48f + 16f * 2
        val reserved = cardHeightWithoutImage(
            size = PostsCardSize.LARGE,
            textLines = 2,
            showsRotationControls = true,
            fontScale = 1f,
        ).value

        assertEquals(202.7f, measuredWithoutPicture, 0.01f)
        assertTrue(
            "reserved ${reserved}dp, measured ${measuredWithoutPicture}dp",
            reserved >= measuredWithoutPicture,
        )
        assertTrue(
            "reserved ${reserved}dp leaves more than a gap's worth of slack",
            reserved <= measuredWithoutPicture + PostsCardDimensions.BLOCK_SPACING.value,
        )
    }

    // ── Lines of text the card commits to ──────────────────────────────────────────

    @Test
    fun `the line count is what the text needs, bounded by the design`() {
        val perLine = MEDIUM_CONTENT_WIDTH / (17f * 0.6f)

        assertEquals(0, textLinesFor(PostsCardSize.MEDIUM, 0, MEDIUM_CONTENT_WIDTH, 1f))
        assertEquals(1, textLinesFor(PostsCardSize.MEDIUM, 1, MEDIUM_CONTENT_WIDTH, 1f))
        assertEquals(
            2,
            textLinesFor(PostsCardSize.MEDIUM, perLine.toInt() + 1, MEDIUM_CONTENT_WIDTH, 1f),
        )
        // Never more than the design draws: the `Text` is given this as its own `maxLines`.
        assertEquals(
            textMaxLines(PostsCardSize.MEDIUM),
            textLinesFor(PostsCardSize.MEDIUM, 10_000, MEDIUM_CONTENT_WIDTH, 1f),
        )
    }

    @Test
    fun `the line count errs towards more lines than the text needs`() {
        // The direction that costs the picture a few dp rather than clipping the card. The
        // measured card fitted 71 characters of 20sp text on two lines at this width; the
        // estimate must not claim fewer lines than that.
        val estimated = textLinesFor(PostsCardSize.LARGE, 71, 355.3f, 1f)

        assertTrue("estimated $estimated lines for a post that really took 2", estimated >= 2)
    }

    @Test
    fun `a degenerate width yields no lines rather than an exception`() {
        assertEquals(0, textLinesFor(PostsCardSize.MEDIUM, 100, 0f, 1f))
        assertEquals(0, textLinesFor(PostsCardSize.MEDIUM, 100, -10f, 1f))
    }

    // ── The rotation controls ───────────────────────────────────────────────────────

    @Test
    fun `the controls are drawn exactly where their height is reserved`() {
        // One predicate for both, because a card that reserves the row without drawing it
        // leaves a gap and one that draws it without reserving it loses the row to a clip.
        assertTrue(showsRotationControls(PostsCardSize.MEDIUM, rotationLength = 5))
        assertTrue(showsRotationControls(PostsCardSize.LARGE, rotationLength = 2))
        // Nowhere to step to.
        assertFalse(showsRotationControls(PostsCardSize.LARGE, rotationLength = 1))
        assertFalse(showsRotationControls(PostsCardSize.LARGE, rotationLength = 0))
        // No room for a 48dp row; that design keeps its pips in the byline instead.
        assertFalse(showsRotationControls(PostsCardSize.SMALL, rotationLength = 5))
    }

    // ── The text budget ─────────────────────────────────────────────────────────────

    @Test
    fun `a bigger card holds more text than a smaller one`() {
        val small = textBudgetChars(PostsCardSize.SMALL, SMALL_CONTENT_WIDTH, 1f)
        val medium = textBudgetChars(PostsCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 1f)
        val large = textBudgetChars(PostsCardSize.LARGE, LARGE_CONTENT_WIDTH, 1f)

        assertTrue("the small card must hold the least: $small", small < medium)
        assertTrue("the large card must hold the most: $large", medium < large)
        // A vacuity floor. Every budget is a product of several factors, so a zero anywhere
        // in the chain would otherwise pass every ordering assertion above.
        assertTrue("a budget of $small characters is not a design", small >= 20)
    }

    @Test
    fun `a larger font setting shrinks the budget`() {
        val standard = textBudgetChars(PostsCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 1f)
        val large = textBudgetChars(PostsCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 1.3f)
        val largest = textBudgetChars(PostsCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 2f)

        // Left out, a card at a 1.3 scale hands its TextView a third more text than fits.
        assertTrue(large < standard)
        assertTrue(largest < large)
    }

    @Test
    fun `a degenerate width or font scale yields no budget rather than an exception`() {
        assertEquals(0, textBudgetChars(PostsCardSize.MEDIUM, 0f, 1f))
        assertEquals(0, textBudgetChars(PostsCardSize.MEDIUM, -10f, 1f))
        // A zero font scale would divide by zero; it is treated as the default instead.
        assertTrue(textBudgetChars(PostsCardSize.MEDIUM, MEDIUM_CONTENT_WIDTH, 0f) > 0)
    }

    @Test
    fun `the stored text cap is the largest budget any design can reach`() {
        // Derived from the breakpoint table rather than written down, so it cannot fall out
        // of step with it — a store holding less than a card can draw would truncate text
        // that had room on screen.
        assertEquals(LARGEST_TEXT_BUDGET_CHARS, MAX_STORED_TEXT_CHARS)
        assertEquals(
            LARGEST_TEXT_BUDGET_CHARS,
            textBudgetChars(PostsCardSize.LARGE, LARGE_CONTENT_WIDTH, 0.85f),
        )

        // …and it really is the largest: no design at any supported font scale exceeds it.
        PostsCardSize.entries.forEach { design ->
            listOf(0.85f, 1f, 1.3f, 2f).forEach { scale ->
                val budget = textBudgetChars(design, LARGE_CONTENT_WIDTH, scale)
                assertTrue(
                    "$design at scale $scale wants $budget characters, more than the store keeps",
                    budget <= MAX_STORED_TEXT_CHARS,
                )
            }
        }
    }

    // ── Truncation ──────────────────────────────────────────────────────────────────

    @Test
    fun `the longest real post is truncated for every design`() {
        assertEquals(1708, LONGEST_POST.length)

        PostsCardSize.entries.forEach { design ->
            val budget = textBudgetChars(design, MEDIUM_CONTENT_WIDTH, 1f)
            val drawn = truncateToBudget(LONGEST_POST, budget)

            assertTrue("$design drew ${drawn.length} of a $budget budget", drawn.length <= budget)
            assertTrue("$design must show it was cut", drawn.endsWith("…"))
            assertTrue("$design must still show something", drawn.length > 1)
        }
    }

    @Test
    fun `text that fits is left exactly as it is`() {
        val budget = textBudgetChars(PostsCardSize.LARGE, LARGE_CONTENT_WIDTH, 1f)

        // No card carries an ellipsis it did not earn.
        assertEquals(TYPICAL_POST, truncateToBudget(TYPICAL_POST, budget))
        assertEquals("short", truncateToBudget("short", 5))
    }

    @Test
    fun `truncation prefers a word boundary`() {
        assertEquals("hello world…", truncateToBudget("hello world again", 13))
    }

    @Test
    fun `a single long token is cut mid-word rather than back to nothing`() {
        // A URL or a compound would otherwise pull the cut back past almost all of the
        // budget, leaving a card with two words on it.
        val oneToken = "a".repeat(50)
        assertEquals("${"a".repeat(9)}…", truncateToBudget(oneToken, 10))

        val shortHeadThenToken = "ab " + "c".repeat(30)
        val drawn = truncateToBudget(shortHeadThenToken, 20)
        assertEquals(20, drawn.length)
        assertTrue("the cut must not fall back to the first word: $drawn", drawn.contains("ccc"))
    }

    @Test
    fun `a budget of nothing draws nothing`() {
        assertEquals("", truncateToBudget(TYPICAL_POST, 0))
        assertEquals("", truncateToBudget(TYPICAL_POST, -1))
        // One character of budget cannot hold both content and the mark that says it was cut.
        assertEquals("…", truncateToBudget(TYPICAL_POST, 1))
    }

    @Test
    fun `empty text stays empty`() {
        // A post whose whole body was a bare URL with an image. The card draws the picture.
        assertEquals("", truncateToBudget("", 50))
    }
}
