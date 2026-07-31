package earth.mention.widgets.trends.list

import androidx.glance.appwidget.GlanceAppWidget
import earth.mention.widgets.trends.TrendsWidgetReceiver

/** Manifest provider for variant A. Lifecycle behaviour is [TrendsWidgetReceiver]'s. */
class TrendsListWidgetReceiver : TrendsWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TrendsListWidget()
}
