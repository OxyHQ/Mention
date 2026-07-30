package earth.mention.widgets.feedcard

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.util.Log
import java.io.File
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Turning a cached image FILE into the exact bitmap the card needs.
 *
 * Everything happens in ONE pass — downscale, centre-crop, round, and for the card's
 * background darken — because each step alone would allocate another full-size bitmap, and
 * this code runs while the launcher is waiting for a composition.
 *
 * Rounding, where it happens at all, is done HERE in the bitmap rather than with Glance's
 * `cornerRadius` modifier: that modifier is backed by `setViewOutlinePreferredRadius` and
 * does nothing below API 31, so on an API 23–30 device a rounded element would come out
 * square. The BACKGROUND is the exception and takes no radius at all — its corners are the
 * card's corners, and the host already clips those (see `FeedCardDimensions`).
 *
 * Everything that decides HOW BIG the bitmap is lives in `FeedCardBitmaps.kt` and is
 * unit tested. This file is the `android.graphics` calls, which are stubs off-device.
 */
internal object FeedImageRenderer {

    private const val TAG = "MentionPostsWidget"

    /**
     * Decode [file] into the card's BACKGROUND: [size] pixels, cropped to fill, with
     * [scrimAlpha] of black baked over it.
     *
     * The scrim is baked into the pixels because Glance cannot draw one. There is no
     * gradient primitive, no `Modifier.background(Brush)`, and no way to overlay a
     * translucent colour on an `Image` — a `Box` with a coloured child would work only if
     * `RemoteViews` composited children the way Compose does, which it does not. So the
     * darkening has to be part of the picture, exactly as the sparkline's fill is part of
     * its own bitmap.
     *
     * Baked-in also means the scrim cannot be lost: it survives the launcher's crop and it
     * cannot be defeated by a theme, which is the point of the contrast floor it implements
     * (see [IMAGE_SCRIM_ALPHA]).
     */
    fun decodeCardBackground(file: File, size: FeedBitmapSize, scrimAlpha: Float): Bitmap? =
        decodeInto(file, size, cornerRadiusPx = 0f, scrimAlpha = scrimAlpha)

    /** The byline's avatar: round, and undarkened — no text is drawn on it. */
    fun decodeCircular(file: File, size: FeedBitmapSize): Bitmap? = decodeInto(
        file = file,
        size = size,
        cornerRadiusPx = max(size.widthPx, size.heightPx) / 2f,
        scrimAlpha = 0f,
    )

    /**
     * Decode [file] into a [size] bitmap, cropped to fill, with [cornerRadiusPx] corners
     * and [scrimAlpha] of black over it.
     *
     * Returns `null` for anything that cannot be decoded — a truncated download, a file
     * that is not an image, a device too low on memory to hold the result. The caller
     * draws no image in that case, which is the same thing it does for a post that has
     * no image at all, so a failure here costs a picture and never a card.
     */
    private fun decodeInto(
        file: File,
        size: FeedBitmapSize,
        cornerRadiusPx: Float,
        scrimAlpha: Float,
    ): Bitmap? {
        val source = decodeSampled(file, size) ?: return null
        return try {
            cropToFill(source, size, cornerRadiusPx, scrimAlpha)
        } catch (cause: OutOfMemoryError) {
            // Caught deliberately, and only around the allocation: a widget must not be
            // the reason a launcher dies, and the honest fallback for a picture that
            // will not fit in memory is no picture.
            Log.w(TAG, "Not enough memory to draw a ${size.widthPx}×${size.heightPx} card image", cause)
            null
        } finally {
            // `cropToFill` draws `source` into a new bitmap, so the decoded original is
            // dead the moment it returns — including on the failure path above.
            source.recycle()
        }
    }

    /**
     * Decode [file] at the smallest power-of-two reduction that still covers [target].
     *
     * `inSampleSize` is the only way to decode a large JPEG without allocating it at
     * full size first — a 2048px feed image is 16MB at ARGB_8888, and the slot it is
     * going into is 30,000 pixels. Powers of two are all `BitmapFactory` honours, which
     * is why the exact size is reached by the scaling draw afterwards rather than here.
     */
    private fun decodeSampled(file: File, target: FeedBitmapSize): Bitmap? {
        if (!file.isFile || file.length() == 0L) return null

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            Log.w(TAG, "Cached card image is not a decodable image: ${file.name}")
            return null
        }

        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSizeFor(bounds.outWidth, bounds.outHeight, target)
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return BitmapFactory.decodeFile(file.path, options)
    }

    /**
     * Draw [source] into a [size] bitmap, scaled to COVER and centred, with rounded
     * corners and [scrimAlpha] of black over the result.
     *
     * Cover rather than fit, because the bitmap has a shape of its own that the picture
     * may not share: fitting would letterbox a portrait photo and leave two transparent
     * columns, where cropping shows the middle of the picture — which is what a reader
     * expects from every other image in a feed.
     */
    private fun cropToFill(
        source: Bitmap,
        size: FeedBitmapSize,
        cornerRadiusPx: Float,
        scrimAlpha: Float,
    ): Bitmap {
        val scale = max(
            size.widthPx.toFloat() / source.width.toFloat(),
            size.heightPx.toFloat() / source.height.toFloat(),
        )
        val matrix = Matrix().apply {
            setScale(scale, scale)
            postTranslate(
                (size.widthPx - source.width * scale) / 2f,
                (size.heightPx - source.height * scale) / 2f,
            )
        }

        val output = Bitmap.createBitmap(size.widthPx, size.heightPx, Bitmap.Config.ARGB_8888)
        // A shader rather than `drawBitmap` + a clip: `Canvas.clipPath` is not
        // antialiased, so a clipped corner comes out visibly jagged, while a rounded
        // rect filled with an antialiased shader does not.
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
            shader = BitmapShader(source, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply {
                setLocalMatrix(matrix)
            }
        }
        val canvas = Canvas(output)
        canvas.drawRoundRect(
            0f,
            0f,
            size.widthPx.toFloat(),
            size.heightPx.toFloat(),
            cornerRadiusPx,
            cornerRadiusPx,
            paint,
        )

        if (scrimAlpha > 0f) {
            // Over the same rounded rect rather than the whole canvas, so a rounded bitmap
            // does not get opaque black corners outside its own curve.
            val scrim = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.BLACK
                alpha = (scrimAlpha.coerceIn(0f, 1f) * MAX_ALPHA).roundToInt()
            }
            canvas.drawRoundRect(
                0f,
                0f,
                size.widthPx.toFloat(),
                size.heightPx.toFloat(),
                cornerRadiusPx,
                cornerRadiusPx,
                scrim,
            )
        }
        return output
    }

    /** `Paint.alpha` is 0–255, while every scrim figure in this module is a fraction. */
    private const val MAX_ALPHA = 255f
}

/**
 * The `inSampleSize` to decode a `sourceWidth × sourceHeight` image at so the result
 * still covers [target].
 *
 * Doubles the reduction only while BOTH axes stay at or above the target, so the
 * sampled bitmap is never smaller than the slot on either axis — sampling past that
 * would upscale a picture into its own slot and undo the point of decoding at size.
 *
 * Pure, and separated from the decode for that reason: this is the part that can be
 * wrong.
 */
internal fun sampleSizeFor(sourceWidth: Int, sourceHeight: Int, target: FeedBitmapSize): Int {
    if (sourceWidth <= 0 || sourceHeight <= 0) return 1
    var sample = 1
    while (
        sourceWidth / (sample * 2) >= target.widthPx &&
        sourceHeight / (sample * 2) >= target.heightPx
    ) {
        sample *= 2
    }
    return sample
}
