import { useContext, type ReactElement, type ReactNode } from 'react';
import { toast } from '@oxy.so/bloom/toast';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { ReportModal } from '@/components/report/ReportModal';
import { AddToListSheet } from '@/components/Lists/AddToListSheet';
import { AddToStarterPackSheet } from '@/components/AddToStarterPackSheet';
import { muteService } from '@/services/muteService';
import { refreshPrivacyLists } from '@/services/privacyService';
import { setPrivacyListMembership } from '@/hooks/usePrivacyControls';
import { reportService } from '@/services/reportService';
import { confirmDialog } from '@/utils/alerts';
import { List as ListIcon } from '@/assets/icons/list-icon';
import { StarterPackIcon } from '@/assets/icons/starter-pack-icon';
import { MuteIcon } from '@/assets/icons/mute-icon';
import { BlockIcon } from '@/assets/icons/block-icon';
import { ReportIcon } from '@/assets/icons/report-icon';
import type { ProfileData } from '@/hooks/useProfileData';

/** What the profile's "…" button needs: the menu's name and its groups, built on open. */
export interface ProfileMoreMenuProps {
  profileData: ProfileData | null;
  /**
   * Whether the viewer OPERATES this account — may speak with its voice. Being
   * the account is one case of it; running a channel, organization, project or
   * bot is the rest. Callers compute it as
   * `isOwnProfile || useOperatesAccount(...)`, never as an id comparison alone.
   */
  viewerOperatesAccount: boolean;
  /**
   * `DropdownMenuItem`s shown ABOVE the shared ones, for actions that are about
   * RUNNING this account rather than about the viewer's relationship to it. A
   * channel's operator gets its settings here; everybody else never sees a row
   * that would refuse them.
   */
  leadingItems?: ReactNode;
  /** The "…" button that opens the menu. */
  children: ReactElement;
}

/**
 * The "…" menu on a profile (Bloom's `DropdownMenu` around the caller's button): add to lists / starter packs, mute, block, report.
 *
 * Shared by both profile screens because it is about the VIEWER's relationship to
 * an account, and that relationship has the same shape whichever kind of account
 * it is. What differs is what an OPERATOR may additionally do, which arrives as
 * {@link ProfileMoreMenuProps.leadingItems} rather than as a branch in here.
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
 * to supply through `leadingItems` — the channel screen supplies "Channel
 * settings" — and the kinds with no operator surface in Mention get a shorter
 * menu rather than a row that goes nowhere.
 *
 * What is deliberately KEPT for an operator: add/remove from lists and starter
 * packs. Both are curation of the viewer's own collections, and putting an
 * account you run into a starter pack you assembled is the ordinary use of one,
 * not an accident.
 *
 * ## Signed out, there is no menu
 *
 * Every shared row is a write on the viewer's own account — their lists, their
 * starter packs, their mutes and blocks, a report filed in their name — so
 * without a session each one could only answer 401 (#1126). They are gated on
 * `canUsePrivateApi`, never bare `isAuthenticated`, and when that leaves
 * nothing to offer the component renders nothing, so no "…" button opens an empty menu.
 */
export function ProfileMoreMenu({
  profileData,
  viewerOperatesAccount,
  leadingItems,
  children,
}: ProfileMoreMenuProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { oxyServices, canUsePrivateApi, user } = useAuth();
  const bottomSheet = useContext(BottomSheetContext);

  if (!profileData || (!canUsePrivateApi && !leadingItems)) return null;

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
      title: t('profile.blockUser', {
        username: displayUsername,
        defaultValue: 'Block @{{username}}',
      }),
      message: t('profile.blockConfirm', {
        username: displayUsername,
        defaultValue: `They won't be able to find your profile, posts, or mentions. They won't be notified that you blocked them.`,
      }),
      okText: t('profile.block', { defaultValue: 'Block' }),
      cancelText: t('common.cancel', { defaultValue: 'Cancel' }),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await oxyServices.privacy.block(profileData.id);
      // The block is written in Oxy; Mention caches the viewer's blocked list
      // per request window, so tell it to drop that entry or the feed keeps
      // showing the blocked account until the window expires. Best-effort —
      // the block itself has already succeeded.
      await refreshPrivacyLists();
      setPrivacyListMembership(user?.id, 'blocked', profileData.id, true);
      toast(
        t('profile.blocked', {
          username: displayUsername,
          defaultValue: '@{{username}} has been blocked',
        }),
        { type: 'success' },
      );
    } catch {
      toast(t('profile.blockFailed', { defaultValue: 'Failed to block user' }), {
        type: 'error',
      });
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

  const label = t('profile.moreOptions', {
    username: displayUsername,
    defaultValue: 'Options for @{{username}}',
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild label={label}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent label={label}>
        {leadingItems}
        {canUsePrivateApi ? (
          <>
            <DropdownMenuItem
              leading={<ListIcon size={22} className="text-foreground" />}
              onPress={handleAddToList}
            >
              {t('lists.addTo.menuItem', { defaultValue: 'Add/remove from lists' })}
            </DropdownMenuItem>
            <DropdownMenuItem
              leading={<StarterPackIcon size={22} className="text-foreground" />}
              onPress={handleAddToStarterPack}
            >
              {t('starterPacks.addTo.menuItem', {
                defaultValue: 'Add/remove from starter packs',
              })}
            </DropdownMenuItem>
            {viewerOperatesAccount ? null : (
              <>
                <DropdownMenuItem
                  leading={<MuteIcon size={22} className="text-foreground" />}
                  onPress={handleMute}
                >
                  {t('profile.muteUser', {
                    username: displayUsername,
                    defaultValue: 'Mute @{{username}}',
                  })}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  leading={<BlockIcon size={22} color={theme.colors.error} />}
                  onPress={handleBlock}
                >
                  {t('profile.blockUser', {
                    username: displayUsername,
                    defaultValue: 'Block @{{username}}',
                  })}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  leading={<ReportIcon size={22} color={theme.colors.error} />}
                  onPress={handleReport}
                >
                  {t('profile.reportUser', { defaultValue: 'Report' })}
                </DropdownMenuItem>
              </>
            )}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
