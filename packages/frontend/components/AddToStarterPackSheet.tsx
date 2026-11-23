import { tokens } from '@oxy.so/bloom/styles';
import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useCallback, useMemo, useState } from 'react';
import { Platform, TouchableOpacity, ScrollView, type ViewStyle } from 'react-native';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { useRouter } from '@/lib/navigation/router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@oxy.so/bloom/toast';
import { useColorTokens } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { starterPacksService, type StarterPackCollection } from '@/services/starterPacksService';
import { createLogger } from '@oxy.so/core/logger';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { RiRocket2Line } from '@oxy.so/bloom/icons/RiRocket2Line';

import {
  Checkbox as LCheckbox,
  Embed,
  HStack,
  Icon,
  RawText,
  SpinnerIcon,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';
import {
  Embed as LEmbed,
  VStack as LVStack,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';
const appColors = defineTokens({ color: { hexfff: '#fff' } });

// Tailwind's `rounded-full` as NativeWind drew it on a TouchableOpacity, which the
// language has no node for (its press fades the row's opacity).
const PILL_RADIUS = Platform.OS === 'web' ? 'calc(infinity * 1px)' : 9007199254740000;
const touchables = {
  create: { borderRadius: PILL_RADIUS, paddingHorizontal: 20, paddingVertical: 10 },
  // Tailwind's `flex-1`: grow, shrink and a 0% basis.
  rowLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  newRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
} satisfies Record<string, ViewStyle>;

const logger = createLogger('AddToStarterPackSheet');

/**
 * React Query cache key for the viewer's own (editable) starter packs. This
 * sheet is the React Query owner of the viewer's pack membership: it fetches the
 * list, updates it optimistically on add/remove toggle, and revalidates on
 * success. The create screen (`/starter-packs/create`) imports this key and
 * invalidates it after creating a pack, so a freshly created pack shows up the
 * next time the sheet opens — which is why the query can inherit the global
 * 5-min staleTime instead of forcing `staleTime: 0` (a refetch on every open).
 */
interface PackRow {
  id: string;
  name: string;
  hasUser: boolean;
  /** Toggle is in flight; the row is disabled and shows a spinner. */
  pending: boolean;
}

interface AddToStarterPackSheetProps {
  /** Oxy user id of the target the viewer is adding/removing from packs. */
  targetUserId: string;
  /** Display handle/name used in toast feedback. */
  targetLabel?: string;
  /** Dismiss the containing bottom sheet. */
  onClose: () => void;
}

/** Best-effort extraction of a server-authored error message (e.g. the 150-member cap). */
function readServerError(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { data?: { error?: unknown } } }).response;
    const message = response?.data?.error;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
  }
  return undefined;
}

/**
 * Bottom-sheet content that lets the viewer add/remove a user to/from their own
 * starter packs. Opened from another user's profile overflow menu. Membership
 * toggles go through `starterPacksService`; the viewer's packs are owned by a
 * React Query cache that is updated optimistically and revalidated on success.
 * Mirrors `AddToListSheet`'s UX (toggle rows, optimistic state, toasts).
 */
