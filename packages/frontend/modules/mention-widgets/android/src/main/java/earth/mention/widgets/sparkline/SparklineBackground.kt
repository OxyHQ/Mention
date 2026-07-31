package earth.mention.widgets.sparkline

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.toArgb
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.ContentScale
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.unit.ColorProvider

/**
 * The chart, as a band along the bottom of whatever it is placed in.
 *
 * WHOSE chart it is: the widget's LEADING trend — the one its first row, first chip
 * or headline names. A widget shows several trends but one chart, and the
 * alternatives were both worse. Summing the visible trends' series would need them
 * to share a time axis, and they do not: the server downsamples each trend over the
 * batches THAT trend appeared in, so a six-point series and a twelve-point one
 * cover the same day at different resolutions and adding them index-by-index would
 * invent a shape neither one measured. A chart per row costs a bitmap per row per
 * declared size, which is the payload shape that makes a widget render blank.
 *
 * Placed as the FIRST child of the surface it belongs to, so everything composed
 * after it draws on top:
 *
 *     Box {
 *         SparklineBackground(series, color)
 *         // …text, rows, chips…
 *     }
 *
 * It emits nothing at all when there is no series — which is a normal state, not a
 * failure: the server omits `series` for a trend it has seen in too few batches to
 * draw honestly.
 */
@Composable
internal fun SparklineBackground(series: List<Float>, color: ColorProvider) {
    val context = LocalContext.current
    val widgetSize = LocalSize.current
    val bandHeight = sparklineBandHeight(widgetSize.height)

    // Resolved here rather than passed in as an int: `ColorProvider` is what the
    // theme deals in, and on API 31+ this is the value that follows the user's
    // wallpaper. The Canvas needs it flattened to ARGB.
    val lineColor = color.getColor(context).toArgb()

    // One `remember`, called unconditionally, holding everything that depends on
    // the size: rasterising on every recomposition would redraw the same curve each
    // time the store emits.
    val bitmap = remember(series, widgetSize, lineColor) {
        val size = sparklineBitmapSize(widgetSize.width, bandHeight)
        if (size == null) null else SparklineRenderer.render(series, size, lineColor)
    }

    if (bitmap != null) {
        Box(modifier = GlanceModifier.fillMaxSize(), contentAlignment = Alignment.BottomStart) {
            Image(
                provider = ImageProvider(bitmap),
                // Decorative. A screen reader cannot be told the shape of a curve,
                // and the trend the chart belongs to is already announced by the
                // row, chip or headline that names it.
                contentDescription = null,
                modifier = GlanceModifier.fillMaxWidth().height(bandHeight),
                // The bitmap is rendered at one pixel per dp and stretched to the
                // device's pixels here; see SPARKLINE_PIXELS_PER_DP. Its aspect
                // already matches this box, so nothing is distorted.
                contentScale = ContentScale.FillBounds,
            )
        }
    }
}
