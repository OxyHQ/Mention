import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Toggle } from '@/components/Toggle';
import { useTheme } from '@/hooks/useTheme';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { labelerService } from '@/services/labelerService';

interface SubscribedLabeler {
  id: string;
  name: string;
  activeLabelCount: number;
}

interface LabelPreferencesSectionProps {
  /** Called when the master filter toggle changes. If omitted, toggle is not shown. */
  onFilteringToggle?: (enabled: boolean) => void;
  /** Current value of the master filter toggle. */
  filteringEnabled?: boolean;
}

const LabelPreferencesSection: React.FC<LabelPreferencesSectionProps> = ({
  onFilteringToggle,
  filteringEnabled = true,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const [subscribedLabelers, setSubscribedLabelers] = useState<SubscribedLabeler[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSubscribedLabelers();
  }, []);

  const loadSubscribedLabelers = useCallback(async () => {
    try {
      const res = await labelerService.list();
      const subscribed = (res.items ?? [])
        .filter((l: any) => l.isSubscribed)
        .map((l: any) => ({
          id: String(l._id || l.id),
          name: l.name,
          activeLabelCount: (l.labelDefinitions ?? []).length,
        }));
      setSubscribedLabelers(subscribed);
    } catch (e) {
      console.warn('Failed to load subscribed labelers', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleManageLabelersPress = useCallback(() => {
    router.push('/moderation/labelers');
  }, []);

  const handleLabelerPress = useCallback((id: string) => {
    router.push(`/moderation/labelers/${id}`);
  }, []);

  return (
    <View style={styles.section}>
      {/* Section header */}
      <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>
        {t('settings.contentLabels.title', { defaultValue: 'Content Labels' })}
      </Text>

      <View
        style={[
          styles.card,
          { backgroundColor: theme.colors.backgroundSecondary },
        ]}
      >
        {/* Master filter toggle */}
        {onFilteringToggle !== undefined && (
          <>
            <View style={styles.toggleRow}>
              <View style={styles.toggleInfo}>
                <Text style={[styles.toggleLabel, { color: theme.colors.text }]}>
                  {t('settings.contentLabels.enableFiltering', {
                    defaultValue: 'Enable label filtering',
                  })}
                </Text>
                <Text style={[styles.toggleDescription, { color: theme.colors.textSecondary }]}>
                  {t('settings.contentLabels.enableFilteringDesc', {
                    defaultValue:
                      'When on, posts with matching labels will be hidden, blurred, or flagged.',
                  })}
                </Text>
              </View>
              <Toggle value={filteringEnabled} onValueChange={onFilteringToggle} />
            </View>

            <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />
          </>
        )}

        {/* Manage labelers link */}
        <TouchableOpacity
          style={styles.menuRow}
          onPress={handleManageLabelersPress}
          activeOpacity={0.7}
        >
          <View style={styles.menuRowLeft}>
            <Ionicons name="shield-outline" size={20} color={theme.colors.text} />
            <Text style={[styles.menuRowText, { color: theme.colors.text }]}>
              {t('settings.contentLabels.manageLabelers', { defaultValue: 'Manage Labelers' })}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
        </TouchableOpacity>

        {/* Subscribed labelers list */}
        {!loading && subscribedLabelers.length > 0 && (
          <>
            <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />

            <Text style={[styles.subLabel, { color: theme.colors.textSecondary }]}>
              {t('settings.contentLabels.subscribed', { defaultValue: 'Subscribed' })}
            </Text>

            {subscribedLabelers.map((labeler, index) => (
              <React.Fragment key={labeler.id}>
                {index > 0 && (
                  <View style={[styles.inlineSeparator, { backgroundColor: theme.colors.border }]} />
                )}
                <TouchableOpacity
                  style={styles.labelerRow}
                  onPress={() => handleLabelerPress(labeler.id)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[styles.labelerName, { color: theme.colors.text }]}
                    numberOfLines={1}
                  >
                    {labeler.name}
                  </Text>
                  <View style={styles.labelerRight}>
                    <Text style={[styles.labelerCount, { color: theme.colors.textSecondary }]}>
                      {labeler.activeLabelCount}{' '}
                      {t('settings.contentLabels.labels', { defaultValue: 'labels' })}
                    </Text>
                    <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />
                  </View>
                </TouchableOpacity>
              </React.Fragment>
            ))}
          </>
        )}

        {!loading && subscribedLabelers.length === 0 && (
          <>
            <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />
            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
              {t('settings.contentLabels.noSubscriptions', {
                defaultValue: 'No labelers subscribed yet.',
              })}
            </Text>
          </>
        )}
      </View>
    </View>
  );
};

export default React.memo(LabelPreferencesSection);

const styles = StyleSheet.create({
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 4,
  },
  card: {
    borderRadius: 16,
    padding: 16,
    gap: 0,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 12,
  },
  inlineSeparator: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 4,
  },
  toggleInfo: {
    flex: 1,
    gap: 4,
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  toggleDescription: {
    fontSize: 13,
    lineHeight: 18,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  menuRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  menuRowText: {
    fontSize: 15,
    fontWeight: '500',
  },
  subLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  labelerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  labelerName: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  labelerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  labelerCount: {
    fontSize: 13,
  },
  emptyText: {
    fontSize: 13,
    paddingVertical: 4,
  },
});
