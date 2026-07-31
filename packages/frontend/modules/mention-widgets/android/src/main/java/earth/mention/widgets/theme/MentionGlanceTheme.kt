package earth.mention.widgets.theme

import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.glance.GlanceComposable
import androidx.glance.GlanceTheme
// Two different `ColorProvider`s, and both are needed: `androidx.glance.unit` is
// the TYPE, `androidx.glance.color` is the day/night factory function that
// builds one. Same split as androidx.glance:glance-material3's own theme file.
import androidx.glance.color.ColorProvider
import androidx.glance.color.ColorProviders
import androidx.glance.color.colorProviders

/**
 * The theme every Mention widget is drawn in.
 *
 * Material You first: on Android 12+ the widget takes its colours from the
 * user's wallpaper. That is what a bare [GlanceTheme] already does — its default
 * `colors` is Glance's own `DynamicThemeColorProviders`, which resolves to the
 * `@android:color/system_*` palette on API 31+ — so the dynamic branch here
 * passes no colours at all rather than reimplementing the lookup.
 *
 * Below API 31 there is no wallpaper palette to read, and Glance's fallback is
 * the Material BASELINE scheme (the stock purple). A Mention widget sitting next
 * to the Mention app should not be purple, so the fallback is [MentionWidgetColors]
 * — Mention's own palette, generated from the same seed the app's theme uses.
 */
@Composable
fun MentionGlanceTheme(content: @GlanceComposable @Composable () -> Unit) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        GlanceTheme(content = content)
    } else {
        GlanceTheme(colors = MentionWidgetColors, content = content)
    }
}

/**
 * Mention's palette as a Material 3 role set, for the devices that have no
 * dynamic colour.
 *
 * GENERATED, not authored. Every value below is Bloom's colour engine resolving
 * the `blue` preset — seed `#1d9bf0`, variant `vivid`, the preset Mention's
 * frontend defaults to — into the full Material 3 role set for light and dark:
 *
 *     const { generateRoleColors } = require('@oxyhq/bloom/lib/commonjs/theme/color-engine')
 *     const { APP_COLOR_PRESETS } = require('@oxyhq/bloom/lib/commonjs/theme/color-presets')
 *     const p = APP_COLOR_PRESETS.blue
 *     generateRoleColors({ seed: p.hex, variant: p.variant, isDark: false })
 *
 * `widgetBackground` is the one role Bloom has no equivalent for — it is a
 * widget-only Material role — so it is derived the way `glance-material3` derives
 * it: take `secondaryContainer` into HCT and shift its tone by +5 when the tone
 * is above 50, by −10 otherwise (see `adjustColorToneForWidgetBackground` in
 * androidx.glance:glance-material3).
 *
 * Regenerate rather than hand-edit if the app's preset ever changes.
 */
internal val MentionWidgetColors: ColorProviders = colorProviders(
    primary = ColorProvider(day = Color(0xFF00629D), night = Color(0xFF99CBFF)),
    onPrimary = ColorProvider(day = Color(0xFFFFFFFF), night = Color(0xFF003354)),
    primaryContainer = ColorProvider(day = Color(0xFFCFE5FF), night = Color(0xFF004A78)),
    onPrimaryContainer = ColorProvider(day = Color(0xFF004A78), night = Color(0xFFCFE5FF)),
    secondary = ColorProvider(day = Color(0xFF0059C8), night = Color(0xFFAFC6FF)),
    onSecondary = ColorProvider(day = Color(0xFFFFFFFF), night = Color(0xFF002D6D)),
    secondaryContainer = ColorProvider(day = Color(0xFFD9E2FF), night = Color(0xFF004299)),
    onSecondaryContainer = ColorProvider(day = Color(0xFF004299), night = Color(0xFFD9E2FF)),
    tertiary = ColorProvider(day = Color(0xFF4747E1), night = Color(0xFFC1C1FF)),
    onTertiary = ColorProvider(day = Color(0xFFFFFFFF), night = Color(0xFF1200A9)),
    tertiaryContainer = ColorProvider(day = Color(0xFFE1E0FF), night = Color(0xFF2C27C9)),
    onTertiaryContainer = ColorProvider(day = Color(0xFF2C27C9), night = Color(0xFFE1E0FF)),
    error = ColorProvider(day = Color(0xFFBA1A1A), night = Color(0xFFFFB4AB)),
    errorContainer = ColorProvider(day = Color(0xFFFFDAD6), night = Color(0xFF93000A)),
    onError = ColorProvider(day = Color(0xFFFFFFFF), night = Color(0xFF690005)),
    onErrorContainer = ColorProvider(day = Color(0xFF93000A), night = Color(0xFFFFDAD6)),
    background = ColorProvider(day = Color(0xFFF7F9FF), night = Color(0xFF0D141B)),
    onBackground = ColorProvider(day = Color(0xFF151C24), night = Color(0xFFDCE3EE)),
    surface = ColorProvider(day = Color(0xFFF7F9FF), night = Color(0xFF0D141B)),
    onSurface = ColorProvider(day = Color(0xFF151C24), night = Color(0xFFDCE3EE)),
    surfaceVariant = ColorProvider(day = Color(0xFFDAE3F1), night = Color(0xFF3E4852)),
    onSurfaceVariant = ColorProvider(day = Color(0xFF3E4852), night = Color(0xFFBEC7D4)),
    outline = ColorProvider(day = Color(0xFF6F7884), night = Color(0xFF88929E)),
    inverseOnSurface = ColorProvider(day = Color(0xFFEAF1FC), night = Color(0xFF2A3139)),
    inverseSurface = ColorProvider(day = Color(0xFF2A3139), night = Color(0xFFDCE3EE)),
    inversePrimary = ColorProvider(day = Color(0xFF99CBFF), night = Color(0xFF00629D)),
    widgetBackground = ColorProvider(day = Color(0xFFEEF0FF), night = Color(0xFF002D6D)),
)
