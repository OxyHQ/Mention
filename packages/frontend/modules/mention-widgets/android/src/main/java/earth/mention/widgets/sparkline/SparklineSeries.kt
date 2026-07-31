package earth.mention.widgets.sparkline

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * The sparkline's ARITHMETIC — everything about the chart that can be decided
 * without a `Canvas`, a `Context` or a composition.
 *
 * It is a separate file from [SparklineRenderer] for one reason: every rule in
 * here is a rule that can be wrong, so all of it is unit-testable on a plain JVM.
 * The renderer that consumes it is three calls to `android.graphics`, which is a
 * stub outside a device.
 *
 * The series itself comes from `GET /trending`'s per-trend `series` field, which
 * is a downsampled run of REAL observed volumes, oldest first
 * (packages/backend/src/services/trending/trendSeries.ts). That file's first rule
 * — nothing is ever synthesized — is inherited here: this code may drop a series
 * it cannot draw honestly, but it never invents, pads or interpolates a point.
 */

/**
 * Fewest points that can be drawn.
 *
 * Two, because two points is one straight segment and that is still a real
 * measurement of a rise or a fall. One point has no shape at all, and the server
 * would have to have sent a single-element array for it to arrive — its own floor
 * is six (`MtnConfig.trending.series.minPoints`), so this is a bound on a
 * malformed body rather than on the contract.
 */
internal const val MIN_SPARKLINE_POINTS = 2

/**
 * Most points that are kept, counted from the NEWEST end.
 *
 * The server sends twelve today (`MtnConfig.trending.series.maxPoints`). This is
 * double that, so raising the server's number does not need a matching change
 * here, while a body that arrived with hundreds of points cannot turn a widget
 * composition into an unbounded loop. When it bites, the OLDEST points are the
 * ones dropped: a chart on a home screen is about now.
 */
internal const val MAX_SPARKLINE_POINTS = 24

/**
 * Below this span the series is treated as FLAT.
 *
 * Not `0f`, and this is the case that actually occurs: `ai` currently ships
 * `[4,4,4,4,4,4,4,4,4,4,4,4]`. Comparing to exactly zero would be worse than
 * useless here — it would leave a series whose points differ by float noise
 * (`4.0` against `4.0000001`) to be normalised by dividing by that noise, which
 * amplifies a difference of nothing into a full-height spike.
 *
 * The value is half the smallest difference the server can report: its points are
 * post counts rounded to one decimal, so two of them differ by at least 0.1 or
 * not at all. Anything under 0.05 is therefore arithmetic, not a measurement.
 */
private const val FLAT_SPARKLINE_SPAN = 0.05f

/**
 * Where a flat series is drawn: the middle.
 *
 * A centred straight line is the honest picture of a volume that has not moved.
 * The alternatives are both lies — pinning it to the bottom reads as "nothing is
 * happening here", pinning it to the top as a peak.
 */
private const val FLAT_SPARKLINE_LEVEL = 0.5f

/** Stroke the chart's line is drawn with, in dp of the FINAL rendered size. */
internal val SPARKLINE_STROKE_WIDTH = 2.dp

/**
 * Pixels the bitmap holds per dp of the space it will occupy.
 *
 * ONE, and deliberately not the device's density. The launcher scales the bitmap
 * up to the real pixel size, and what is being scaled is a smooth curve at low
 * opacity with no text in it — the only visible consequence is that the line's
 * edge softens, which for a background watermark is invisible at arm's length.
 *
 * What it buys is a payload that can be computed from the declared breakpoints
 * before anything is built: a chart behind a 250 × 110dp widget is
 * `250 × 50 × 4` bytes, not `750 × 150 × 4`. That matters because
 * `SizeMode.Responsive` puts EVERY declared size's bitmap into the one
 * `RemoteViews` the launcher receives, and a `RemoteViews` that overruns the
 * platform's bitmap-memory allowance is not a slow widget, it is a blank one.
 *
 * [SPARKLINE_STROKE_WIDTH] is applied in these same units, so the stroke lands at
 * its dp width on screen after the launcher's scale-up.
 */
internal const val SPARKLINE_PIXELS_PER_DP = 1f

/**
 * Hard ceiling on one chart bitmap, in pixels.
 *
 * At [SPARKLINE_PIXELS_PER_DP] none of the declared breakpoints comes close (the
 * largest is 320 × 120 = 38,400). It exists for the size a launcher is free to
 * hand over that no breakpoint declared: without it, an absurd one would size the
 * allocation, and a widget cannot afford to be the reason a launcher runs out of
 * memory. 60,000 pixels is 240KB at ARGB_8888.
 */
private const val MAX_SPARKLINE_PIXELS = 60_000L

/** A bitmap needs at least this many pixels on an edge to hold a stroked line. */
private const val MIN_SPARKLINE_EDGE_PX = 2

/**
 * Fraction of the widget's height the chart occupies, measured from the bottom.
 *
 * The chart is a band along the bottom edge, not a full-height backdrop, and that
 * is a legibility decision before it is a payload one: the widget's text lives in
 * the upper two thirds, so keeping the chart out of it means the two never
 * compete. It halves the bitmap as a side effect.
 */
private const val SPARKLINE_BAND_FRACTION = 0.45f

/** Below this the band is too thin for a curve to have any shape. */
private val SPARKLINE_BAND_MIN_HEIGHT = 40.dp

/**
 * Above this the band stops growing with the widget.
 *
 * A 320dp-tall widget does not want 144dp of chart — past this the band stops
 * reading as a footer band and starts reading as a full backdrop behind the
 * content.
 */
private val SPARKLINE_BAND_MAX_HEIGHT = 120.dp

/** One point of the chart's polyline, in bitmap pixels. */
internal data class SparklinePoint(val x: Float, val y: Float)

