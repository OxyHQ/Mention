// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

package earth.mention.widgets.trends

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * The last trends the app managed to fetch.
 *
 * APP-SCOPED, not per widget instance. Every trends widget on the home screen
 * shows the same list, so one store means one write per refresh, and — more
 * usefully — a widget placed after the app has already been running paints real
 * content on its first frame instead of an empty box waiting for a fetch.
 *
 * It is a [DataStore] rather than SharedPreferences for the [Flow]: a Glance
 * session that is already running does NOT re-enter `provideGlance` when
 * `updateAll` is called, so a widget reading a non-reactive source would sit on
 * whatever it read when its session started.
 *
 * NOTHING here ever clears the stored trends. A failed refresh leaves the last
 * good list in place; that is what stops the widget blanking when the network
 * is down.
 */
private val Context.trendsDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "mention_widget_trends",
)

internal object TrendsRepository {
    private val KEY_TRENDS = stringPreferencesKey("trends")

    /** Emits on every write, which is what re-renders a live widget. */
    fun trends(context: Context): Flow<List<WidgetTrend>> =
        context.applicationContext.trendsDataStore.data.map { preferences ->
            decodeTrends(preferences[KEY_TRENDS])
        }

    suspend fun save(context: Context, trends: List<WidgetTrend>) {
        context.applicationContext.trendsDataStore.edit { preferences ->
            preferences[KEY_TRENDS] = encodeTrends(trends)
        }
    }
}
