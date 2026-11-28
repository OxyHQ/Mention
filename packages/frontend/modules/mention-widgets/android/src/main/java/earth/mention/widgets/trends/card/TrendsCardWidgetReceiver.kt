package earth.mention.widgets.trends.card

import androidx.glance.appwidget.GlanceAppWidget
import earth.mention.widgets.trends.TrendsWidgetReceiver

/** Manifest provider for variant J. Lifecycle behaviour is [TrendsWidgetReceiver]'s. */
class TrendsCardWidgetReceiver : TrendsWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TrendsCardWidget()
}
