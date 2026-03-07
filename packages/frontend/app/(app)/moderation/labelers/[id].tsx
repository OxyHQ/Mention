import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Loading } from '@/components/ui/Loading';
import { useTheme } from '@/hooks/useTheme';
import { useLocalSearchParams, router } from 'expo-router';
import { toast } from '@/lib/sonner';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { labelerService } from '@/services/labelerService';

type Severity = 'low' | 'medium' | 'high' | 'critical';
type LabelAction = 'show' | 'warn' | 'blur' | 'hide';

interface LabelDefinition {
  slug: string;
  name: string;
  description?: string;
  severity?: Severity;
  defaultAction?: LabelAction;
}

interface LabelerDetail {
  _id: string;
  id?: string;
  name: string;
  description?: string;
  subscriberCount: number;
  labelDefinitions?: LabelDefinition[];
  isOfficial?: boolean;
  isSubscribed?: boolean;
  createdBy?: {
    username?: string;
    name?: { full?: string };
  };
  userPreferences?: Record<string, LabelAction>;
}

const SEVERITY_COLORS: Record<Severity, string> = {
  low: '#6b7280',
  medium: '#f59e0b',
  high: '#f97316',
  critical: '#ef4444',
};

const ACTION_OPTIONS: { value: LabelAction; label: string }[] = [
  { value: 'show', label: 'Show' },
  { value: 'warn', label: 'Warn' },
  { value: 'blur', label: 'Blur' },
  { value: 'hide', label: 'Hide' },
];

interface SeverityBadgeProps {
  severity: Severity;
}

const SeverityBadge = React.memo(({ severity }: SeverityBadgeProps) => {
  const color = SEVERITY_COLORS[severity] ?? SEVERITY_COLORS.low;
  return (
    <View style={[styles.badge, { backgroundColor: `${color}20`, borderColor: `${color}50` }]}>
      <Text style={[styles.badgeText, { color }]}>
        {severity.charAt(0).toUpperCase() + severity.slice(1)}
      </Text>
    </View>
  );
});

SeverityBadge.displayName = 'SeverityBadge';

interface ActionChipsProps {
  labelSlug: string;
  labelerId: string;
  currentAction: LabelAction;
  isSubscribed: boolean;
  onActionChange: (labelSlug: string, action: LabelAction) => void;
}

