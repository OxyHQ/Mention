package earth.mention.widgets.trends

import android.content.Context
import android.content.Intent
import android.net.Uri
import earth.mention.widgets.R
import kotlin.math.floor

/**
 * Turning a [WidgetTrend] into the things the launcher shows and opens.
 *
 * Every rule here mirrors an existing in-app one, cited per function: a trend
 * has to read and behave the same on the home screen as it does in the app, and
 * a widget is the surface where a divergence is least likely to be noticed.
 */

/** Web origin the widget deep-links into; see `res/values/config.xml`. */
private fun webBaseUrl(context: Context): String =
    context.getString(R.string.mention_widget_web_base_url).trimEnd('/')

/**
 * What tapping a row opens.
 *
 * Mirrors `buildTrendUrl` (hooks/useTrendNavigation.ts): a hashtag goes to
 * `/hashtag/<tag>` with any leading `#` stripped, everything else to
 * `/trend/<name>`. `Uri.encode` escapes the same character set as JavaScript's
 * `encodeURIComponent`, so the two produce byte-identical paths.
 */
internal fun trendUrl(context: Context, trend: WidgetTrend): String {
    val base = webBaseUrl(context)
    return if (trend.kind == TrendKind.HASHTAG) {
        "$base/hashtag/${Uri.encode(trend.name.removePrefix("#"))}"
    } else {
        "$base/trend/${Uri.encode(trend.name)}"
    }
}

/** Where the title-bar button goes: the full Trending screen. */
internal fun trendingScreenUrl(context: Context): String = "${webBaseUrl(context)}/explore/trending"

/**
 * An intent that opens [url] in Mention and nowhere else.
 *
 * `setPackage` is what makes that true: the app already claims
 * `https://mention.earth` with a verified App Link (`android.intentFilters` in
 * app.config.js), and restricting the intent to our own package means the
 * chooser can never appear and a browser can never win the tap — while still
 * going through the same VIEW path the app handles for a shared link, so
 * expo-router resolves the URL with no widget-specific routing.
 *
 * `NEW_TASK` is required: the sender is the launcher's process, not an Activity
 * of ours.
 */
internal fun openInAppIntent(context: Context, url: String): Intent =
    Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .setPackage(context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

/**
 * The supporting line for a trend — "Trending · 1.2K posts", "Trending topic".
 *
 * Mirrors `getTrendLabel` (components/trending/TrendItemRow.tsx), localized
 * through resources because the widget renders in the system's language without
 * the app's i18n runtime being loaded.
 */
internal fun trendLabel(context: Context, trend: WidgetTrend): String = when {
    trend.kind == TrendKind.HASHTAG && trend.volume > 0 ->
        context.getString(R.string.mention_trends_widget_item_hashtag, formatCompactCount(trend.volume))
    trend.kind == TrendKind.TOPIC -> context.getString(R.string.mention_trends_widget_item_topic)
    else -> context.getString(R.string.mention_trends_widget_item_generic)
}

/**
 * The name as drawn: hashtags carry their `#`, everything else is bare.
 *
 * Mirrors `getTrendDisplayName` (components/trending/TrendItemRow.tsx).
 */
internal fun trendDisplayName(trend: WidgetTrend): String =
    if (trend.kind == TrendKind.HASHTAG) "#${trend.name.removePrefix("#")}" else trend.name

private const val THOUSAND = 1_000
private const val MILLION = 1_000_000
private const val BILLION = 1_000_000_000

/**
 * Compact post counts, as a port of `formatCompactNumber`
 * (utils/formatNumber.ts) restricted to the non-negative integers `volume` can
 * hold.
 *
 * Two behaviours are load-bearing and both come from that file:
 *  - the value is TRUNCATED to a tenth, never rounded, so 9,999 reads "9.9K"
 *    rather than crossing to a "10K" it has not reached;
 *  - a whole multiple of the unit drops the decimal ("10K", not "10.0K").
 *
 * `Locale.ROOT` and the bare K/M/B suffixes are deliberate rather than an
 * oversight: this is the same string the app paints beside the same trend, and
 * a home-screen row that said "1,2 mil" while the app said "1.2K" would read as
 * two different numbers.
 */
internal fun formatCompactCount(count: Int): String {
    val (scaled, suffix) = when {
        count >= BILLION -> count.toDouble() / BILLION to "B"
        count >= MILLION -> count.toDouble() / MILLION to "M"
        count >= THOUSAND -> count.toDouble() / THOUSAND to "K"
        else -> return count.toString()
    }
    val tenths = floor(scaled * 10).toLong()
    val whole = tenths / 10
    val remainder = tenths % 10
    return if (remainder == 0L) "$whole$suffix" else "$whole.$remainder$suffix"
}
