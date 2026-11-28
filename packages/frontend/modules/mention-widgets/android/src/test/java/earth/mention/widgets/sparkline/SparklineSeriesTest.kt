package earth.mention.widgets.sparkline

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The sparkline's arithmetic.
 *
 * Nothing here draws anything — a `Canvas` is a stub off-device. What is pinned is
 * every decision the renderer makes BEFORE it draws, because each one of them has a
 * failure mode that looks like a working chart in code and like a broken widget on a
 * home screen.
 *
 * The series used below are the real ones `GET /trending` serves (checked against
 * production on 2026-07-29), so a change that breaks the live data breaks these.
 */
class SparklineSeriesTest {

    private companion object {
        /** `business`: a real falling series. */
        val FALLING = listOf(19f, 19f, 19f, 19f, 19f, 19f, 18f, 17.3f, 16f, 14.3f, 12.3f, 11f)

        /** `tech`: a real spike. */
        val SPIKE = listOf(3f, 3f, 3f, 3.6f, 14.4f, 25.2f, 24.8f, 20.4f, 13.2f, 12f, 8.6f, 5.5f)

        /** `ai`: perfectly flat, and the case that actually occurs. */
        val FLAT = List(12) { 4f }
    }

    @Test
    fun `a flat series is drawn as a centred straight line`() {
        val normalized = normalizeSparklineSeries(FLAT)

        assertEquals(FLAT.size, normalized.size)
        normalized.forEach { value ->
            // Not 0f, not 1f, and above all not NaN: dividing by a zero span is what
            // this case exists to prevent, and a NaN polyline draws nothing at all
            // while looking, in code, exactly like a chart.
            assertEquals(0.5f, value, 0f)
        }
    }

    @Test
    fun `a series flat to within the servers own precision is still flat`() {
        // The server rounds each point to a tenth, so two points differ by at least
        // 0.1 or not at all. Anything under that is float noise, and normalising by
        // it would amplify nothing into a full-height spike.
        val noisy = listOf(4f, 4.0000001f, 4f, 3.99999f)

        normalizeSparklineSeries(noisy).forEach { assertEquals(0.5f, it, 0f) }
    }

    @Test
    fun `normalisation puts the lowest point at the floor and the highest at the ceiling`() {
        val normalized = normalizeSparklineSeries(SPIKE)

        assertEquals(0f, normalized.min(), 0f)
        assertEquals(1f, normalized.max(), 0f)
        // The spike is at index 5 (25.2, the maximum) and the floor at 0..2 (3.0).
        assertEquals(1f, normalized[5], 0f)
        assertEquals(0f, normalized[0], 0f)
    }

    @Test
    fun `normalisation keeps the shape monotonic where the data is`() {
        val normalized = normalizeSparklineSeries(FALLING)

        // `business` never rises, so neither may its chart.
        normalized.zipWithNext().forEach { (earlier, later) ->
            assertTrue("$earlier then $later rises where the data falls", later <= earlier)
        }
    }

    @Test
    fun `a series too short to have a shape is not normalised`() {
        assertEquals(emptyList<Float>(), normalizeSparklineSeries(listOf(4f)))
        assertEquals(emptyList<Float>(), normalizeSparklineSeries(emptyList()))
    }

    @Test
    fun `sanitising keeps a real series unchanged`() {
        assertEquals(SPIKE, sanitizeSparklineSeries(SPIKE))
        assertEquals(FLAT, sanitizeSparklineSeries(FLAT))
    }

    @Test
    fun `one unusable value drops the whole series`() {
        // Dropping just the bad point would change the spacing of every point after
        // it, drawing a shape the server never measured.
        assertEquals(emptyList<Float>(), sanitizeSparklineSeries(listOf(1f, Float.NaN, 3f)))
        assertEquals(emptyList<Float>(), sanitizeSparklineSeries(listOf(1f, Float.POSITIVE_INFINITY, 3f)))
        assertEquals(emptyList<Float>(), sanitizeSparklineSeries(listOf(1f, -2f, 3f)))
    }

    @Test
    fun `sanitising keeps the newest points when a series is too long`() {
        val long = List(MAX_SPARKLINE_POINTS * 2) { it.toFloat() }

        val kept = sanitizeSparklineSeries(long)

        assertEquals(MAX_SPARKLINE_POINTS, kept.size)
        // Oldest-first on the wire, so the tail is the recent half — a chart on a
        // home screen is about now.
        assertEquals(long.last(), kept.last())
        assertEquals(long[MAX_SPARKLINE_POINTS], kept.first())
    }

    @Test
    fun `a single point is not a series`() {
        assertEquals(emptyList<Float>(), sanitizeSparklineSeries(listOf(4f)))
    }

    @Test
    fun `points span the full width and are evenly spaced`() {
        val points = sparklinePoints(normalizeSparklineSeries(SPIKE), widthPx = 240, heightPx = 60, insetPx = 1f)

        assertEquals(SPIKE.size, points.size)
        assertEquals(0f, points.first().x, 0f)
        assertEquals(240f, points.last().x, 0.001f)
        val step = points[1].x - points[0].x
        points.zipWithNext().forEach { (a, b) ->
            assertEquals(step, b.x - a.x, 0.001f)
        }
    }

