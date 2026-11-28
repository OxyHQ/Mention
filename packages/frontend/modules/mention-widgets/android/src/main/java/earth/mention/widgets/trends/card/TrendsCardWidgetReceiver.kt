// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

package earth.mention.widgets.trends.card

import androidx.glance.appwidget.GlanceAppWidget
import earth.mention.widgets.trends.TrendsWidgetReceiver

/** Manifest provider for variant J. Lifecycle behaviour is [TrendsWidgetReceiver]'s. */
class TrendsCardWidgetReceiver : TrendsWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TrendsCardWidget()
}
