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
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { useLocalSearchParams } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { labelerService } from '@/services/labelerService';
import { SEVERITY_COLORS, Severity, LabelActionType } from '@/components/LabelBadge';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';

type LabelAction = LabelActionType;

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

const ACTION_OPTIONS_CONFIG: { value: LabelAction; labelKey: string }[] = [
  { value: 'show', labelKey: 'moderation.show' },
  { value: 'warn', labelKey: 'moderation.warn' },
  { value: 'blur', labelKey: 'moderation.blur' },
  { value: 'hide', labelKey: 'moderation.hide' },
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
    const { t } = useTranslation();

    if (!isSubscribed) return null;

    return (
      <View className="flex-row gap-1.5 mt-1 flex-wrap">
        {ACTION_OPTIONS_CONFIG.map(({ value, labelKey }) => {
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
                className={cn(
                  "text-xs font-semibold",
                  isActive ? "text-primary" : "text-muted-foreground"
                )}
              >
                {t(labelKey)}
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
  const safeBack = useSafeBack();

  const [labeler, setLabeler] = useState<LabelerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [labelActions, setLabelActions] = useState<Record<string, LabelAction>>({});
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingActions = React.useRef<Record<string, LabelAction>>({});

  const loadLabeler = useCallback(async () => {
    try {
      const data: LabelerDetail = await labelerService.get(String(id));
      setLabeler(data);
      if (data.userPreferences) {
        setLabelActions(data.userPreferences as Record<string, LabelAction>);
      } else {
        const defaults: Record<string, LabelAction> = {};
        (data.labelDefinitions ?? []).forEach((ld) => {
          defaults[ld.slug] = ld.defaultAction ?? 'warn';
        });
        setLabelActions(defaults);
      }
    } catch (e) {
      logger.warn('Failed to load labeler', { error: e });
      toast(t('labelers.loadError', { defaultValue: 'Failed to load labeler' }), { type: 'error' });
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
        toast(t('labelers.unsubscribed', { defaultValue: 'Unsubscribed' }), { type: 'success' });
      } else {
        await labelerService.subscribe(labelerId);
        toast(t('labelers.subscribed', { defaultValue: 'Subscribed' }), { type: 'success' });
      }
    } catch (e) {
      logger.warn('Subscribe toggle failed', { error: e });
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
      toast(t('labelers.subscribeError', { defaultValue: 'Action failed' }), { type: 'error' });
    } finally {
      setSubscribing(false);
    }
  }, [labeler, t]);

  const handleActionChange = useCallback(
    (labelSlug: string, action: LabelAction) => {
      if (!labeler) return;
      setLabelActions((prev) => ({ ...prev, [labelSlug]: action }));
      pendingActions.current = { ...pendingActions.current, [labelSlug]: action };

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
          logger.warn('Failed to save label preferences', { error: e });
          toast(t('labelers.prefSaveError', { defaultValue: 'Failed to save preferences' }), { type: 'error' });
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
      <ThemedView className="flex-1">
        <Header
          options={{
            title: t('labelers.detailTitle', { defaultValue: 'Labeler' }),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <View className="flex-1 justify-center items-center">
          <Loading className="text-primary" size="large" />
        </View>
      </ThemedView>
    );
  }

  if (!labeler) {
    return (
      <ThemedView className="flex-1">
        <Header
          options={{
            title: t('labelers.detailTitle', { defaultValue: 'Labeler' }),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <View className="flex-1 justify-center items-center">
          <Text className="text-[15px] text-muted-foreground">
            {t('labelers.notFound', { defaultValue: 'Labeler not found.' })}
          </Text>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: labeler.name,
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
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
        <View className="rounded-2xl p-4 gap-3 bg-secondary">
          <View className="flex-row items-center gap-2 flex-wrap">
            <Text className="text-xl font-bold text-foreground">{labeler.name}</Text>
            {labeler.isOfficial && (
              <View className="flex-row items-center gap-[3px] px-1.5 py-0.5 rounded-md bg-primary">
                <Ionicons name="shield-checkmark" size={10} color="#fff" />
                <Text className="text-white text-[10px] font-bold">
                  {t('labelers.official', { defaultValue: 'Official' })}
                </Text>
              </View>
            )}
          </View>

          {!!labeler.description && (
            <Text className="text-[15px] leading-[22px] text-muted-foreground">
              {labeler.description}
            </Text>
          )}

          <View className="flex-row flex-wrap gap-3">
            <View className="flex-row items-center gap-1">
              <Ionicons name="people-outline" size={14} color={theme.colors.textSecondary} />
              <Text className="text-[13px] text-muted-foreground">
                {labeler.subscriberCount}{' '}
                {t('labelers.subscribers', { defaultValue: 'subscribers' })}
              </Text>
            </View>

            {!!creatorName && (
              <View className="flex-row items-center gap-1">
                <Ionicons name="person-outline" size={14} color={theme.colors.textSecondary} />
                <Text className="text-[13px] text-muted-foreground">
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
              <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
            ) : (
              <Text
                className={cn(
                  "text-[15px] font-semibold",
                  labeler.isSubscribed ? "text-foreground" : "text-white"
                )}
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
            <Text className="text-[13px] font-semibold uppercase tracking-wide mt-4 mb-1 px-1 text-muted-foreground">
              {t('labelers.labelDefinitions', { defaultValue: 'Label Definitions' })}
            </Text>

            <View className="rounded-2xl p-4 gap-3 bg-secondary">
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
                    <View className="gap-1.5">
                      <View className="flex-row items-center justify-between gap-2">
                        <Text className="text-[15px] font-semibold flex-1 text-foreground">
                          {ld.name}
                        </Text>
                        <View className="flex-row gap-1.5 items-center">
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
                              <Text className="text-[11px] font-semibold text-primary">
                                {ld.defaultAction}
                              </Text>
                            </View>
                          )}
                        </View>
                      </View>

                      <Text className="text-xs font-mono text-muted-foreground" numberOfLines={1}>
                        {ld.slug}
                      </Text>

                      {!!ld.description && (
                        <Text className="text-[13px] leading-[18px] text-muted-foreground">
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

        <View className="h-10" />
      </ScrollView>
    </ThemedView>
  );
};

export default LabelerDetailScreen;

const styles = StyleSheet.create({
  scrollContent: {
    padding: 16,
    gap: 8,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 12,
  },
  subscribeBtn: {
    borderRadius: 20,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
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
  actionChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
  },
});
