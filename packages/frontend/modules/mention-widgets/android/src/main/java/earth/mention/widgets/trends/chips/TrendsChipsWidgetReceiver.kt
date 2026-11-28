package earth.mention.widgets.trends.chips

import androidx.glance.appwidget.GlanceAppWidget
import earth.mention.widgets.trends.TrendsWidgetReceiver

/** Manifest provider for variant C. Lifecycle behaviour is [TrendsWidgetReceiver]'s. */
class TrendsChipsWidgetReceiver : TrendsWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TrendsChipsWidget()
}
