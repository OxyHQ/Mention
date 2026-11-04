import { LazyOperatedAccountSettingsScreen } from '@/components/sharedRouteScreens';
import { useRoutedProfileUsername } from '@/components/Profile/hooks/useRoutedProfileUsername';

/**
 * A CHANNEL's settings, for its operators. The screen is shared with a
 * community's (`/@<handle>/settings`); see `OperatedAccountSettingsScreen`.
 */
export default function ChannelSettingsRoute() {
  const handle = useRoutedProfileUsername();
  return <LazyOperatedAccountSettingsScreen kind="channel" handle={handle} />;
}
