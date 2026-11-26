import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiShieldCheckLine } from '@oxy.so/bloom/icons/RiShieldCheckLine';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { useLocalSearchParams } from '@/lib/navigation/router';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from 'react-i18next';
import { labelerService } from '@/services/labelerService';
import type { Severity, LabelActionType } from '@/components/LabelBadge';
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
  Embed as LEmbed,
  ScrollView as LScrollView,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';

import { screen } from '@oxy.so/bloom-language/router';
const appColors = defineTokens({ color: { hexfff: '#fff' } });
/** An action chip's 5pt vertical padding and a badge's 7pt horizontal one, off the space scale. */
const labelerTokens = defineTokens({ space: { chipY: 5, badgeX: 7 } });

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

/**
 * Raw severity swatches. Module-local: exported, their inferred type names the
 * language's `AppColorToken`, which its entry does not export (TS2883).
 */
const severityTokens = defineTokens({
  color: {
    low: '#6b7280',
    medium: '#f59e0b',
    high: '#f97316',
    critical: '#ef4444',
  },
});

/** A label's severity: the word in its swatch, on the swatch at 12.5% (hex `20`) inside a 31.4% (hex `50`) hairline. */
function severityBadge(severity: Severity) {
  const color = severityTokens.color[severity] ?? severityTokens.color.low;
  return VStack(
    RawText(severity.charAt(0).toUpperCase() + severity.slice(1))
      .font('11')
      .weight('semibold')
      .foreground(color),
  )
    .padding('horizontal', labelerTokens.space.badgeX)
    .padding('vertical', '2xs')
    .background(color.opacity('12.5'))
    .border(color.opacity('31.4'), 'thin')
    .corner('6');
}

interface ActionChipsProps {
  labelSlug: string;
  labelerId: string;
  currentAction: LabelAction;
  isSubscribed: boolean;
  onActionChange: (labelSlug: string, action: LabelAction) => void;
}

const ActionChips = React.memo(
  ({ labelSlug, currentAction, isSubscribed, onActionChange }: ActionChipsProps) => {
    const { t } = useTranslation();

    if (!isSubscribed) return null;

    return toElement(
      HStack(
        ACTION_OPTIONS_CONFIG.map(({ value, labelKey }) => {
          const isActive = currentAction === value;
          return (
            VStack(
              RawText(t(labelKey))
                .font('xs')
                .leading('16px')
                .weight('semibold')
                .foreground(isActive ? 'primary' : 'muted'),
            )
              .padding('horizontal', 'md')
              .padding('vertical', labelerTokens.space.chipY)
              // The active fill is the primary at 10% (`withAlpha`), NOT
              // `${theme.colors.primary}18`: that token resolves to `rgb(0 98 157)`, so the
              // hex-alpha suffix is a malformed colour react-native-web reads as fully
              // opaque — the chip painted solid primary under its own primary label, so
              // the selected action was the one word you could not read.
              .when(isActive, (v) => v.background('primary/10'))
              .border(isActive ? 'primary' : 'border', 'thin')
              .corner('xl')
              .onPress(() => onActionChange(labelSlug, value))
              .pressFade('70')
              .id(value)
          );
        }),
      )
        .spacing('6')
        .margin('top', 'xs')
        .wrap(),
    );
  },
);

ActionChips.displayName = 'ActionChips';

export default screen(function LabelerDetailScreen() {
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
    return ScrollView(Embed(<DetailSkeleton />)).header(
      Header(t('labelers.detailTitle', { defaultValue: 'Labeler' }))
        .backLabel(t('common.back', { defaultValue: 'Back' }))
        .inPage(),
    );
  }

  if (!labeler) {
    return ScrollView(
      RawText(t('labelers.notFound', { defaultValue: 'Labeler not found.' }))
        .font('md')
        .foreground('muted'),
    )
      .contentView((v) => v.flex('1').justify('center').align('center'))
      .header(
        Header(t('labelers.detailTitle', { defaultValue: 'Labeler' }))
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .inPage(),
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
          VStack(
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
          )
            .align('center')
            .justify('center')
            .padding('vertical', '10')
            .frame({ minHeight: '4xl' })
            .background(labeler.isSubscribed ? 'transparent' : 'primary')
            .when(labeler.isSubscribed === true, (v) => v.border('border', 'thin'))
            .corner('xl')
            .disabled(subscribing)
            .onPress(handleSubscribeToggle)
            .pressFade('70'),
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
                              severityBadge(severity),
                              // Same defect as the action chip above: an interpolated
                              // hex alpha on the `rgb(...)` primary token painted this
                              // badge solid primary under its own primary label. Tint
                              // and hairline are the primary at 10% and 25%.
                              ld.defaultAction
                                ? VStack(
                                    RawText(ld.defaultAction)
                                      .font('11')
                                      .weight('semibold')
                                      .foreground('primary'),
                                  )
                                    .padding('horizontal', labelerTokens.space.badgeX)
                                    .padding('vertical', '2xs')
                                    .background('primary/10')
                                    .border('primary/25', 'thin')
                                    .corner('6')
                                : null,
                            )
                              .spacing('6')
                              .align('center'),
                          )
                            .align('center')
                            .justify('between')
                            .spacing('sm'),
                          // A label's slug: 12/16, the platform's monospace on native (the web drew the inherited face).
                          RawText(ld.slug)
                            .font('xs')
                            .leading('16px')
                            .when('native', (v) => v.font('system-mono'))
                            .foreground('muted')
                            .lines(1),
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

  // The pull's spinner is tinted on iOS only (`tintColor`), so the scroller stays Bloom's.
  return Embed(
    LtoElement(
      LScrollView(LEmbed(body))
        .contentMargins('lg')
        .spacing('sm')
        .refreshable({ refreshing: refreshing, onRefresh: onRefresh }, { ios: 'primary' }),
    ),
  ).header(
    Header(labeler.name)
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .inPage(),
  );
});
