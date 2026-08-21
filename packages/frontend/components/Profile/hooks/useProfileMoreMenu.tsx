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
  /**
   * Whether the viewer OPERATES this account — may speak with its voice. Being
   * the account is one case of it; running a channel, organization, project or
   * bot is the rest. Callers compute it as
   * `isOwnProfile || useOperatesAccount(...)`, never as an id comparison alone.
   */
  viewerOperatesAccount: boolean;
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
 * Shared by both profile screens because it is about the VIEWER's relationship to
 * an account, and that relationship has the same shape whichever kind of account
 * it is. What differs is what an OPERATOR may additionally do, which arrives as
 * {@link ProfileMoreMenuOptions.leadingActions} rather than as a branch in here.
 *
 * ## Mute, block and report are withheld from an operator
 *
 * Not because they would fail, but because they mean nothing: all three are ways
 * of putting distance between a reader and an account, and there is no distance
 * to put between somebody and an account they publish as. Muting hides your own
 * posts from your own feeds; blocking severs you from something you are; a report
 * asks a jury to rule on whether you should be enforced against for what you
 * wrote.
 *
 * The check is "do I operate this account?", not "is this account me?". The
 * second is the same question asked narrowly enough to be wrong — a channel,
 * organization, project or bot is never the viewer's own id — and asking it is
 * what put Block and Report in a channel operator's menu. Note the whole menu is
 * NOT suppressed for an operator the way it used to be for your own profile: a
 * channel's operator opens it to reach the channel's settings.
 *
 * Nothing replaces the withheld rows. An operator's own actions are the caller's
 * to supply through `leadingActions` — the channel screen supplies "Channel
 * settings" — and the kinds with no operator surface in Mention get a shorter
 * menu rather than a row that goes nowhere.
 *
 * What is deliberately KEPT for an operator: add/remove from lists and starter
 * packs. Both are curation of the viewer's own collections, and putting an
 * account you run into a starter pack you assembled is the ordinary use of one,
 * not an accident.
 */
export function useProfileMoreMenu({
  profileData,
  viewerOperatesAccount,
  leadingActions,
}: ProfileMoreMenuOptions): () => void {
  const theme = useTheme();
  const { t } = useTranslation();
  const { oxyServices } = useAuth();
  const bottomSheet = useContext(BottomSheetContext);

  return useCallback(() => {
    if (!profileData) return;

    const displayUsername = profileData.username;

    const handleMute = async () => {
      const success = await muteService.muteUser(profileData.id);
      if (success) {
        toast(
          t('profile.muted', {
            username: displayUsername,
            defaultValue: '@{{username}} has been muted',
          }),
          { type: 'success' },
        );
      } else {
        toast(t('profile.muteFailed', { defaultValue: 'Failed to mute user' }), { type: 'error' });
      }
    };

    const handleBlock = async () => {
      const confirmed = await confirmDialog({
        title: t('profile.blockUser', { username: displayUsername, defaultValue: 'Block @{{username}}' }),
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
            defaultValue: '@{{username}} has been blocked',
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
      ...(viewerOperatesAccount
        ? []
        : [
          {
            icon: <MuteIcon size={22} className="text-foreground" />,
            label: t('profile.muteUser', {
              username: displayUsername,
              defaultValue: 'Mute @{{username}}',
            }),
            onPress: handleMute,
          },
        ]),
    ];

    const destructiveActions: ActionMenuAction[] = viewerOperatesAccount
      ? []
      : [
        {
          icon: <BlockIcon size={22} color={theme.colors.error} />,
          label: t('profile.blockUser', {
            username: displayUsername,
            defaultValue: 'Block @{{username}}',
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
          defaultValue: 'Options for @{{username}}',
        }),
        groups: [actions, destructiveActions],
      });
    }

    openMenu();
  }, [profileData, viewerOperatesAccount, leadingActions, theme, t, bottomSheet, oxyServices]);
}