    @Test
    fun `the stroke is kept inside the bitmap at both extremes`() {
        val inset = 2f
        val points = sparklinePoints(normalizeSparklineSeries(SPIKE), widthPx = 240, heightPx = 60, insetPx = inset)

        // The peak sits half a stroke below the top edge and the trough half a
        // stroke above the bottom, so neither is sliced off.
        assertEquals(inset, points.minOf { it.y }, 0.001f)
        assertEquals(60f - inset, points.maxOf { it.y }, 0.001f)
    }

    @Test
    fun `a flat series is laid out along the middle of the band`() {
        val points = sparklinePoints(normalizeSparklineSeries(FLAT), widthPx = 240, heightPx = 60, insetPx = 1f)

        assertEquals(FLAT.size, points.size)
        points.forEach { assertEquals(30f, it.y, 0.001f) }
    }

    @Test
    fun `an inset deeper than the band does not invert it`() {
        val points = sparklinePoints(normalizeSparklineSeries(SPIKE), widthPx = 100, heightPx = 4, insetPx = 40f)

        // Clamped to half the height: every point collapses onto the centre line
        // rather than the top ending up below the bottom.
        points.forEach { assertEquals(2f, it.y, 0.001f) }
    }

    @Test
    fun `a bitmap too small to draw in yields no points`() {
        assertEquals(
            emptyList<SparklinePoint>(),
            sparklinePoints(normalizeSparklineSeries(SPIKE), widthPx = 1, heightPx = 1, insetPx = 1f),
        )
    }

    @Test
    fun `the band is a fraction of the widget, clamped at both ends`() {
        // 250 × 110 (4×2): 45% of 110 is inside the clamp.
        assertEquals(49.5f, sparklineBandHeight(110.dp).value, 0.001f)
        // 320 tall: 45% would be 144, over the ceiling.
        assertEquals(120f, sparklineBandHeight(320.dp).value, 0.001f)
        // Very short: 45% would be under the floor.
        assertEquals(40f, sparklineBandHeight(60.dp).value, 0.001f)
        // …but never taller than the widget it is drawn in.
        assertEquals(20f, sparklineBandHeight(20.dp).value, 0.001f)
    }

    @Test
    fun `a bitmap is one pixel per dp of the band it fills`() {
        // The payload has to be computable from the breakpoints before anything is
        // built, because every declared size's bitmap rides in the SAME RemoteViews.
        // These are the ranked list's five declared sizes and the chart each one gets.
        val expected = mapOf(
            (110 to 110) to (110 to 50),
            (250 to 110) to (250 to 50),
            (250 to 180) to (250 to 81),
            (250 to 250) to (250 to 113),
            (320 to 320) to (320 to 120),
        )

        expected.forEach { (widget, bitmap) ->
            val (widthDp, heightDp) = widget
            val size = sparklineBitmapSize(widthDp.dp, sparklineBandHeight(heightDp.dp))

            assertNotNull("no bitmap for $widthDp × $heightDp", size)
            checkNotNull(size)
            assertEquals("width for $widthDp × $heightDp", bitmap.first, size.widthPx)
            assertEquals("height for $widthDp × $heightDp", bitmap.second, size.heightPx)
        }
    }

    @Test
    fun `all five of the ranked lists charts together stay under half a megabyte`() {
        // Worst case for one widget update: SizeMode.Responsive composes every
        // declared size into one RemoteViews, so this is the number that has to be
        // survivable, not the largest single bitmap.
        val bytes = listOf(110 to 110, 250 to 110, 250 to 180, 250 to 250, 320 to 320)
            .sumOf { (widthDp, heightDp) ->
                val size = checkNotNull(sparklineBitmapSize(widthDp.dp, sparklineBandHeight(heightDp.dp)))
                size.widthPx.toLong() * size.heightPx.toLong() * Int.SIZE_BYTES
            }

        assertEquals(419_600L, bytes)
        assertTrue("$bytes bytes across five breakpoints", bytes < 512_000L)
    }

    @Test
    fun `the largest declared chart stays well under a quarter of a megabyte`() {
        val size = checkNotNull(sparklineBitmapSize(320.dp, sparklineBandHeight(320.dp)))

        val bytes = size.widthPx * size.heightPx * Int.SIZE_BYTES
        assertEquals(320 * 120 * 4, bytes)
        assertTrue("$bytes bytes", bytes < 200_000)
    }

    @Test
    fun `an absurd size is capped instead of allocated`() {
        val size = checkNotNull(sparklineBitmapSize(4000.dp, 4000.dp))

        assertTrue(
            "${size.widthPx} × ${size.heightPx}",
            size.widthPx.toLong() * size.heightPx.toLong() <= 60_000L,
        )
        // Square in, square out: the curve is stretched into its box, so a capped
        // bitmap that changed the aspect would distort it.
        assertEquals(size.widthPx, size.heightPx)
    }

    @Test
    fun `a space too small to draw in has no bitmap`() {
        assertNull(sparklineBitmapSize(1.dp, 40.dp))
        assertNull(sparklineBitmapSize(250.dp, 1.dp))
    }
}