/** The bitmap to allocate for one chart. */
internal data class SparklineBitmapSize(val widthPx: Int, val heightPx: Int)

/**
 * The series as it is worth storing and drawing, or EMPTY when there is nothing
 * honest to draw.
 *
 * Applied once, at the boundary where a series enters the widget (parsing a
 * response, and reading the store back), so everything downstream can treat
 * `WidgetTrend.series` as "drawable or absent" with no second opinion about it.
 *
 * A series containing a single unusable value — a negative count, a NaN, a
 * non-numeric element — is dropped WHOLE rather than having that point removed.
 * Removing one point silently changes the spacing of every point after it, which
 * would draw a shape the server never measured; and a body that malformed is not
 * one to trust the rest of.
 */
internal fun sanitizeSparklineSeries(values: List<Float>): List<Float> {
    if (values.size < MIN_SPARKLINE_POINTS) return emptyList()
    if (values.any { !it.isFinite() || it < 0f }) return emptyList()
    return if (values.size <= MAX_SPARKLINE_POINTS) values else values.takeLast(MAX_SPARKLINE_POINTS)
}

/**
 * Map a series onto `0f..1f`, where `1f` is its highest point.
 *
 * The normalisation is min-to-max rather than zero-to-max on purpose: a sparkline
 * is read for its SHAPE, and a series that moved between 17 and 20 posts has no
 * visible shape at all when drawn against a zero baseline.
 *
 * A flat series — [FLAT_SPARKLINE_SPAN] — is the case this function exists to get
 * right, because it is the one that occurs: dividing by that span is a division by
 * zero, and the naive result is a line of `NaN`s that draws as nothing at all
 * while looking, in code, exactly like a chart. It returns a centred straight line
 * instead; see [FLAT_SPARKLINE_LEVEL].
 */
internal fun normalizeSparklineSeries(values: List<Float>): List<Float> {
    if (values.size < MIN_SPARKLINE_POINTS) return emptyList()

    val min = values.min()
    val max = values.max()
    if (max - min <= FLAT_SPARKLINE_SPAN) return List(values.size) { FLAT_SPARKLINE_LEVEL }

    val span = max - min
    return values.map { (it - min) / span }
}

/**
 * Turn a normalised series into the polyline to stroke.
 *
 * Horizontally the chart bleeds edge to edge — it is a background, and an inset
 * one would read as a chart someone forgot to finish. Vertically it is inset by
 * [insetPx] at both ends so a stroke centred on the highest or lowest point is
 * not sliced in half by the bitmap's edge.
 *
 * Returns EMPTY for anything it cannot lay out (too few points, a degenerate
 * bitmap) rather than throwing: the caller is a widget composition the launcher is
 * waiting on, and the correct outcome there is no chart, never a crash.
 */
internal fun sparklinePoints(
    normalized: List<Float>,
    widthPx: Int,
    heightPx: Int,
    insetPx: Float,
): List<SparklinePoint> {
    if (normalized.size < MIN_SPARKLINE_POINTS) return emptyList()
    if (widthPx < MIN_SPARKLINE_EDGE_PX || heightPx < MIN_SPARKLINE_EDGE_PX) return emptyList()

    // An inset wider than half the band would put the top below the bottom.
    val inset = insetPx.coerceIn(0f, heightPx / 2f)
    val top = inset
    val bottom = heightPx - inset
    val usableHeight = bottom - top
    val step = widthPx.toFloat() / (normalized.size - 1)

    return normalized.mapIndexed { index, value ->
        SparklinePoint(x = index * step, y = bottom - value * usableHeight)
    }
}

/**
 * How tall the chart's band is behind a widget of this height.
 *
 * Clamped at both ends, and never taller than the widget itself — a launcher may
 * hand over a height smaller than any declared breakpoint, and a band taller than
 * its own widget would push the content out of the box.
 */
internal fun sparklineBandHeight(widgetHeight: Dp): Dp =
    (widgetHeight * SPARKLINE_BAND_FRACTION)
        .coerceIn(SPARKLINE_BAND_MIN_HEIGHT, SPARKLINE_BAND_MAX_HEIGHT)
        .coerceAtMost(widgetHeight)

/**
 * The bitmap to allocate for a chart that will be displayed at `width × height`,
 * or `null` when that space is too small to draw in.
 *
 * Both axes are scaled by the same factor when the pixel ceiling bites, so the
 * bitmap always matches the aspect of the space it is stretched into and the curve
 * is never distorted.
 */
internal fun sparklineBitmapSize(width: Dp, height: Dp): SparklineBitmapSize? {
    val widthPx = (width.value * SPARKLINE_PIXELS_PER_DP).roundToInt()
    val heightPx = (height.value * SPARKLINE_PIXELS_PER_DP).roundToInt()
    if (widthPx < MIN_SPARKLINE_EDGE_PX || heightPx < MIN_SPARKLINE_EDGE_PX) return null

    val pixels = widthPx.toLong() * heightPx.toLong()
    if (pixels <= MAX_SPARKLINE_PIXELS) return SparklineBitmapSize(widthPx, heightPx)

    // Truncated, not rounded, and that is the difference between a ceiling and a
    // suggestion: rounding both axes UP can take the product back over the limit
    // this branch exists to enforce (4000 × 4000 scales to 244.95 on each axis,
    // which rounds to 245 × 245 = 60,025).
    val scale = sqrt(MAX_SPARKLINE_PIXELS.toDouble() / pixels.toDouble()).toFloat()
    return SparklineBitmapSize(
        widthPx = (widthPx * scale).toInt().coerceAtLeast(MIN_SPARKLINE_EDGE_PX),
        heightPx = (heightPx * scale).toInt().coerceAtLeast(MIN_SPARKLINE_EDGE_PX),
    )
}
