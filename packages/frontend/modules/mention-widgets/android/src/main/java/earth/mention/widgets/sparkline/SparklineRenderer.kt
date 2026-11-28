package earth.mention.widgets.sparkline

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import kotlin.math.roundToInt

/**
 * Draws the sparkline into a [Bitmap].
 *
 * A bitmap because there is no other option: Glance emits `RemoteViews`, and
 * `RemoteViews` can position views and set their properties but cannot draw. There
 * is no canvas, no path, no vector composable and no `Brush` on this surface, so a
 * chart is either raster or it is faked out of stacked coloured `Box`es — and a
 * chart faked from boxes is a bar chart pretending to be a line.
 *
 * Everything that decides WHAT is drawn lives in `SparklineSeries.kt` and is unit
 * tested. This file is the three `android.graphics` calls that put it on a surface,
 * and it holds no rule of its own beyond how the two paints are weighted.
 */
internal object SparklineRenderer {

    /** Opaque. */
    private const val MAX_ALPHA = 255

    /**
     * How present the line and its fill are.
     *
     * Text is drawn ON TOP of this chart, so the numbers are set by legibility
     * rather than by taste: the line is the part that carries the shape and gets
     * enough opacity to be followed, the fill only has to say which side of the
     * line is "under" it.
     *
     * The alpha is baked into each `Paint` rather than applied to the composed
     * `Image`. That is not a workaround for Glance 1.1.1 having no `alpha` on
     * `Image` — it is the only way to weight the two differently at all, since an
     * image-level alpha would scale both by one factor and flatten the very
     * contrast this pair exists to create.
     */
    private const val LINE_OPACITY = 0.55f
    private const val FILL_OPACITY = 0.16f

    /**
     * Render [series] at [size], in [color].
     *
     * Returns `null` when there is nothing to draw — a series the normalisation
     * rejects. The caller composes no image at all in that case, which is the
     * documented behaviour for a trend the server sent no series for.
     *
     * [series] is expected to have been through [sanitizeSparklineSeries] already
     * (every series reaching a widget has, at the parse boundary); this only
     * guards the shapes [normalizeSparklineSeries] itself cannot map.
     */
    fun render(series: List<Float>, size: SparklineBitmapSize, color: Int): Bitmap? {
        val normalized = normalizeSparklineSeries(series)
        if (normalized.isEmpty()) return null

        val strokeWidthPx = SPARKLINE_STROKE_WIDTH.value * SPARKLINE_PIXELS_PER_DP
        val points = sparklinePoints(
            normalized = normalized,
            widthPx = size.widthPx,
            heightPx = size.heightPx,
            // Half a stroke: the line is centred on its point, so this is exactly
            // the overhang that would otherwise be clipped at the band's edges.
            insetPx = strokeWidthPx / 2f,
        )
        if (points.isEmpty()) return null

        val line = Path().apply {
            moveTo(points.first().x, points.first().y)
            points.drop(1).forEach { lineTo(it.x, it.y) }
        }
        // The same polyline, closed down to the bottom edge — the area under the
        // curve. Taken from the line rather than built alongside it so the two can
        // never disagree about where a point was.
        val area = Path(line).apply {
            lineTo(points.last().x, size.heightPx.toFloat())
            lineTo(points.first().x, size.heightPx.toFloat())
            close()
        }

        val bitmap = Bitmap.createBitmap(size.widthPx, size.heightPx, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawPath(area, fillPaint(color))
        canvas.drawPath(line, linePaint(color, strokeWidthPx))
        return bitmap
    }

    private fun fillPaint(color: Int) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        this.color = color.withOpacity(FILL_OPACITY)
    }

    private fun linePaint(color: Int, strokeWidthPx: Float) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = strokeWidthPx
        // A volume series turns corners at every point; mitred joins would put a
        // spike on each one at this stroke width.
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
        this.color = color.withOpacity(LINE_OPACITY)
    }

    /** The same colour at [opacity], discarding whatever alpha it arrived with. */
    private fun Int.withOpacity(opacity: Float): Int =
        Color.argb((opacity * MAX_ALPHA).roundToInt(), Color.red(this), Color.green(this), Color.blue(this))
}
