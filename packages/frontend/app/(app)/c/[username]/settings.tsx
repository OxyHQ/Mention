import { OperatedAccountSettingsScreen } from '@/components/OperatedAccounts/OperatedAccountSettingsScreen';
import { useRoutedProfileUsername } from '@/components/Profile/hooks/useRoutedProfileUsername';

/**
 * A CHANNEL's settings, for its operators. The screen is shared with a
 * community's (`/@<handle>/settings`); see `OperatedAccountSettingsScreen`.
 */
export default function ChannelSettingsRoute() {
  const handle = useRoutedProfileUsername();
  return <OperatedAccountSettingsScreen kind="channel" handle={handle} />;
}
