import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { lanesService } from '@/services/lanesService';
import { noteLaneListsChanged } from '@/stores/laneInvalidation';
import { getErrorMessage } from '@/utils/apiError';
import type { MutedLane } from '@mention/shared-types';
import { toast } from '@oxy.so/bloom/toast';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { createLogger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button as LButton, Embed, Text, VStack, toElement } from '@oxy.so/bloom-language';
import {
  Admonition as LAdmonition,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
} from '@oxy.so/bloom-language/containers';
import { SettingsSection as LSettingsSection } from '@oxy.so/bloom-language/settings';

const mutedLanesLogger = createLogger('MutedLanes');

/**
 * The lanes this reader has silenced.
 *
 * Deliberately narrower than muted words, and the copy says so: a muted word is
 * a safety rule about content the reader must not be shown, so it applies in
 * search and notifications too. A muted lane is a TIMELINE preference — "don't
 * push me this track" — so it applies to feeds only, and opening the post or
 * searching for it still works. Suppressing a deliberate retrieval would just
 * make the product look broken.
 */
export default function MutedLanesScreen() {
  const { t } = useTranslation();

  const { isAuthenticated, user, canUsePrivateApi } = useAuth();
  const queryClient = useQueryClient();

  const mutedQueryKey = viewerQueryKeys.mutedLanes(user?.id);
  const {
    data: muted = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<MutedLane[]>({
    queryKey: mutedQueryKey,
    queryFn: () => lanesService.listMuted(),
    enabled: canUsePrivateApi,
  });

  const unmuteMutation = useMutation<void, unknown, string>({
    mutationFn: (laneId: string) => lanesService.unmute(laneId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mutedQueryKey });
      // Unmuting puts posts BACK into every feed this reader opens, which
      // is the same reach a mute had — so it is the same signal.
      noteLaneListsChanged('mute');
      toast(t('lanes.muted.unmuted', { defaultValue: 'Lane unmuted' }), {
        type: 'success',
      });
    },
    onError: (error) => {
      mutedLanesLogger.error('Failed to unmute lane', error);
      toast(
        getErrorMessage(
          error,
          t('lanes.muted.unmuteFailed', {
            defaultValue: 'Failed to unmute lane',
          }),
        ),
        { type: 'error' },
      );
    },
  });

  if (!isAuthenticated) {
    return toElement(
      VStack(
        Embed(
          <OxyAuthPrompt
            label={t('lanes.muted.signInRequired', {
              defaultValue: 'Sign in to manage muted lanes',
            })}
            description={t('lanes.muted.description', {
              defaultValue:
                'A muted lane stops appearing in your feeds. You keep following its author, and everything else they post still reaches you.',
            })}
          />,
        ),
      ).spacing('lg'),
    );
  }

  return toElement(
    VStack(
      VStack(
        VStack(
          LAdmonition(
            Text(
              t('lanes.muted.description', {
                defaultValue:
                  'A muted lane stops appearing in your feeds. You keep following its author, and everything else they post still reaches you.',
              }),
            ),
          ).style('info'),
        ).margin('bottom', 'lg'),
        LSettingsSection(
          t('lanes.muted.title', { defaultValue: 'Muted lanes' }),
          LGroupedSection(
            Embed(
              isLoading ? (
                <ListSkeleton />
              ) : isError ? (
                toElement(
                  VStack(
                    Embed(
                      <EmptyState
                        title={t('lanes.muted.loadFailed', {
                          defaultValue: 'Failed to load muted lanes',
                        })}
                        error={{
                          title: t('lanes.muted.loadFailed', {
                            defaultValue: 'Failed to load muted lanes',
                          }),
                          message: t('common.tryAgain', {
                            defaultValue: 'Try again',
                          }),
                          onRetry: async () => {
                            await refetch();
                          },
                        }}
                      />,
                    ),
                  ).padding('vertical', 'lg'),
                )
              ) : muted.length === 0 ? (
                toElement(
                  VStack(
                    Embed(
                      <EmptyState
                        title={t('lanes.muted.empty', {
                          defaultValue: 'No muted lanes',
                        })}
                        sticker="mutedLanes"
                      />,
                    ),
                  ).padding('vertical', 'lg'),
                )
              ) : (
                muted.map((entry) => {
                  // The publisher's handle comes from the canonical Oxy
                  // identity the server resolved; an owner that could not
                  // be resolved is dropped there, never rendered blank.
                  const handle = getNormalizedUserHandle(entry.owner) || '';
                  const row = LGroupedSectionItem(entry.lane.name).wrapControl();
                  return toElement(
                    (handle ? row.description(`@${handle}`) : row).trailing(
                      LButton(Text(t('lanes.muted.unmute', { defaultValue: 'Unmute' })))
                        .size('sm')
                        .style('subtle')
                        .tint('danger')
                        .onPress(() => unmuteMutation.mutate(entry.lane.id))
                        .label(
                          t('lanes.muted.unmute', {
                            defaultValue: 'Unmute',
                          }),
                        ),
                    ),
                    entry.lane.id,
                  );
                })
              ),
            ),
          ),
        ),
      ).spacing('lg'),
    ).spacing('lg'),
  );
}
