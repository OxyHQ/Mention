import { tokens } from '@oxy.so/bloom/styles';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, TouchableOpacity, ScrollView } from 'react-native';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiListUnordered } from '@oxy.so/bloom/icons/RiListUnordered';
import { useRouter } from '@/lib/navigation/router';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { listsService } from '@/services/listsService';
import { createLogger } from '@oxy.so/core/logger';

import {
  Checkbox as LCheckbox,
  Embed,
  HStack,
  Icon,
  RawText,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';
const appColors = defineTokens({ color: { hexfff: '#fff' } });

const logger = createLogger('AddToListSheet');

interface ListRow {
  id: string;
  title: string;
  hasUser: boolean;
  /** Toggle is in flight; the row is disabled and shows a spinner. */
  pending: boolean;
}

interface AddToListSheetProps {
  /** Oxy user id of the target the user is adding/removing from lists. */
  targetUserId: string;
  /** Display handle/name used in toast feedback. */
  targetLabel?: string;
  /** Dismiss the containing bottom sheet. */
  onClose: () => void;
}

function extractMemberIds(list: unknown): string[] {
  const members = (list as { memberOxyUserIds?: unknown })?.memberOxyUserIds;
  return Array.isArray(members) ? members.map((m) => String(m)) : [];
}

/**
 * Bottom-sheet content that lets the viewer add/remove a user to/from their own
 * custom lists. Opened from a profile's overflow menu and from a post's action
 * menu. Membership toggles go through `listsService`, which broadcasts the
 * change so list-backed feeds refresh automatically.
 */
export function AddToListSheet({ targetUserId, targetLabel, onClose }: AddToListSheetProps) {
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();
  const [rows, setRows] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listsService.list({ mine: true });
      const items = Array.isArray(res?.items) ? res.items : [];
      const next: ListRow[] = items
        .map((l: Record<string, unknown>) => {
          const id = String(l._id ?? l.id ?? '');
          return {
            id,
            title: typeof l.title === 'string' && l.title ? l.title : 'Untitled List',
            hasUser: extractMemberIds(l).includes(String(targetUserId)),
            pending: false,
          };
        })
        .filter((r) => r.id.length > 0);
      setRows(next);
    } catch (e) {
      logger.warn('Failed to load lists', { error: e });
      setError(t('lists.addTo.loadError', { defaultValue: 'Could not load your lists' }));
    } finally {
      setLoading(false);
    }
  }, [targetUserId, t]);

  useEffect(() => {
    load();
  }, [load]);

  const label = useMemo(
    () => targetLabel || t('lists.addTo.thisUser', { defaultValue: 'this user' }),
    [targetLabel, t],
  );

  const toggle = useCallback(
    async (row: ListRow) => {
      if (row.pending) return;
      const willAdd = !row.hasUser;

      // Optimistic update.
      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, hasUser: willAdd, pending: true } : r)),
      );

      try {
        if (willAdd) {
          await listsService.addMembers(row.id, [String(targetUserId)]);
          toast(
            t('lists.addTo.added', { list: row.title, defaultValue: `Added to ${row.title}` }),
            { type: 'success' },
          );
        } else {
          await listsService.removeMembers(row.id, [String(targetUserId)]);
          toast(
            t('lists.addTo.removed', {
              list: row.title,
              defaultValue: `Removed from ${row.title}`,
            }),
            { type: 'success' },
          );
        }
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, pending: false } : r)));
      } catch (e) {
        logger.error('List membership toggle failed', e);
        // Revert optimistic state.
        setRows((prev) =>
          prev.map((r) => (r.id === row.id ? { ...r, hasUser: !willAdd, pending: false } : r)),
        );
        toast(t('lists.addTo.toggleFailed', { defaultValue: 'Something went wrong' }), {
          type: 'error',
        });
      }
    },
    [targetUserId, t],
  );

  const goCreate = useCallback(() => {
    onClose();
    router.push('/lists/create');
  }, [onClose, router]);

  return toElement(
    VStack(
      HStack(
        RawText(t('lists.addTo.title', { user: label, defaultValue: `Add ${label} to list` }))
          .foreground('foreground')
          .font('18')
          .leading('28px')
          .weight('bold'),
        Embed(
          <TouchableOpacity
            onPress={onClose}
            hitSlop={tokens.hitSlop.md}
            accessibilityRole="button"
            accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
          >
            {toElement(Icon(RiCloseLine).size('22').foreground('muted'))}
          </TouchableOpacity>,
        ),
      )
        .align('center')
        .justify('between')
        .margin('bottom', 'xs'),
      Embed(
        loading ? (
          <ListSkeleton />
        ) : error ? (
          toElement(
            VStack(
              RawText(error).foreground('muted').font('14').leading('20px').textAlign('center'),
              Embed(
                <TouchableOpacity onPress={load}>
                  {toElement(
                    RawText(t('common.retry', { defaultValue: 'Try again' }))
                      .foreground('primary')
                      .font('14')
                      .leading('20px')
                      .weight('semibold'),
                  )}
                </TouchableOpacity>,
              ),
            )
              .padding('vertical', '3xl')
              .align('center')
              .justify('center')
              .spacing('md'),
          )
        ) : rows.length === 0 ? (
          toElement(
            VStack(
              Icon(RiListUnordered).size('40').foreground('muted'),
              RawText(t('lists.addTo.empty', { defaultValue: 'You have no lists yet' }))
                .foreground('muted')
                .font('14')
                .leading('20px')
                .textAlign('center'),
              Embed(
                <TouchableOpacity
                  onPress={goCreate}
                  className="bg-primary rounded-full px-5 py-2.5"
                >
                  {toElement(
                    RawText(t('lists.createList', { defaultValue: 'Create list' }))
                      .foreground('onPrimary')
                      .font('14')
                      .leading('20px')
                      .weight('semibold'),
                  )}
                </TouchableOpacity>,
              ),
            )
              .padding('vertical', '3xl')
              .align('center')
              .justify('center')
              .spacing('md'),
          )
        ) : (
          <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false}>
            {rows.map((row) =>
              toElement(
                HStack(
                  /* The label area and the checkbox are SIBLINGS, never one inside
                          the other: a pressable row wrapping Bloom's Checkbox is a
                          button inside a button on web, and a click on the box would
                          toggle twice. The box carries the accessible name; the label
                          area is only a bigger touch target for the same toggle. */ Embed(
                    <TouchableOpacity
                      className="flex-row items-center gap-3 flex-1"
                      onPress={() => toggle(row)}
                      disabled={row.pending}
                      activeOpacity={0.7}
                      accessible={false}
                    >
                      <View className="w-9 h-9 rounded-lg items-center justify-center bg-muted">
                        {toElement(Icon(RiListUnordered).size('18').foreground('foreground'))}
                      </View>
                      {toElement(
                        RawText(row.title)
                          .foreground('foreground')
                          .font('md')
                          .weight('medium')
                          .flex('1')
                          .lines(1),
                      )}
                    </TouchableOpacity>,
                  ),
                  Embed(
                    row.pending ? (
                      <SpinnerIcon size={18} className="text-primary" />
                    ) : (
                      toElement(
                        LCheckbox([row.hasUser, () => toggle(row)])
                          .size('lg')
                          .label(row.title),
                      )
                    ),
                  ),
                )
                  .padding('vertical', 'md')
                  .border('border', 'thin', 'bottom')
                  .align('center')
                  .justify('between'),
                row.id,
              ),
            )}

            <TouchableOpacity
              className="flex-row items-center gap-3 py-3.5"
              onPress={goCreate}
              activeOpacity={0.7}
              accessibilityRole="button"
            >
              <View className="w-9 h-9 rounded-lg items-center justify-center bg-primary">
                {toElement(Icon(RiAddLine).size('md').foreground(appColors.color.hexfff))}
              </View>
              {toElement(
                RawText(t('lists.addTo.newList', { defaultValue: 'New list' }))
                  .foreground('primary')
                  .font('md')
                  .weight('semibold'),
              )}
            </TouchableOpacity>
          </ScrollView>
        ),
      ),
    )
      .padding('horizontal', 'lg')
      .padding('top', 'md')
      .padding('bottom', 'sm')
      .background('background'),
  );
}
