import { OperatedAccountSettingsScreen } from '@/components/OperatedAccounts/OperatedAccountSettingsScreen';
import { useRoutedProfileUsername } from '@/components/Profile/hooks/useRoutedProfileUsername';
import { CommunitiesPreviewGate } from '@/hooks/useCommunitiesPreview';

/**
 * A COMMUNITY's settings, for its moderators. A community is a person-family
 * page (`/@<handle>`), so its settings live under that family; the screen is
 * shared with a channel's (`/c/<handle>/settings`), see
 * `OperatedAccountSettingsScreen`. Any other account here gets the screen's
 * operator-only answer.
 */
function CommunitySettingsScreen() {
  const handle = useRoutedProfileUsername();
  return <OperatedAccountSettingsScreen kind="community" handle={handle} />;
}

export default function CommunitySettingsRoute() {
  return (
    <CommunitiesPreviewGate>
      <CommunitySettingsScreen />
    </CommunitiesPreviewGate>
  );
}
