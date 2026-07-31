package earth.mention.widgets.trends

import androidx.compose.runtime.Composable
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.components.CircleIconButton
import androidx.glance.appwidget.components.FilledButton
import androidx.glance.appwidget.components.TitleBar
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.height
import androidx.glance.text.Text
import androidx.glance.unit.ColorProvider
import earth.mention.widgets.R

/**
 * The composables the three trends widgets share: the title bar the taller
 * breakpoints show, and the state before the first fetch has ever succeeded.
 *
 * The measurements and the type scale they also share are in `TrendsWidgetStyle.kt`.
 */

/**
 * Mention's mark, the word, and the button through to the full list.
 */
@Composable
internal fun TrendsTitleBar(compact: Boolean) {
    val context = LocalContext.current
    TitleBar(
        startIcon = ImageProvider(R.drawable.mention_widget_brand),
        // Dropped when the widget is too narrow to hold the mark, the title and
        // the action without crowding — the canonical sample's own behaviour for
        // its Small breakpoint. The mark still says whose widget this is.
        title = if (compact) "" else context.getString(R.string.mention_trends_widget_title),
        iconColor = GlanceTheme.colors.primary,
        textColor = GlanceTheme.colors.onSurface,
        actions = {
            CircleIconButton(
<<<<<<< HEAD
                imageProvider = ImageProvider(R.drawable.mention_widget_chevron_right),
=======
                imageProvider = ImageProvider(R.drawable.mention_widget_see_all),
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
                contentDescription = context.getString(R.string.mention_trends_widget_see_all),
                contentColor = GlanceTheme.colors.secondary,
                backgroundColor = null,
                onClick = actionStartActivity(
                    openInAppIntent(context, trendingScreenUrl(context)),
                ),
            )
        },
    )
}

/**
 * Shown only when there has never been a successful fetch — a failed refresh
 * leaves the previous trends in place, so this is a first-run state rather than
 * an error state, and there is deliberately no spinner: a widget that rests on
 * a spinner is a widget that looks broken every time the user glances at it.
 *
 * [textColor] because the card variant's empty state sits on a tonal container
 * rather than on the widget background, where `onSurface` would be the wrong
 * contrast pair.
 */
@Composable
internal fun TrendsEmptyContent(textColor: ColorProvider) {
    val context = LocalContext.current
    Column(
        modifier = GlanceModifier.fillMaxSize(),
        verticalAlignment = Alignment.Vertical.CenterVertically,
        horizontalAlignment = Alignment.Horizontal.CenterHorizontally,
    ) {
        Text(
            text = context.getString(R.string.mention_trends_widget_empty),
            style = TrendsWidgetTextStyles.emptyMessage(textColor),
            maxLines = 1,
        )
        Spacer(GlanceModifier.height(TrendsWidgetDimensions.EMPTY_CONTENT_SPACING))
        FilledButton(
            text = context.getString(R.string.mention_trends_widget_open_app),
            onClick = actionStartActivity(openInAppIntent(context, trendingScreenUrl(context))),
            maxLines = 1,
        )
    }
}
