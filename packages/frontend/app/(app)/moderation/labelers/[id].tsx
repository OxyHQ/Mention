import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  type TextStyle,
  TouchableOpacity,
  View,
} from 'react-native';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiShieldCheckLine } from '@oxy.so/bloom/icons/RiShieldCheckLine';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { useTheme, withAlpha } from '@oxy.so/bloom/theme';
import { useLocalSearchParams } from '@/lib/navigation/router';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from 'react-i18next';
import { labelerService } from '@/services/labelerService';
import { SEVERITY_COLORS, type Severity, type LabelActionType } from '@/components/LabelBadge';
import { logger } from '@oxy.so/core/logger';

import {
  Divider as LDivider,
  Embed,
  HStack,
  Header,
  Icon,
  Loading,
  RawText,
  ScrollView,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';
const appColors = defineTokens({ color: { hexfff: '#fff' } });

/** A label's slug: 12/16, the platform's monospace on native (the web drew the inherited face). */
const SLUG_STYLE: TextStyle = {
  fontSize: 12,
  lineHeight: 16,
  ...Platform.select({ native: { fontFamily: 'monospace' } }),
};

/** The "Official" badge: a shield and the word, white on the primary fill (rounded on the web only, as the app's `rounded-md` drew it). */
function officialBadge(label: string) {
  return HStack(
    Icon(RiShieldCheckLine).size('10').foreground(appColors.color.hexfff),
    RawText(label).foreground('white').font('2xs').weight('bold'),
  )
    .padding('horizontal', '6')
    .padding('vertical', '2xs')
    .background('primary')
    .when('web', (v) => v.corner('14'))
    .align('center')
    .spacing('3');
}

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
    name?: { displayName?: string };
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

    return toElement(
      HStack(
        Embed((render) =>
          ACTION_OPTIONS_CONFIG.map(({ value, labelKey }) => {
            const isActive = currentAction === value;
            return (
              <TouchableOpacity
                key={value}
                // The active fill is the primary at 10% (`withAlpha`), NOT
                // `${theme.colors.primary}18`: that token resolves to `rgb(0 98 157)`, so the
                // hex-alpha suffix is a malformed colour react-native-web reads as fully
                // opaque — the chip painted solid primary under its own primary label, so
                // the selected action was the one word you could not read.
                style={[
                  styles.actionChip,
                  { borderColor: isActive ? theme.colors.primary : theme.colors.border },
                  isActive && { backgroundColor: withAlpha(theme.colors.primary, 0.1) },
                ]}
                onPress={() => onActionChange(labelSlug, value)}
                activeOpacity={0.7}
              >
                {render(
                  RawText(t(labelKey))
                    .font('xs')
                    .leading('16px')
                    .weight('semibold')
                    .foreground(isActive ? 'primary' : 'muted'),
                )}
              </TouchableOpacity>
            );
          }),
        ),
      )
        .spacing('6')
        .margin('top', 'xs')
        .wrap(),
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
          toast(t('labelers.prefSaveError', { defaultValue: 'Failed to save preferences' }), {
            type: 'error',
          });
        }
      }, 800);
    },
    [labeler, t],
  );

  const creatorName = useMemo(() => {
    if (!labeler?.createdBy) return null;
    return labeler.createdBy.name?.displayName ?? labeler.createdBy.username ?? null;
  }, [labeler]);

  const labelerId = labeler ? String(labeler._id || labeler.id) : '';

  if (loading) {
    return (
      <Screen
        header={toElement(
          Header(t('labelers.detailTitle', { defaultValue: 'Labeler' }))
            .backLabel(t('common.back', { defaultValue: 'Back' }))
            .inPage(),
        )}
      >
        {toElement(ScrollView(Embed(<DetailSkeleton />)))}
      </Screen>
    );
  }

  if (!labeler) {
    return (
      <Screen
        header={toElement(
          Header(t('labelers.detailTitle', { defaultValue: 'Labeler' }))
            .backLabel(t('common.back', { defaultValue: 'Back' }))
            .inPage(),
        )}
      >
        {toElement(
          ScrollView(
            RawText(t('labelers.notFound', { defaultValue: 'Labeler not found.' }))
              .font('md')
              .foreground('muted'),
          ).contentView((v) => v.flex('1').justify('center').align('center')),
        )}
      </Screen>
    );
  }

  const body = (
    <>
      {/* Hero card */}
      {toElement(
        VStack(
          HStack(
            RawText(labeler.name)
              .font('xl')
              .leading('28px')
              .weight('bold')
              .foreground('foreground'),
            labeler.isOfficial
              ? officialBadge(t('labelers.official', { defaultValue: 'Official' }))
              : null,
          )
            .align('center')
            .spacing('sm')
            .wrap(),
          labeler.description
            ? RawText(labeler.description).font('md').leading('22px').foreground('muted')
            : null,
          HStack(
            HStack(
              Icon(RiGroupLine).size('14').foreground('muted'),
              RawText(
                labeler.subscriberCount,
                ' ',
                t('labelers.subscribers', { defaultValue: 'subscribers' }),
              )
                .font('sm')
                .foreground('muted'),
            )
              .align('center')
              .spacing('xs'),
            creatorName
              ? HStack(
                  Icon(RiUserLine).size('14').foreground('muted'),
                  RawText(t('labelers.by', { defaultValue: 'by' }), ' ', creatorName)
                    .font('sm')
                    .foreground('muted'),
                )
                  .align('center')
                  .spacing('xs')
              : null,
          )
            .wrap()
            .spacing('md'),
          Embed((render) => (
            <TouchableOpacity
              style={[
                styles.subscribeBtn,
                labeler.isSubscribed
                  ? {
                      borderColor: theme.colors.border,
                      backgroundColor: 'transparent',
                      borderWidth: 1,
                    }
                  : { backgroundColor: theme.colors.primary },
              ]}
              onPress={handleSubscribeToggle}
              disabled={subscribing}
              activeOpacity={0.7}
            >
              {render(
                subscribing
                  ? Loading().style('inline').size('sm')
                  : RawText(
                      labeler.isSubscribed
                        ? t('labelers.unsubscribe', { defaultValue: 'Unsubscribe' })
                        : t('labelers.subscribe', { defaultValue: 'Subscribe' }),
                    )
                      .font('md')
                      .weight('semibold')
                      .foreground(labeler.isSubscribed ? 'foreground' : 'white'),
              )}
            </TouchableOpacity>
          )),
        )
          .padding('all', 'lg')
          .background('mutedFill')
          .corner('lg')
          .spacing('md'),
      )}

      {/* Label definitions section */}
      {(labeler.labelDefinitions?.length ?? 0) > 0 && (
        <>
          {toElement(
            RawText(t('labelers.labelDefinitions', { defaultValue: 'Label Definitions' }))
              .padding('horizontal', 'xs')
              .font('sm')
              .weight('semibold')
              .textCase('uppercase')
              .tracking('wide')
              .margin('top', 'lg')
              .margin('bottom', 'xs')
              .foreground('muted'),
          )}

          {toElement(
            VStack(
              Embed(
                (labeler.labelDefinitions ?? []).map((ld, index) => {
                  const severity: Severity = ld.severity ?? 'low';
                  const currentAction: LabelAction =
                    labelActions[ld.slug] ?? ld.defaultAction ?? 'warn';

                  return (
                    <React.Fragment key={ld.slug}>
                      {index > 0 && toElement(LDivider().spacing('md'))}
                      {toElement(
                        VStack(
                          HStack(
                            RawText(ld.name)
                              .font('md')
                              .weight('semibold')
                              .flex('1')
                              .foreground('foreground'),
                            HStack(
                              Embed(<SeverityBadge severity={severity} />),
                              /* Same defect as the action chip above: an interpolated
                                            hex alpha on the `rgb(...)` primary token painted this
                                            badge solid primary under its own primary label. Tint
                                            and hairline are the primary at 10% and 25%. */ Embed(
                                (render) =>
                                  ld.defaultAction && (
                                    <View
                                      style={[
                                        styles.badge,
                                        {
                                          backgroundColor: withAlpha(theme.colors.primary, 0.1),
                                          borderColor: withAlpha(theme.colors.primary, 0.25),
                                        },
                                      ]}
                                    >
                                      {render(
                                        RawText(ld.defaultAction)
                                          .font('11')
                                          .weight('semibold')
                                          .foreground('primary'),
                                      )}
                                    </View>
                                  ),
                              ),
                            )
                              .spacing('6')
                              .align('center'),
                          )
                            .align('center')
                            .justify('between')
                            .spacing('sm'),
                          Embed(
                            <Text
                              style={[SLUG_STYLE, { color: theme.colors.textSecondary }]}
                              numberOfLines={1}
                            >
                              {ld.slug}
                            </Text>,
                          ),
                          ld.description
                            ? RawText(ld.description).font('sm').leading('18px').foreground('muted')
                            : null,
                          Embed(
                            <ActionChips
                              labelSlug={ld.slug}
                              labelerId={labelerId}
                              currentAction={currentAction}
                              isSubscribed={!!labeler.isSubscribed}
                              onActionChange={handleActionChange}
                            />,
                          ),
                        ).spacing('6'),
                      )}
                    </React.Fragment>
                  );
                }),
              ),
            )
              .padding('all', 'lg')
              .background('mutedFill')
              .corner('lg')
              .spacing('md'),
          )}
        </>
      )}

      {toElement(VStack().frame({ height: '4xl' }))}
    </>
  );

  return (
    <Screen
      header={toElement(
        Header(labeler.name)
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .inPage(),
      )}
    >
      <ScreenScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.primary}
          />
        }
      >
        {body}
      </ScreenScrollView>
    </Screen>
  );
};

export default LabelerDetailScreen;

const styles = StyleSheet.create({
  scrollContent: {
    padding: 16,
    gap: 8,
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