export function AddToStarterPackSheet({
  targetUserId,
  targetLabel,
  onClose,
}: AddToStarterPackSheetProps) {
  const router = useRouter();
  const colors = useColorTokens();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { user, canUsePrivateApi } = useAuth();
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  // Account-scoped cache key: prevents the previous account's packs from leaking
  // after a switch. The create screen uses this same central factory entry, so
  // a new pack invalidates the exact viewer-owned collection.
  const packsQueryKey = useMemo(() => viewerQueryKeys.starterPacksMine(user?.id), [user?.id]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: packsQueryKey,
    queryFn: () => starterPacksService.list({ mine: true }),
    enabled: canUsePrivateApi,
  });

  const label = useMemo(
    () => targetLabel || t('starterPacks.addTo.thisUser', { defaultValue: 'this user' }),
    [targetLabel, t],
  );

  const rows = useMemo<PackRow[]>(() => {
    const items = data?.items ?? [];
    return items
      .map((p) => {
        const id = String(p._id ?? p.id ?? '');
        const members = Array.isArray(p.memberOxyUserIds) ? p.memberOxyUserIds.map(String) : [];
        return {
          id,
          name:
            typeof p.name === 'string' && p.name
              ? p.name
              : t('starterPacks.addTo.untitled', { defaultValue: 'Untitled Pack' }),
          hasUser: members.includes(String(targetUserId)),
          pending: pendingIds.has(id),
        };
      })
      .filter((r) => r.id.length > 0);
  }, [data, pendingIds, targetUserId, t]);

  const toggle = useCallback(
    async (row: PackRow) => {
      if (row.pending) return;
      const willAdd = !row.hasUser;
      const previous = queryClient.getQueryData<StarterPackCollection>(packsQueryKey);

      // Optimistic: flip membership in the cache and disable the row.
      setPendingIds((prev) => new Set(prev).add(row.id));
      queryClient.setQueryData<StarterPackCollection>(packsQueryKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((it) => {
            if (String(it._id ?? it.id ?? '') !== row.id) return it;
            const members = (Array.isArray(it.memberOxyUserIds) ? it.memberOxyUserIds : []).map(
              String,
            );
            return {
              ...it,
              memberOxyUserIds: willAdd
                ? Array.from(new Set([...members, String(targetUserId)]))
                : members.filter((m) => m !== String(targetUserId)),
            };
          }),
        };
      });

      try {
        if (willAdd) {
          await starterPacksService.addMembers(row.id, [String(targetUserId)]);
          toast(
            t('starterPacks.addTo.added', { pack: row.name, defaultValue: `Added to ${row.name}` }),
            { type: 'success' },
          );
        } else {
          await starterPacksService.removeMembers(row.id, [String(targetUserId)]);
          toast(
            t('starterPacks.addTo.removed', {
              pack: row.name,
              defaultValue: `Removed from ${row.name}`,
            }),
            { type: 'success' },
          );
        }
        // Revalidate against server truth after a successful membership change.
        queryClient.invalidateQueries({ queryKey: packsQueryKey });
      } catch (e) {
        logger.error('Starter pack membership toggle failed', e);
        // Revert optimistic cache state.
        if (previous) queryClient.setQueryData(packsQueryKey, previous);
        toast(
          readServerError(e) ??
            t('starterPacks.addTo.toggleFailed', { defaultValue: 'Something went wrong' }),
          { type: 'error' },
        );
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(row.id);
          return next;
        });
      }
    },
    [queryClient, targetUserId, t, packsQueryKey],
  );

  const goCreate = useCallback(() => {
    onClose();
    router.push('/starter-packs/create');
  }, [onClose, router]);

  return toElement(
    VStack(
      HStack(
        RawText(
          t('starterPacks.addTo.title', {
            user: label,
            defaultValue: `Add ${label} to starter pack`,
          }),
        )
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
        isLoading ? (
          <ListSkeleton />
        ) : isError ? (
          toElement(
            VStack(
              RawText(
                t('starterPacks.addTo.loadError', {
                  defaultValue: 'Could not load your starter packs',
                }),
              )
                .foreground('muted')
                .font('14')
                .leading('20px')
                .textAlign('center'),
              Embed(
                LtoElement(
                  LVStack(
                    LEmbed(
                      toElement(
                        RawText(t('common.retry', { defaultValue: 'Try again' }))
                          .foreground('primary')
                          .font('14')
                          .leading('20px')
                          .weight('semibold'),
                      ),
                    ),
                  )
                    .onPress(() => refetch())
                    .pressFade(),
                ),
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
              Icon(RiRocket2Line).size('40').foreground('muted'),
              RawText(
                t('starterPacks.addTo.empty', { defaultValue: 'You have no starter packs yet' }),
              )
                .foreground('muted')
                .font('14')
                .leading('20px')
                .textAlign('center'),
              Embed(
                <TouchableOpacity
                  onPress={goCreate}
                  style={[touchables.create, { backgroundColor: colors.primary }]}
                >
                  {toElement(
                    RawText(t('starterPacks.create', { defaultValue: 'Create starter pack' }))
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
                      style={touchables.rowLabel}
                      onPress={() => toggle(row)}
                      disabled={row.pending}
                      activeOpacity={0.7}
                      accessible={false}
                    >
                      {toElement(
                        VStack(Icon(RiRocket2Line).size('18').foreground('foreground'))
                          .frame({ width: '36', height: '36' })
                          .background('mutedFill')
                          .corner('lg')
                          .align('center')
                          .justify('center'),
                      )}
                      {toElement(
                        RawText(row.name)
                          .foreground('foreground')
                          .font('md')
                          .weight('medium')
                          .flex('1')
                          .lines(1),
                      )}
                    </TouchableOpacity>,
                  ),
                  row.pending
                    ? SpinnerIcon().size('18').tint('primary')
                    : LCheckbox([row.hasUser, () => toggle(row)])
                        .size('lg')
                        .label(row.name),
                )
                  .padding('vertical', 'md')
                  .border('border', 'thin', 'bottom')
                  .align('center')
                  .justify('between'),
                row.id,
              ),
            )}

            <TouchableOpacity
              style={touchables.newRow}
              onPress={goCreate}
              activeOpacity={0.7}
              accessibilityRole="button"
            >
              {toElement(
                VStack(Icon(RiAddLine).size('md').foreground(appColors.color.hexfff))
                  .frame({ width: '36', height: '36' })
                  .background('primary')
                  .corner('lg')
                  .align('center')
                  .justify('center'),
              )}
              {toElement(
                RawText(t('starterPacks.addTo.newPack', { defaultValue: 'New starter pack' }))
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
