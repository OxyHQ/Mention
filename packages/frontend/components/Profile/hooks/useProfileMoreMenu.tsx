import React, { useCallback, useContext } from 'react';
import { toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services/ui/client';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { showActionMenu } from '@/components/common/ActionMenu';
import type { ActionMenuAction } from '@/components/common/actionMenuGroups';
import { ReportModal } from '@/components/report/ReportModal';
import { AddToListSheet } from '@/components/Lists/AddToListSheet';
import { AddToStarterPackSheet } from '@/components/AddToStarterPackSheet';
import { muteService } from '@/services/muteService';
import { reportService } from '@/services/reportService';
import { confirmDialog } from '@/utils/alerts';
import { List as ListIcon } from '@/assets/icons/list-icon';
import { StarterPackIcon } from '@/assets/icons/starter-pack-icon';
import { MuteIcon } from '@/assets/icons/mute-icon';
import { BlockIcon } from '@/assets/icons/block-icon';
import { ReportIcon } from '@/assets/icons/report-icon';
import type { ProfileData } from '@/hooks/useProfileData';

export interface ProfileMoreMenuOptions {
  profileData: ProfileData | null;
  isOwnProfile: boolean;
  /**
   * Rows shown ABOVE the shared ones, for actions that are about RUNNING this
   * account rather than about the viewer's relationship to it. A channel's
   * operator gets its settings here; everybody else never sees a row that would
   * refuse them.
   */
  leadingActions?: ActionMenuAction[];
}

/**
 * The "…" menu on a profile: add to lists / starter packs, mute, block, report.
 *
 * Shared by both profile screens because it is entirely about the VIEWER's
 * relationship to an account, and that relationship does not change shape when
 * the account is a channel — a channel can be listed, muted, blocked and
 * reported exactly like anybody else. What differs is what an OPERATOR may
 * additionally do, which arrives as {@link ProfileMoreMenuOptions.leadingActions}
 * rather than as a branch in here.
 */
export function useProfileMoreMenu({
  profileData,
  isOwnProfile,
  leadingActions,
}: ProfileMoreMenuOptions): () => void {
  const theme = useTheme();
  const { t } = useTranslation();
  const { oxyServices } = useAuth();
  const bottomSheet = useContext(BottomSheetContext);

  return useCallback(() => {
    if (!profileData || isOwnProfile) return;

    const displayUsername = profileData.username;

    const handleMute = async () => {
      const success = await muteService.muteUser(profileData.id);
      if (success) {
        toast(
          t('profile.muted', {
            username: displayUsername,
            defaultValue: `@${displayUsername} has been muted`,
          }),
          { type: 'success' },
        );
      } else {
        toast(t('profile.muteFailed', { defaultValue: 'Failed to mute user' }), { type: 'error' });
      }
    };

    const handleBlock = async () => {
      const confirmed = await confirmDialog({
        title: t('profile.blockUser', { defaultValue: `Block @${displayUsername}` }),
        message: t('profile.blockConfirm', {
          username: displayUsername,
          defaultValue: `They won't be able to find your profile, posts, or mentions. They won't be notified that you blocked them.`,
        }),
        okText: t('profile.block', { defaultValue: 'Block' }),
        cancelText: t('common.cancel', { defaultValue: 'Cancel' }),
        destructive: true,
      });
      // Backing out of the confirm returns to where it was opened from — the
      // menu — instead of dumping the user back on the profile with nothing to
      // show for the trip.
      if (!confirmed) {
        openMenu();
        return;
      }
      try {
        await oxyServices.blockUser(profileData.id);
        toast(
          t('profile.blocked', {
            username: displayUsername,
            defaultValue: `@${displayUsername} has been blocked`,
          }),
          { type: 'success' },
        );
      } catch {
        toast(t('profile.blockFailed', { defaultValue: 'Failed to block user' }), { type: 'error' });
      }
    };

    const handleReport = () => {
      bottomSheet.setBottomSheetContent(
        <ReportModal
          visible={true}
          onClose={() => bottomSheet.openBottomSheet(false)}
          onSubmit={async (categories, details) => {
            const success = await reportService.reportUser(profileData.id, categories, details);
            if (success) {
              toast(
                t('report.thankYou', {
                  defaultValue: 'Thank you for helping keep our community safe.',
                }),
                { type: 'success' },
              );
            } else {
              toast(t('report.failed', { defaultValue: 'Failed to submit report.' }), {
                type: 'error',
              });
            }
          }}
        />,
      );
      bottomSheet.openBottomSheet(true);
    };

    const handleAddToList = () => {
      bottomSheet.setBottomSheetContent(
        <AddToListSheet
          targetUserId={profileData.id}
          targetLabel={`@${displayUsername}`}
          onClose={() => bottomSheet.openBottomSheet(false)}
        />,
      );
      bottomSheet.openBottomSheet(true);
    };

    const handleAddToStarterPack = () => {
      bottomSheet.setBottomSheetContent(
        <AddToStarterPackSheet
          targetUserId={profileData.id}
          targetLabel={`@${displayUsername}`}
          onClose={() => bottomSheet.openBottomSheet(false)}
        />,
      );
      bottomSheet.openBottomSheet(true);
    };

    const actions: ActionMenuAction[] = [
      ...(leadingActions ?? []),
      {
        icon: <ListIcon size={22} className="text-foreground" />,
        label: t('lists.addTo.menuItem', { defaultValue: 'Add/remove from lists' }),
        onPress: handleAddToList,
      },
      {
        icon: <StarterPackIcon size={22} className="text-foreground" />,
        label: t('starterPacks.addTo.menuItem', {
          defaultValue: 'Add/remove from starter packs',
        }),
        onPress: handleAddToStarterPack,
      },
      {
        icon: <MuteIcon size={22} className="text-foreground" />,
        label: t('profile.muteUser', {
          username: displayUsername,
          defaultValue: `Mute @${displayUsername}`,
        }),
        onPress: handleMute,
      },
    ];

    const destructiveActions: ActionMenuAction[] = [
      {
        icon: <BlockIcon size={22} color={theme.colors.error} />,
        label: t('profile.blockUser', {
          username: displayUsername,
          defaultValue: `Block @${displayUsername}`,
        }),
        onPress: handleBlock,
        color: theme.colors.error,
      },
      {
        icon: <ReportIcon size={22} color={theme.colors.error} />,
        label: t('profile.reportUser', { defaultValue: 'Report' }),
        onPress: handleReport,
        color: theme.colors.error,
      },
    ];

    // Named so the block flow can reopen the exact same menu after a cancelled
    // confirm.
    function openMenu() {
      showActionMenu({
        label: t('profile.moreOptions', {
          username: displayUsername,
          defaultValue: `Options for @${displayUsername}`,
        }),
        groups: [actions, destructiveActions],
      });
    }

    openMenu();
  }, [profileData, isOwnProfile, leadingActions, theme, t, bottomSheet, oxyServices]);
}