const ActionChips = React.memo(
  ({ labelSlug, currentAction, isSubscribed, onActionChange }: ActionChipsProps) => {
    const theme = useTheme();

    if (!isSubscribed) return null;

    return (
      <View style={styles.actionChips}>
        {ACTION_OPTIONS.map(({ value, label }) => {
          const isActive = currentAction === value;
          return (
            <TouchableOpacity
              key={value}
              style={[
                styles.actionChip,
                {
                  borderColor: isActive ? theme.colors.primary : theme.colors.border,
                  backgroundColor: isActive ? `${theme.colors.primary}18` : 'transparent',
                },
              ]}
              onPress={() => onActionChange(labelSlug, value)}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.actionChipText,
                  { color: isActive ? theme.colors.primary : theme.colors.textSecondary },
                ]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  },
);

ActionChips.displayName = 'ActionChips';

const LabelerDetailScreen: React.FC = () => {
  const theme = useTheme();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [labeler, setLabeler] = useState<LabelerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  // Map of labelSlug -> action for per-label preferences
  const [labelActions, setLabelActions] = useState<Record<string, LabelAction>>({});
  // Pending saves to debounce
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingActions = React.useRef<Record<string, LabelAction>>({});

  const loadLabeler = useCallback(async () => {
    try {
      const data: LabelerDetail = await labelerService.get(String(id));
      setLabeler(data);
      if (data.userPreferences) {
        setLabelActions(data.userPreferences as Record<string, LabelAction>);
      } else {
        // Build default actions from label definitions
        const defaults: Record<string, LabelAction> = {};
        (data.labelDefinitions ?? []).forEach((ld) => {
          defaults[ld.slug] = ld.defaultAction ?? 'warn';
        });
        setLabelActions(defaults);
      }
    } catch (e) {
      console.warn('Failed to load labeler', e);
      toast.error(t('labelers.loadError', { defaultValue: 'Failed to load labeler' }));
    }
  }, [id, t]);

  useEffect(() => {
    loadLabeler().finally(() => setLoading(false));
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [loadLabeler]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadLabeler();
    setRefreshing(false);
  }, [loadLabeler]);

  const handleSubscribeToggle = useCallback(async () => {
    if (!labeler) return;
    const currentlySubscribed = !!labeler.isSubscribed;
    setSubscribing(true);

    // Optimistic update
    setLabeler((prev) =>
      prev
        ? {
            ...prev,
            isSubscribed: !currentlySubscribed,
            subscriberCount: currentlySubscribed
              ? prev.subscriberCount - 1
              : prev.subscriberCount + 1,
          }
        : prev,
    );

    try {
      const labelerId = String(labeler._id || labeler.id);
      if (currentlySubscribed) {
        await labelerService.unsubscribe(labelerId);
        toast.success(t('labelers.unsubscribed', { defaultValue: 'Unsubscribed' }));
      } else {
        await labelerService.subscribe(labelerId);
        toast.success(t('labelers.subscribed', { defaultValue: 'Subscribed' }));
      }
    } catch (e) {
      console.warn('Subscribe toggle failed', e);
      // Revert
      setLabeler((prev) =>
        prev
          ? {
              ...prev,
              isSubscribed: currentlySubscribed,
              subscriberCount: currentlySubscribed
                ? prev.subscriberCount + 1
                : prev.subscriberCount - 1,
            }
          : prev,
      );
      toast.error(t('labelers.subscribeError', { defaultValue: 'Action failed' }));
    } finally {
      setSubscribing(false);
    }
  }, [labeler, t]);

  const handleActionChange = useCallback(
    (labelSlug: string, action: LabelAction) => {
      if (!labeler) return;
      setLabelActions((prev) => ({ ...prev, [labelSlug]: action }));
      pendingActions.current = { ...pendingActions.current, [labelSlug]: action };

      // Debounce save
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const labelerId = String(labeler._id || labeler.id);
        const updates = Object.entries(pendingActions.current).map(([slug, act]) => ({
          labelerId,
          labelSlug: slug,
          action: act,
        }));
        pendingActions.current = {};
        try {
          await labelerService.updatePreferences(updates);
        } catch (e) {
          console.warn('Failed to save label preferences', e);
          toast.error(t('labelers.prefSaveError', { defaultValue: 'Failed to save preferences' }));
        }
      }, 800);
    },
    [labeler, t],
  );

  const creatorName = useMemo(() => {
    if (!labeler?.createdBy) return null;
    return labeler.createdBy.name?.full || labeler.createdBy.username || null;
  }, [labeler]);

  const labelerId = labeler ? String(labeler._id || labeler.id) : '';

  if (loading) {
    return (
      <ThemedView style={styles.container}>
        <Header
          options={{
            title: t('labelers.detailTitle', { defaultValue: 'Labeler' }),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => router.back()}>
                <BackArrowIcon size={20} color={theme.colors.text} />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <View style={styles.loadingContainer}>
          <Loading size="large" />
        </View>
      </ThemedView>
    );
  }

  if (!labeler) {
    return (
      <ThemedView style={styles.container}>
        <Header
          options={{
            title: t('labelers.detailTitle', { defaultValue: 'Labeler' }),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => router.back()}>
                <BackArrowIcon size={20} color={theme.colors.text} />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <View style={styles.loadingContainer}>
          <Text style={[styles.errorText, { color: theme.colors.textSecondary }]}>
            {t('labelers.notFound', { defaultValue: 'Labeler not found.' })}
          </Text>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <Header
        options={{
          title: labeler.name,
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
        }}
        hideBottomBorder
        disableSticky
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.primary}
          />
        }
      >
        {/* Hero card */}
        <View style={[styles.card, { backgroundColor: theme.colors.backgroundSecondary }]}>
          <View style={styles.heroNameRow}>
            <Text style={[styles.heroName, { color: theme.colors.text }]}>{labeler.name}</Text>
            {labeler.isOfficial && (
              <View style={[styles.officialBadge, { backgroundColor: theme.colors.primary }]}>
                <Ionicons name="shield-checkmark" size={10} color="#fff" />
                <Text style={styles.officialBadgeText}>
                  {t('labelers.official', { defaultValue: 'Official' })}
                </Text>
              </View>
            )}
          </View>

          {!!labeler.description && (
            <Text style={[styles.heroDescription, { color: theme.colors.textSecondary }]}>
              {labeler.description}
            </Text>
          )}

          <View style={styles.heroMeta}>
            <View style={styles.heroMetaItem}>
              <Ionicons name="people-outline" size={14} color={theme.colors.textSecondary} />
              <Text style={[styles.heroMetaText, { color: theme.colors.textSecondary }]}>
                {labeler.subscriberCount}{' '}
                {t('labelers.subscribers', { defaultValue: 'subscribers' })}
              </Text>
            </View>

            {!!creatorName && (
              <View style={styles.heroMetaItem}>
                <Ionicons name="person-outline" size={14} color={theme.colors.textSecondary} />
                <Text style={[styles.heroMetaText, { color: theme.colors.textSecondary }]}>
                  {t('labelers.by', { defaultValue: 'by' })} {creatorName}
                </Text>
              </View>
            )}
          </View>

          <TouchableOpacity
            style={[
              styles.subscribeBtn,
              labeler.isSubscribed
                ? { borderColor: theme.colors.border, backgroundColor: 'transparent', borderWidth: 1 }
                : { backgroundColor: theme.colors.primary },
            ]}
            onPress={handleSubscribeToggle}
            disabled={subscribing}
            activeOpacity={0.7}
          >
            {subscribing ? (
              <Loading variant="inline" size="small" style={{ flex: undefined }} />
            ) : (
              <Text
                style={[
                  styles.subscribeBtnText,
                  labeler.isSubscribed ? { color: theme.colors.text } : { color: '#fff' },
                ]}
              >
                {labeler.isSubscribed
                  ? t('labelers.unsubscribe', { defaultValue: 'Unsubscribe' })
                  : t('labelers.subscribe', { defaultValue: 'Subscribe' })}
              </Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Label definitions section */}
        {(labeler.labelDefinitions?.length ?? 0) > 0 && (
          <>
            <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
              {t('labelers.labelDefinitions', { defaultValue: 'Label Definitions' })}
            </Text>

            <View style={[styles.card, { backgroundColor: theme.colors.backgroundSecondary }]}>
              {(labeler.labelDefinitions ?? []).map((ld, index) => {
                const severity: Severity = ld.severity ?? 'low';
                const currentAction: LabelAction = labelActions[ld.slug] ?? ld.defaultAction ?? 'warn';

                return (
                  <React.Fragment key={ld.slug}>
                    {index > 0 && (
                      <View
                        style={[styles.separator, { backgroundColor: theme.colors.border }]}
                      />
                    )}
                    <View style={styles.labelRow}>
                      <View style={styles.labelHeader}>
                        <Text style={[styles.labelName, { color: theme.colors.text }]}>
                          {ld.name}
                        </Text>
                        <View style={styles.labelBadges}>
                          <SeverityBadge severity={severity} />
                          {ld.defaultAction && (
                            <View
                              style={[
                                styles.badge,
                                {
                                  backgroundColor: `${theme.colors.primary}15`,
                                  borderColor: `${theme.colors.primary}40`,
                                },
                              ]}
                            >
                              <Text style={[styles.badgeText, { color: theme.colors.primary }]}>
                                {ld.defaultAction}
                              </Text>
                            </View>
                          )}
                        </View>
                      </View>

                      <Text
                        style={[styles.labelSlug, { color: theme.colors.textSecondary }]}
                        numberOfLines={1}
                      >
                        {ld.slug}
                      </Text>

                      {!!ld.description && (
                        <Text style={[styles.labelDescription, { color: theme.colors.textSecondary }]}>
                          {ld.description}
                        </Text>
                      )}

                      <ActionChips
                        labelSlug={ld.slug}
                        labelerId={labelerId}
                        currentAction={currentAction}
                        isSubscribed={!!labeler.isSubscribed}
                        onActionChange={handleActionChange}
                      />
                    </View>
                  </React.Fragment>
                );
              })}
            </View>
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </ThemedView>
  );
};

export default LabelerDetailScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    fontSize: 15,
  },
  scrollContent: {
    padding: 16,
    gap: 8,
  },
  card: {
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 12,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  // Hero
  heroNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  heroName: {
    fontSize: 20,
    fontWeight: '700',
  },
  officialBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  officialBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  heroDescription: {
    fontSize: 15,
    lineHeight: 22,
  },
  heroMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  heroMetaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  heroMetaText: {
    fontSize: 13,
  },
  subscribeBtn: {
    borderRadius: 20,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  subscribeBtnText: {
    fontSize: 15,
    fontWeight: '600',
  },
  // Label definitions
  labelRow: {
    gap: 6,
  },
  labelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  labelName: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  labelBadges: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
  },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  labelSlug: {
    fontSize: 12,
    fontFamily: 'monospace',
  },
  labelDescription: {
    fontSize: 13,
    lineHeight: 18,
  },
  // Action chips
  actionChips: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
    flexWrap: 'wrap',
  },
  actionChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
  actionChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
